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
