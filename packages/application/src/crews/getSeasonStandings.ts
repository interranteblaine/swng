import { aggregateSeason, crewContribution, golferMetrics, mostImproved, netAverages, partnerRecords } from "@swng/domain";
import type { CrewId, CrewRoundContribution, GolferId, RoundArchive } from "@swng/domain";
import type { CountedRoundView, SeasonStandingsResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import type { SnapshotStore } from "../ports/snapshotStore.js";
import { sortLines } from "../projections/projectArchive.js";
import { requireCrewMember } from "./membership.js";

// The members-only filter (spec §11a) applied BEFORE crewContribution's own fold — shared by
// getSeasonStandings (season-scoped) AND getCrewRecords.ts (all-time + per-season titles) so the
// "current roster only" rule is never re-derived a second time.
export const rosterFilteredContribution = (archive: RoundArchive, memberIds: ReadonlySet<GolferId>): CrewRoundContribution => {
  const contribution = crewContribution(archive);
  return {
    ...contribution,
    lines: contribution.lines.filter((line) => memberIds.has(line.golferId)),
    headToHead: contribution.headToHead.filter((h2h) => memberIds.has(h2h.a) && memberIds.has(h2h.b)),
  };
};

// GET /crews/{crewId}/seasons/{seasonId}/standings (architecture-realignment Task 9): standings
// are COMPUTED ON READ (spec §4) — there is no stored ledger. The season's counted snapshots
// are folded through the SAME domain crewContribution/aggregateSeason the M8 projector used, in
// the call, so scoring math is never re-derived and the crew projection layer that used to
// precompute this is gone.
//
// A crew is a grouping/competition ONLY (owner ruling, spec §11a, 2026-07-13): standings
// aggregate the CURRENT roster only. Each contribution's `lines`/`headToHead` are filtered to
// golferIds on the roster BEFORE the fold — a departed member or a guest who was never on the
// roster contributes NO row and no head-to-head pair; nothing is stored, so re-adding a member
// restores their rows on the very next read (compute-on-read reversibility). Names come from
// the roster's own `CrewMember.name` — never the snapshot's, which can drift from what the crew
// actually calls someone (e.g. a nickname on the roster vs. whatever name a round happened to
// carry).
export const getSeasonStandings =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; snapshots: SnapshotStore; projectionStore: ProjectionStore }) =>
  async (claims: AccountClaims, id: CrewId, seasonId: string): Promise<SeasonStandingsResponse> => {
    const { crew } = await requireCrewMember(deps, claims, id);

    const season = await deps.crewStore.getSeason(id, seasonId);
    if (!season) throw new ApplicationError("season-not-found");

    const counted = await deps.crewStore.listCountedRounds(id, seasonId);
    // getMany omits absent ids and promises no order (its own port doc); pair each returned
    // archive back to its counted entry's finalizedAtMs by roundId for the rounds list below.
    const archives = await deps.snapshots.getMany(counted.map((entry) => entry.roundId));

    const memberIds = new Set(crew.members.map((member) => member.golferId));
    const nameByGolfer = new Map(crew.members.map((member) => [member.golferId, member.name]));

    // Members-only filter BEFORE the fold: a non-member golfer's own line vanishes, and a
    // head-to-head pair survives only when BOTH sides are current members — never a
    // half-resolved pair naming someone who isn't on the roster.
    const memberOnlyContributions = archives.map((archive) => rosterFilteredContribution(archive, memberIds));

    const { ledger, headToHead } = aggregateSeason(memberOnlyContributions);

    const rounds: readonly CountedRoundView[] = [...counted]
      .sort((a, b) => b.finalizedAtMs - a.finalizedAtMs) // newest-first
      .map((entry) => ({ roundId: entry.roundId, finalizedAt: entry.finalizedAtMs, appendedBy: entry.appendedBy }));

    // Partner records (analytics spec §5): four-ball pairs over the SAME archives/memberIds
    // already in scope, names resolved the same way ledger lines are.
    const partners = partnerRecords(archives, memberIds).map((pair) => ({
      ...pair,
      nameA: nameByGolfer.get(pair.a) ?? pair.a,
      nameB: nameByGolfer.get(pair.b) ?? pair.b,
    }));

    // Lowest net average superlative: netAverages already sorts ascending by average (ties broken
    // by golferId), so the lowest is always at index 0 — gather every entry tied at that exact
    // value (a real tie, since averages are already rounded to one decimal by the domain fold).
    const nets = netAverages(archives, memberIds);
    const lowestNet =
      nets.length > 0
        ? (() => {
            const best = nets[0]!;
            const tied = nets.filter((entry) => entry.average === best.average);
            return {
              holes: best.holes,
              average: best.average,
              rounds: best.rounds,
              golfers: tied.map((entry) => ({ golferId: entry.golferId, name: nameByGolfer.get(entry.golferId) ?? entry.golferId })),
            };
          })()
        : undefined;

    // Most improved (spec §5): skip both boundary fetches and omit the superlative entirely when
    // the season counts no rounds at all — there is no "first"/"last" to bound by. One
    // listLines query per roster member (Promise.all), never sequential.
    let mostImprovedResult: SeasonStandingsResponse["superlatives"]["mostImproved"];
    if (counted.length > 0) {
      const firstMs = Math.min(...counted.map((entry) => entry.finalizedAtMs));
      const lastMs = Math.max(...counted.map((entry) => entry.finalizedAtMs));
      const boundaryEntries = await Promise.all(
        crew.members.map(async (member) => {
          const lines = sortLines(await deps.projectionStore.listLines(member.golferId));
          return {
            golferId: member.golferId,
            from: golferMetrics(lines.filter((line) => line.finalizedAtMs <= firstMs)).swngIndex?.value,
            to: golferMetrics(lines.filter((line) => line.finalizedAtMs <= lastMs)).swngIndex?.value,
          };
        }),
      );
      const improved = mostImproved(boundaryEntries);
      if (improved.length > 0) {
        mostImprovedResult = improved.map((entry) => ({ ...entry, name: nameByGolfer.get(entry.golferId) ?? entry.golferId }));
      }
    }

    return {
      seasonId: season.seasonId,
      name: season.name,
      status: season.status,
      rounds,
      // Every golferId reaching here is, by construction, a current roster member (the filter
      // above) — nameByGolfer.get is never undefined in practice; the golferId fallback exists
      // only so a hypothetical gap fails soft (a raw id) rather than crashing the response.
      ledger: ledger.map((line) => ({ ...line, name: nameByGolfer.get(line.golferId) ?? line.golferId })),
      headToHead,
      partners,
      superlatives: {
        ...(lowestNet !== undefined ? { lowestNet } : {}),
        ...(mostImprovedResult !== undefined ? { mostImproved: mostImprovedResult } : {}),
      },
    };
  };
