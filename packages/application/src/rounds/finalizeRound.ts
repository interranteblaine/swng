import { settleRound } from "@swng/domain";
import type { RoundEvent } from "@swng/domain";
import type { FinalizeRoundResponse } from "@swng/contracts";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { RoundStore } from "../ports/roundStore.js";
import type { ParticipantClaims } from "../ports/tokenIssuer.js";
import { requireParticipant } from "../scoringPolicy.js";
import { loadRoundState } from "./loadRoundState.js";
import { createServerHlcSource, serverEnvelope } from "./serverEnvelope.js";

// A seq race (RecordScore landing between this call's settle-check read and its conditional
// append, see "Head-seq conditional append" below) costs one round-trip; this bounds the
// retry loop the same way createDynamoEventJournal's MAX_APPEND_ATTEMPTS bounds ITS seq-race
// retry, so a pathological hot round fails loudly instead of spinning forever.
const MAX_FINALIZE_ATTEMPTS = 5;

// Finalize is idempotent by design (architecture.md §3: "projections treat finalize as an
// idempotent upsert"): a round that's already final just recomputes and returns — never a
// second round-finalized event, never a second archive write.
//
// Settle-before-append (carry 1): settleRound is run against the CANDIDATE log (current
// events + the not-yet-appended round-finalized) BEFORE anything touches the journal. If a
// configured game hasn't resolved, settleRound throws game-unresolved right here — no
// round-finalized event is ever appended, so the round stays "live" and a later finalize
// (once the game resolves) can still succeed. The prior version appended round-finalized
// FIRST and settled after: a game-unresolved throw there left the round permanently wedged
// final-but-unsettleable, since every retry re-threw against the same unresolvable log.
//
// Head-seq conditional append (carry 2): the settle-check above reads the log once, but a
// RecordScore can land in the gap between that read and this function's own append. Without
// a condition, the append would blindly land round-finalized after whatever's now at the
// head — including an event the settle-check never validated against. `expectedHeadSeq`
// (EventJournal port) makes the append itself fail (`headSeqConflict`) if the head has moved,
// forcing a full re-read + re-validate below (bounded by MAX_FINALIZE_ATTEMPTS) instead of
// trusting a stale settle-check.
//
// Still-accepted race (v1, unchanged): once round-finalized's append itself has landed, a
// RecordScore racing that exact instant can still append its score-recorded AFTER it — the
// `fullLog` re-read below (post-append) picks that late score up, so the archive THIS call
// writes can include a cell a different reader (one that stopped at round-finalized)
// wouldn't. Accepted because settlement is idempotent and putArchive upserts (EventJournal
// port doc): a reopen-and-refinalize heals it by recomputing from the full log again.
export const finalizeRound =
  (deps: { journal: EventJournal; store: RoundStore; broadcast: Broadcast; clock: Clock; ids: IdGenerator }) =>
  async (claims: ParticipantClaims): Promise<FinalizeRoundResponse> => {
    for (let attempt = 0; attempt < MAX_FINALIZE_ATTEMPTS; attempt += 1) {
      const { events, state } = await loadRoundState(deps.journal, claims.roundId);
      requireParticipant(state, claims.golferId);

      if (state.status === "final") {
        const archive = settleRound(events);
        return { results: archive.results, handicapping: archive.handicapping };
      }

      const hlc = createServerHlcSource(deps.clock);
      const candidate: RoundEvent = { kind: "round-finalized", ...serverEnvelope({ hlc, ids: deps.ids }, claims.golferId) };

      // Validate settle-ability against the candidate log BEFORE ever touching the journal
      // (carry 1) — a game-unresolved throw here propagates uncaught, same idiom as every
      // other domain validation in this package, and leaves the journal untouched.
      settleRound([...events, candidate]);

      const expectedHeadSeq = events[events.length - 1]?.seq ?? 0;
      const result = await deps.journal.append(claims.roundId, [candidate], { expectedHeadSeq });

      if (result.headSeqConflict) {
        // Something landed after the seq this attempt validated against (carry 2) — re-read
        // and re-validate from scratch on the next loop iteration rather than trust the
        // now-stale settle-check above.
        continue;
      }

      const fullLog = await deps.journal.read(claims.roundId, 0); // the FULL post-append log
      const archive = settleRound(fullLog);
      await deps.store.putArchive(archive);
      await deps.broadcast.publish(claims.roundId, result.appended);

      return { results: archive.results, handicapping: archive.handicapping };
    }

    throw new Error(`finalizeRound: did not converge after ${MAX_FINALIZE_ATTEMPTS} attempts (round ${claims.roundId})`);
  };
