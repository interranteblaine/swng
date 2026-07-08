import { settleRound } from "@swng/domain";
import type { FinalizeRoundResponse } from "@swng/contracts";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { RoundStore } from "../ports/roundStore.js";
import type { ParticipantClaims } from "../ports/tokenIssuer.js";
import { requireParticipant } from "../scoringPolicy.js";
import { loadRoundState } from "./loadRoundState.js";
import { serverEnvelope } from "./serverEnvelope.js";

// Finalize is idempotent by design (architecture.md §3: "projections treat finalize as an
// idempotent upsert"): a round that's already final just recomputes and returns — never a
// second round-finalized event, never a second archive write.
//
// Accepted race (v1): a RecordScore already in flight when this runs can append its
// score-recorded event to the journal AFTER this function's round-finalized append lands.
// `fullLog` below (read post-append) would then include that late score, so the archive
// this call writes can include a cell the *next* archive-consuming reader — reading events
// only up to round-finalized — wouldn't see. This is accepted for v1 because settlement is
// idempotent and putArchive upserts (see EventJournal port doc): a reopen-and-refinalize
// heals it by recomputing from the full log again. Closing the window for real needs a
// head-seq condition on the finalize append itself (e.g. "only append round-finalized if
// head seq still matches what loadRoundState saw") — an M4/M9 candidate, not v1 scope.
export const finalizeRound =
  (deps: { journal: EventJournal; store: RoundStore; broadcast: Broadcast; clock: Clock; ids: IdGenerator }) =>
  async (claims: ParticipantClaims): Promise<FinalizeRoundResponse> => {
    const { events, state } = await loadRoundState(deps.journal, claims.roundId);
    requireParticipant(state, claims.golferId);

    if (state.status === "final") {
      const archive = settleRound(events);
      return { results: archive.results, handicapping: archive.handicapping };
    }

    const result = await deps.journal.append(claims.roundId, [{ kind: "round-finalized", ...serverEnvelope(deps, claims.golferId) }]);
    const fullLog = await deps.journal.read(claims.roundId, 0); // the FULL post-append log
    const archive = settleRound(fullLog);
    await deps.store.putArchive(archive);
    await deps.broadcast.publish(claims.roundId, result.appended);

    return { results: archive.results, handicapping: archive.handicapping };
  };
