import type { RoundEvent } from "@swng/domain";
import type { AbandonRoundResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { Logger } from "../ports/logger.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import type { ParticipantClaims } from "../ports/tokenIssuer.js";
import { requireParticipant } from "../scoringPolicy.js";
import { loadRoundState } from "./loadRoundState.js";
import { createServerHlcSource, serverEnvelope } from "./serverEnvelope.js";

// A seq race (finalizeRound committing round-finalized + its snapshot atomically between this
// call's own load and its append, see the head-seq comment below) costs one round-trip; this
// bounds the retry loop the same way finalizeRound.ts's own MAX_FINALIZE_ATTEMPTS bounds ITS
// seq-race retry, so a pathological hot round fails loudly instead of spinning forever.
const MAX_ABANDON_ATTEMPTS = 5;

// Scrapping a round (task-15): round-abandoned is a TERMINAL event that produces NO snapshot, so
// the round counts nowhere — emphatically NOT "mark holes picked-up and finalize." Any
// participant may abandon (matches finalize/terminate's own rule — no extra authorization beyond
// requireParticipant); it's a connected, online act, so it's a plain HTTP command like
// finalize/terminate, server-envelope-stamped the same way.
export const abandonRound =
  (deps: { journal: EventJournal; broadcast: Broadcast; clock: Clock; ids: IdGenerator; projectionStore: ProjectionStore; logger: Logger }) =>
  async (claims: ParticipantClaims): Promise<AbandonRoundResponse> => {
    for (let attempt = 0; attempt < MAX_ABANDON_ATTEMPTS; attempt += 1) {
      const { events, state } = await loadRoundState(deps.journal, claims.roundId);
      requireParticipant(state, claims.golferId);

      // A final round is already settled and counts — scrapping it now would strand a snapshot
      // that already committed. 409 round-final, the same "wrong lifecycle state for this act"
      // bucket addGame/joinRound already use.
      if (state.status === "final") throw new ApplicationError("round-final");

      // Idempotent (matches finalizeRound's own idempotent branch + terminateGame's no-op
      // spirit): abandoning an already-abandoned round appends NO second event and just reports
      // success. The presence deletes below already ran on the abandon that actually landed, so
      // this returns before them too.
      if (state.status === "abandoned") return { status: "abandoned" };

      // Head-seq conditional append (task-15 fix, mirrors finalizeRound.ts's own "Head-seq
      // conditional append" carry): abandon being DOMINANT in the fold (domain state.ts) means a
      // score/game racing in alongside it is harmless — the round still folds to abandoned either
      // way. But a FINALIZE racing in is not harmless: finalizeRound commits round-finalized and
      // its settled snapshot in ONE transaction, so if that transaction lands between this call's
      // load above and its append below, an unconditional append would still land round-abandoned
      // afterward — the fold says abandoned (dominant), but the finalize's snapshot already
      // committed and already projected, stranding it: exactly the invariant this use case exists
      // to prevent, just via the append instead of the read. `expectedHeadSeq` makes the append
      // itself fail (`headSeqConflict`) if the head has moved since this attempt's own load,
      // forcing the loop below to re-read rather than blindly append after a finalize it never
      // saw. This is what makes "no snapshot for an abandoned round" structural: a finalize that
      // won the race is now visible on re-read (state.status === "final" above) and abandon is
      // refused; a finalize that LOST the race fails its OWN condition and its settle-check then
      // throws round-abandoned (settleRound sees the dominant abandon in its candidate log) —
      // neither ordering can ever produce a final-but-abandoned or abandoned-with-a-snapshot round.
      const hlc = createServerHlcSource(deps.clock);
      const abandoned: RoundEvent = { kind: "round-abandoned", ...serverEnvelope({ hlc, ids: deps.ids }, claims.golferId) };
      const expectedHeadSeq = events[events.length - 1]?.seq ?? 0;
      const result = await deps.journal.append(claims.roundId, [abandoned], { expectedHeadSeq });

      if (result.headSeqConflict) {
        // Something landed after the seq this attempt validated against — re-read on the next
        // iteration so the final/abandoned checks above see the log as it actually is now,
        // rather than retrying blind against a head this attempt never validated.
        continue;
      }

      // Presence cleanup, best-effort per participant (rounds/presence.ts's own swallow-and-log
      // discipline): NO snapshot is ever written for an abandoned round, so the projector — which
      // runs the finalize-time deleteLive loop — never fires for this round. This use case is
      // therefore the ONLY thing that clears the LIVE#<roundId> pointers a scrapped round would
      // otherwise leave live under each participant's identity until their 36h TTL. A failed
      // delete must never fail the abandon (already committed above) — warn and move on, exactly
      // as writePresence does on the seat-time write.
      for (const participant of state.participants) {
        try {
          await deps.projectionStore.deleteLive(participant.golferId, claims.roundId);
        } catch (error) {
          deps.logger.warn("abandon-presence-delete-failed", {
            golferId: participant.golferId,
            roundId: claims.roundId,
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
          });
        }
      }

      await deps.broadcast.publish(claims.roundId, result.appended);
      return { status: "abandoned" };
    }

    throw new Error(`abandonRound: did not converge after ${MAX_ABANDON_ATTEMPTS} attempts (round ${claims.roundId})`);
  };
