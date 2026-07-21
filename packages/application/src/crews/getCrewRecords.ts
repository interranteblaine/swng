import { aggregateSeason, partnerRecords, stablefordTitle } from "@swng/domain";
import type { CrewId, RoundArchive, RoundId } from "@swng/domain";
import type { CrewRecordsResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { SnapshotStore } from "../ports/snapshotStore.js";
import { rosterFilteredContribution } from "./getSeasonStandings.js";
import { requireCrewMember } from "./membership.js";

// GET /crews/{crewId}/records (analytics spec 2026-07-21 §5): all-time — every counted round
// across EVERY season, deduped by roundId (the SAME round counted into two seasons of this crew
// contributes once, fetched once via ONE snapshots.getMany), folded through the exact
// roster-filter + aggregateSeason composition getSeasonStandings.ts already runs
// (rosterFilteredContribution — one implementation, never a second), plus partner records and
// each CLOSED season's Stableford title.
export const getCrewRecords =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; snapshots: SnapshotStore }) =>
  async (claims: AccountClaims, id: CrewId): Promise<CrewRecordsResponse> => {
    const { crew } = await requireCrewMember(deps, claims, id);
    const memberIds = new Set(crew.members.map((member) => member.golferId));
    const nameByGolfer = new Map(crew.members.map((member) => [member.golferId, member.name]));

    // listSeasons/listCountedRounds make no order promise (their own port docs) — newest-first
    // by createdAtMs, the same order listSeasons.ts itself imposes, so `titles` below reads
    // deterministically.
    const seasons = [...(await deps.crewStore.listSeasons(id))].sort(
      (a, b) => b.createdAtMs - a.createdAtMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    const countedBySeason = await Promise.all(
      seasons.map(async (season) => ({ season, counted: await deps.crewStore.listCountedRounds(id, season.seasonId) })),
    );

    // Dedupe by roundId — the SAME round counted into two seasons of this crew is fetched once,
    // counted once.
    const roundIds = new Set<RoundId>();
    for (const { counted } of countedBySeason) for (const entry of counted) roundIds.add(entry.roundId);
    const archives = await deps.snapshots.getMany([...roundIds]);
    const archiveByRoundId = new Map(archives.map((archive) => [archive.roundId, archive]));

    const memberOnlyContributions = archives.map((archive) => rosterFilteredContribution(archive, memberIds));
    const { ledger, headToHead } = aggregateSeason(memberOnlyContributions);
    const partners = partnerRecords(archives, memberIds).map((pair) => ({
      ...pair,
      nameA: nameByGolfer.get(pair.a) ?? pair.a,
      nameB: nameByGolfer.get(pair.b) ?? pair.b,
    }));

    // Titles: each CLOSED season's Stableford points leader(s) under the CURRENT roster filter —
    // an open season, or a closed one whose roster-filtered ledger is empty/scoreless, contributes
    // no entry (stablefordTitle's own [] rule). A title list reads as a timeline, not a feed —
    // built oldest-first (spec §5's own example order: "Bo '24 · Al '25"), the REVERSE of
    // `countedBySeason`'s newest-first order above (which stays newest-first for its other use,
    // deduping roundIds — whole-branch review, 2026-07-21, Finding 3).
    const chronological = [...countedBySeason].sort(
      (a, b) => a.season.createdAtMs - b.season.createdAtMs || (a.season.name < b.season.name ? -1 : a.season.name > b.season.name ? 1 : 0),
    );
    const titles: CrewRecordsResponse["titles"][number][] = [];
    for (const { season, counted } of chronological) {
      if (season.status !== "closed") continue;
      const seasonArchives = counted
        .map((entry) => archiveByRoundId.get(entry.roundId))
        .filter((archive): archive is RoundArchive => archive !== undefined);
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
      rounds: roundIds.size,
      ledger: ledger.map((line) => ({ ...line, name: nameByGolfer.get(line.golferId) ?? line.golferId })),
      headToHead,
      partners,
      titles,
    };
  };
