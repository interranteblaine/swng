import { aggregateSeason, crewContribution } from "@swng/domain";
import type { CrewId, GolferId } from "@swng/domain";
import type { CountedRoundView, SeasonStandingsResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { SnapshotStore } from "../ports/snapshotStore.js";
import { requireCrewMember } from "./membership.js";

// GET /crews/{crewId}/seasons/{seasonId}/standings (architecture-realignment Task 9): standings
// are COMPUTED ON READ (spec §4) — there is no stored ledger. The season's counted snapshots
// are folded through the SAME domain crewContribution/aggregateSeason the M8 projector used, in
// the call, so scoring math is never re-derived and the crew projection layer that used to
// precompute this is gone.
//
// Names resolve from the counted snapshots' OWN participants, most-recently-finalized wins a
// conflict (task-9 binding resolution): writing names in ascending finalizedAt order lets the
// latest snapshot's spelling of a golfer's name overwrite earlier ones. `member` comes from the
// CURRENT roster — a departed or guest golfer aggregates as recorded but shows member:false;
// standings never depend on membership history.
export const getSeasonStandings =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; snapshots: SnapshotStore }) =>
  async (claims: AccountClaims, id: CrewId, seasonId: string): Promise<SeasonStandingsResponse> => {
    const { crew } = await requireCrewMember(deps, claims, id);

    const season = await deps.crewStore.getSeason(id, seasonId);
    if (!season) throw new ApplicationError("season-not-found");

    const counted = await deps.crewStore.listCountedRounds(id, seasonId);
    // getMany omits absent ids and promises no order (its own port doc); pair each returned
    // archive back to its counted entry's finalizedAtMs by roundId — the authoritative "when"
    // for both the name-recency sort and the rounds list below.
    const archives = await deps.snapshots.getMany(counted.map((entry) => entry.roundId));
    const finalizedAtByRound = new Map(counted.map((entry) => [entry.roundId, entry.finalizedAtMs]));

    const { ledger, headToHead } = aggregateSeason(archives.map((archive) => crewContribution(archive)));

    // Ascending finalizedAt so the most recently finalized snapshot's name wins (its write lands
    // last).
    const nameByGolfer = new Map<GolferId, string>();
    for (const archive of [...archives].sort((a, b) => (finalizedAtByRound.get(a.roundId) ?? 0) - (finalizedAtByRound.get(b.roundId) ?? 0))) {
      for (const participant of archive.participants) nameByGolfer.set(participant.golferId, participant.name);
    }
    const memberIds = new Set(crew.members.map((member) => member.golferId));

    const rounds: readonly CountedRoundView[] = [...counted]
      .sort((a, b) => b.finalizedAtMs - a.finalizedAtMs) // newest-first
      .map((entry) => ({ roundId: entry.roundId, finalizedAt: entry.finalizedAtMs, appendedBy: entry.appendedBy }));

    return {
      seasonId: season.seasonId,
      name: season.name,
      status: season.status,
      rounds,
      ledger: ledger.map((line) => ({ ...line, name: nameByGolfer.get(line.golferId) ?? line.golferId, member: memberIds.has(line.golferId) })),
      headToHead,
    };
  };
