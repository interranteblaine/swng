import { aggregateSeason, partnerRecords, sharedRoundIds, stablefordTitle } from "@swng/domain";
import type { CrewId, RoundArchive, RoundId } from "@swng/domain";
import type { CrewRecordsResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import type { SnapshotStore } from "../ports/snapshotStore.js";
import { sortLines } from "../projections/projectArchive.js";
import { rosterFilteredContribution } from "./getSeasonStandings.js";
import { requireCrewMember } from "./membership.js";

// GET /crews/{crewId}/records (crew-scoreboard spec §3b): all-time — every round the roster ever
// shared, derived the SAME way getSeasonStandings.ts derives one season's (sharedRoundIds over an
// open-ended window, `{ startMs: 0 }`), fetched once via ONE snapshots.getMany, folded through the
// exact roster-filter + aggregateSeason composition getSeasonStandings.ts already runs
// (rosterFilteredContribution — one implementation, never a second), plus partner records and
// each CLOSED season's Stableford title.
export const getCrewRecords =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; snapshots: SnapshotStore; projectionStore: ProjectionStore }) =>
  async (claims: AccountClaims, id: CrewId): Promise<CrewRecordsResponse> => {
    const { crew } = await requireCrewMember(deps, claims, id);
    const memberIds = new Set(crew.members.map((member) => member.golferId));
    const nameByGolfer = new Map(crew.members.map((member) => [member.golferId, member.name]));

    // ONE listLines per roster member (Promise.all) — the same fetch getSeasonStandings.ts
    // performs, feeding both the all-time shared-round derivation and every CLOSED season's own
    // window below (no second fetch per season).
    const members = await Promise.all(
      crew.members.map(async (member) => ({
        golferId: member.golferId,
        lines: sortLines(await deps.projectionStore.listLines(member.golferId)),
      })),
    );

    // All-time = every round the CURRENT roster ever shared, no window (startMs: 0 — the epoch,
    // so no round can ever fall outside it).
    const sharedEver = sharedRoundIds(members, { startMs: 0 });
    const archives = await deps.snapshots.getMany([...sharedEver]);
    const archiveByRoundId = new Map(archives.map((archive) => [archive.roundId, archive]));

    const memberOnlyContributions = archives.map((archive) => rosterFilteredContribution(archive, memberIds));
    const { ledger, headToHead } = aggregateSeason(memberOnlyContributions);
    const partners = partnerRecords(archives, memberIds).map((pair) => ({
      ...pair,
      nameA: nameByGolfer.get(pair.a) ?? pair.a,
      nameB: nameByGolfer.get(pair.b) ?? pair.b,
    }));

    // Titles: each CLOSED season's Stableford points leader(s), each over the shared rounds of
    // THAT season's own window — a legacy closed season (closed before this arc) has no
    // closedAtMs, so its window reads as open-ended rather than crashing (the conditional spread
    // below). listSeasons makes no order promise (its own port doc) — sorted oldest-first here so
    // `titles` reads as a timeline (spec §5's own example order: "Bo '24 · Al '25").
    const chronological = [...(await deps.crewStore.listSeasons(id))].sort(
      (a, b) => a.createdAtMs - b.createdAtMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    const titles: CrewRecordsResponse["titles"][number][] = [];
    for (const season of chronological) {
      if (season.status !== "closed") continue;
      const window = { startMs: season.startsAtMs, ...(season.closedAtMs !== undefined ? { endMs: season.closedAtMs } : {}) };
      const seasonRoundIds: readonly RoundId[] = sharedRoundIds(members, window);
      const seasonArchives = seasonRoundIds.map((roundId) => archiveByRoundId.get(roundId)).filter((archive): archive is RoundArchive => archive !== undefined);
      const seasonLedger = aggregateSeason(seasonArchives.map((archive) => rosterFilteredContribution(archive, memberIds))).ledger;
      const winners = stablefordTitle(seasonLedger);
      if (winners.length === 0) continue;
      titles.push({
        seasonId: season.seasonId,
        name: season.name,
        golfers: winners.map((golferId) => ({ golferId, name: nameByGolfer.get(golferId) ?? golferId })),
      });
    }

    return {
      rounds: sharedEver.length,
      ledger: ledger.map((line) => ({ ...line, name: nameByGolfer.get(line.golferId) ?? line.golferId })),
      headToHead,
      partners,
      titles,
    };
  };
