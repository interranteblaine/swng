import { aggregateSeason, crewContribution, crewScoreboard, partnerRecords, seasonWindowOf, sharedRoundIds } from "@swng/domain";
import type { CrewId, CrewRoundContribution, GolferId, RoundArchive, RoundId, StoredLine } from "@swng/domain";
import type { SeasonStandingsResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import type { SnapshotStore } from "../ports/snapshotStore.js";
import { sortLines } from "../projections/projectArchive.js";
import { requireCrewMember } from "./membership.js";

// The members-only filter (spec §11a) applied BEFORE crewContribution's own fold. (The now-deleted
// getCrewRecords.ts used to share this too, spec 2026-07-22 §4 — a season's own wide-dated window
// replaces the all-time surface, so this is getSeasonStandings' alone again.)
export const rosterFilteredContribution = (archive: RoundArchive, memberIds: ReadonlySet<GolferId>): CrewRoundContribution => {
  const contribution = crewContribution(archive);
  return {
    ...contribution,
    lines: contribution.lines.filter((line) => memberIds.has(line.golferId)),
    headToHead: contribution.headToHead.filter((h2h) => memberIds.has(h2h.a) && memberIds.has(h2h.b)),
  };
};

// GET /crews/{crewId}/seasons/{seasonId}/standings (crew-scoreboard spec §3/§4): a season is a
// time WINDOW now, not a stored list of counted rounds — everything below is derived on read
// from each roster member's OWN golfer projection lines (ONE listLines fetch per member) plus
// the snapshots those "we played together" facts point at. There is no per-round act any member
// performs for the crew, ever (spec §1: "the crew watches; members just play").
//
// A crew is a grouping/competition ONLY (owner ruling, spec §11a, 2026-07-13): standings
// aggregate the CURRENT roster only. Each together-record contribution's `lines`/`headToHead`
// are filtered to golferIds on the roster BEFORE the fold — a departed member or a guest who was
// never on the roster contributes NO row and no head-to-head pair; nothing is stored, so
// re-adding a member restores their rows on the very next read (compute-on-read reversibility).
// Names come from the roster's own `CrewMember.name` — never the snapshot's, which can drift from
// what the crew actually calls someone (e.g. a nickname on the roster vs. whatever name a round
// happened to carry).
export const getSeasonStandings =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; snapshots: SnapshotStore; projectionStore: ProjectionStore }) =>
  async (claims: AccountClaims, id: CrewId, seasonId: string): Promise<SeasonStandingsResponse> => {
    const { crew } = await requireCrewMember(deps, claims, id);

    const season = await deps.crewStore.getSeason(id, seasonId);
    if (!season) throw new ApplicationError("season-not-found");

    // The window (spec 2026-07-22 §1): [startsAt, endsAt], both ends inclusive, converted from
    // the season's own chosen calendar dates via domain's ONE seasonWindowOf — every fold below
    // is byte-untouched by the date-strings-not-ms model.
    const window = seasonWindowOf(season);

    // ONE listLines per roster member (Promise.all — never sequential) feeds the scoreboard, the
    // shared-round derivation, AND the index boundaries alike (spec §3b) — the fetch the old
    // most-improved-superlative boundary code already paid for, now serving three uses instead
    // of one. sortLines applies golferMetrics' own chronological contract before any fold sees
    // the lines.
    const members = await Promise.all(
      crew.members.map(async (member) => ({
        golferId: member.golferId,
        lines: sortLines(await deps.projectionStore.listLines(member.golferId)),
      })),
    );

    const nameByGolfer = new Map(crew.members.map((member) => [member.golferId, member.name]));
    const scoreboard = crewScoreboard(members, window).map((row) => ({ ...row, name: nameByGolfer.get(row.golferId) ?? row.golferId }));

    // "We played together" is a DERIVED fact now (spec §3b) — a shared roundId IS the fact,
    // never a curated list. The together-folds (ledger/head-to-head/partners) run over the SAME
    // archives this derives, exactly as they did over the old counted list.
    const shared = sharedRoundIds(members, window);
    const archives = await deps.snapshots.getMany([...shared]);
    const memberIds = new Set(crew.members.map((member) => member.golferId));
    const memberOnlyContributions = archives.map((archive) => rosterFilteredContribution(archive, memberIds));
    const { ledger, headToHead } = aggregateSeason(memberOnlyContributions);
    const partners = partnerRecords(archives, memberIds).map((pair) => ({
      ...pair,
      nameA: nameByGolfer.get(pair.a) ?? pair.a,
      nameB: nameByGolfer.get(pair.b) ?? pair.b,
    }));

    // Shared rounds newest-first by finalizedAtMs; any holder's line is authoritative for a given
    // roundId (a round finalizes once — same finalizedAt, frozen courseName, createdAt on every
    // participant's line), so the first holder found supplies the canonical designation (spec §3).
    const lineByRound = new Map<RoundId, StoredLine>();
    for (const { lines } of members) for (const line of lines) if (!lineByRound.has(line.roundId)) lineByRound.set(line.roundId, line);
    const rounds = shared
      .map((roundId) => {
        const line = lineByRound.get(roundId)!;
        return { roundId, finalizedAt: line.finalizedAtMs, courseName: line.courseName, createdAt: line.createdAtMs };
      })
      .sort((a, b) => b.finalizedAt - a.finalizedAt);

    return {
      seasonId: season.seasonId,
      name: season.name,
      startsAt: season.startsAt,
      endsAt: season.endsAt,
      scoreboard,
      rounds,
      // Every golferId reaching here is, by construction, a current roster member (the filter
      // above) — nameByGolfer.get is never undefined in practice; the golferId fallback exists
      // only so a hypothetical gap fails soft (a raw id) rather than crashing the response.
      ledger: ledger.map((line) => ({ ...line, name: nameByGolfer.get(line.golferId) ?? line.golferId })),
      headToHead,
      partners,
    };
  };
