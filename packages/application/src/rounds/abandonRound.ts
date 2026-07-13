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

// Scrapping a round (task-15): round-abandoned is a TERMINAL event that produces NO snapshot, so
// the round counts nowhere — emphatically NOT "mark holes picked-up and finalize." Any
// participant may abandon (matches finalize/terminate's own rule — no extra authorization beyond
// requireParticipant); it's a connected, online act, so it's a plain HTTP command like
// finalize/terminate, server-envelope-stamped the same way.
export const abandonRound =
  (deps: { journal: EventJournal; broadcast: Broadcast; clock: Clock; ids: IdGenerator; projectionStore: ProjectionStore; logger: Logger }) =>
  async (claims: ParticipantClaims): Promise<AbandonRoundResponse> => {
    const { state } = await loadRoundState(deps.journal, claims.roundId);
    requireParticipant(state, claims.golferId);

    // A final round is already settled and counts — scrapping it now would strand a snapshot that
    // already committed. 409 round-final, the same "wrong lifecycle state for this act" bucket
    // addGame/joinRound already use.
    if (state.status === "final") throw new ApplicationError("round-final");

    // Idempotent (matches finalizeRound's own idempotent branch + terminateGame's no-op spirit):
    // abandoning an already-abandoned round appends NO second event and just reports success. The
    // presence deletes below already ran on the first abandon, so this returns before them too.
    if (state.status === "abandoned") return { status: "abandoned" };

    // Plain append — NO head-seq condition (unlike finalize's conditional append). Abandon is
    // terminal and DOMINANT in the fold (domain state.ts: an abandon out-votes any later
    // lifecycle event, even a round-finalized with a higher hlc), so a score/game/finalize racing
    // in alongside it changes nothing about the outcome — the round is scrapped regardless of
    // interleaving, so there is simply no race to guard against here.
    const hlc = createServerHlcSource(deps.clock);
    const abandoned: RoundEvent = { kind: "round-abandoned", ...serverEnvelope({ hlc, ids: deps.ids }, claims.golferId) };
    const result = await deps.journal.append(claims.roundId, [abandoned]);

    // Presence cleanup, best-effort per participant (rounds/presence.ts's own swallow-and-log
    // discipline): NO snapshot is ever written for an abandoned round, so the projector — which
    // runs the finalize-time deleteLive loop — never fires for this round. This use case is
    // therefore the ONLY thing that clears the LIVE#<roundId> pointers a scrapped round would
    // otherwise leave live under each participant's identity until their 36h TTL. A failed delete
    // must never fail the abandon (already committed above) — warn and move on, exactly as
    // writePresence does on the seat-time write.
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
  };
