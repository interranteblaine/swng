import type { CrewId } from "@swng/domain";
import type { AppendCountedRoundRequest, AppendCountedRoundResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { Clock } from "../ports/clock.js";
import type { CountedRound, CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { SnapshotStore } from "../ports/snapshotStore.js";
import { finalizedAtMsOf } from "../projections/projectArchive.js";
import { requireCrewMember } from "./membership.js";

// POST /crews/{crewId}/seasons/{seasonId}/rounds (architecture-realignment Task 9): a member
// counts one of THEIR OWN finished rounds into a season — the crew's own pointer TO a round,
// never a back-reference on the round (round-is-a-sealed-leaf). Guards, in order:
//   member (not-a-member) → season exists (season-not-found) → season open (season-closed) →
//   the round is finished (round-not-found: no snapshot yet, "finish the round first") →
//   the caller actually played it (did-not-play) → not already counted (round-already-counted,
//   the store's own dedupe).
// finalizedAtMs comes from the snapshot's own round-finalized event (finalizedAtMsOf — the ONE
// definition of "when did this round finalize", shared with the projector), never a wall-clock
// read here; appendedAtMs is this append's own moment.
export const appendCountedRound =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; snapshots: SnapshotStore; clock: Clock }) =>
  async (claims: AccountClaims, id: CrewId, seasonId: string, command: AppendCountedRoundRequest): Promise<AppendCountedRoundResponse> => {
    await requireCrewMember(deps, claims, id);
    // getBySub is guaranteed to resolve — requireCrewMember above already established the caller
    // has an account golfer AND is on this crew's roster.
    const account = await deps.golferStore.getBySub(claims.sub);
    const callerGolferId = account!.golfer.id;

    const season = await deps.crewStore.getSeason(id, seasonId);
    if (!season) throw new ApplicationError("season-not-found");
    if (season.status === "closed") throw new ApplicationError("season-closed");

    // The snapshot IS the atom (SnapshotStore's port doc) — its absence means the round never
    // finalized, so there is nothing to count yet.
    const archive = await deps.snapshots.get(command.roundId);
    if (!archive) throw new ApplicationError("round-not-found");
    if (!archive.participants.some((participant) => participant.golferId === callerGolferId)) {
      throw new ApplicationError("did-not-play");
    }

    const entry: CountedRound = {
      roundId: command.roundId,
      finalizedAtMs: finalizedAtMsOf(archive),
      appendedBy: callerGolferId,
      appendedAtMs: deps.clock.now(),
    };
    // Throws round-already-counted (409) if this roundId is already counted in THIS season.
    await deps.crewStore.addCountedRound(id, seasonId, entry);

    return { round: { roundId: entry.roundId, finalizedAt: entry.finalizedAtMs, appendedBy: entry.appendedBy } };
  };
