import { settleRound } from "@swng/domain";
import type { RoundEvent } from "@swng/domain";
import type { FinalizeRoundResponse } from "@swng/contracts";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { Metrics } from "../ports/metrics.js";
import type { SnapshotStore } from "../ports/snapshotStore.js";
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
// idempotent upsert"): a round that's already final just hands back its stored snapshot —
// never a second round-finalized event, never a second snapshot write.
//
// The snapshot IS the atom (projection-realignment spec §2): round-finalized and the settled
// RoundArchive commit in ONE cross-table transaction (journal.append's `snapshot` option), so
// a final log and its snapshot can never diverge. This is what retired the M9 repair-on-replay
// branch: there is no longer a window where round-finalized lands but the archive write fails
// separately, so the idempotent branch below can trust a missing snapshot to mean corruption
// (loud throw) rather than a wedge to heal.
//
// Settle-before-append (carry 1): settleRound runs against the CANDIDATE log (current events +
// the not-yet-appended round-finalized) BEFORE anything touches the journal. If a configured
// game hasn't resolved, settleRound throws game-unresolved right here — no round-finalized
// event is ever appended, so the round stays "live" and a later finalize (once the game
// resolves) can still succeed. The archive settleRound returns here is ALSO the exact snapshot
// committed with the append: one settlement, validated and stored, no second computation.
//
// Head-seq conditional append (carry 2): the settle-check reads the log once, but a
// RecordScore can land in the gap between that read and this function's append. `expectedHeadSeq`
// (EventJournal port) makes the append itself fail (`headSeqConflict`) if the head has moved,
// forcing a full re-read + re-settle below (bounded by MAX_FINALIZE_ATTEMPTS) so the snapshot
// that finally commits is settled from the log AS IT ACTUALLY IS at commit — never a stale one
// computed from a candidate log that a late score already invalidated. The post-append re-read
// the prior version did is gone: the head-seq condition guarantees the committed log is exactly
// the candidate log this attempt settled, so the archive is exact, not racy.
export const finalizeRound =
  (deps: { journal: EventJournal; snapshots: SnapshotStore; broadcast: Broadcast; clock: Clock; ids: IdGenerator; metrics?: Metrics }) =>
  async (claims: ParticipantClaims): Promise<FinalizeRoundResponse> => {
    for (let attempt = 0; attempt < MAX_FINALIZE_ATTEMPTS; attempt += 1) {
      const { events, state } = await loadRoundState(deps.journal, claims.roundId);
      requireParticipant(state, claims.golferId);

      if (state.status === "final") {
        // The round already finalized — its snapshot committed atomically with round-finalized,
        // so it MUST be present. A missing snapshot under a final log is corruption (the atom's
        // two legs can't land apart), never a wedge to recompute away: throw loudly instead of
        // silently re-settling a log a different reader might settle differently.
        const archived = await deps.snapshots.get(claims.roundId);
        if (!archived) throw new Error(`finalizeRound: round ${claims.roundId} is final but has no snapshot — corrupt`);
        return { results: archived.results };
      }

      const hlc = createServerHlcSource(deps.clock);
      const candidate: RoundEvent = { kind: "round-finalized", ...serverEnvelope({ hlc, ids: deps.ids }, claims.golferId) };

      // Settle the CANDIDATE log (carry 1) — this both VALIDATES settle-ability (a
      // game-unresolved throw here propagates uncaught, leaving the journal untouched) AND
      // produces the exact archive committed with the append below. task-15: this same
      // settle-check is what refuses a SCRAPPED round — no explicit "abandoned" guard is needed
      // here because an abandon DOMINATES the fold (domain state.ts), so this candidate log
      // (existing events + the round-finalized above) still folds to "abandoned" and settleRound
      // throws round-abandoned (409) before the journal is ever touched.
      const candidateLog = [...events, candidate];
      const archive = settleRound(candidateLog);

      const expectedHeadSeq = events[events.length - 1]?.seq ?? 0;
      // One cross-table transaction: round-finalized's EVT/OPID slots plus the snapshot's item.
      const result = await deps.journal.append(claims.roundId, [candidate], { expectedHeadSeq, snapshot: archive });

      if (result.headSeqConflict) {
        // Something landed after the seq this attempt validated against (carry 2) — re-read and
        // re-settle from scratch on the next iteration so the snapshot reflects the new log,
        // rather than committing an archive built from a now-stale candidate.
        continue;
      }

      await deps.broadcast.publish(claims.roundId, result.appended);
      deps.metrics?.count("RoundsFinalized");
      return { results: archive.results };
    }

    throw new Error(`finalizeRound: did not converge after ${MAX_FINALIZE_ATTEMPTS} attempts (round ${claims.roundId})`);
  };
