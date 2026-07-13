import { aggregateSeason, crewContribution } from "@swng/domain";
import type { CrewId } from "@swng/domain";
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
// A crew is a grouping/competition ONLY (owner ruling, spec §11a, 2026-07-13): standings
// aggregate the CURRENT roster only. Each contribution's `lines`/`headToHead` are filtered to
// golferIds on the roster BEFORE the fold — a departed member or a guest who was never on the
// roster contributes NO row and no head-to-head pair; nothing is stored, so re-adding a member
// restores their rows on the very next read (compute-on-read reversibility). Names come from
// the roster's own `CrewMember.name` — never the snapshot's, which can drift from what the crew
// actually calls someone (e.g. a nickname on the roster vs. whatever name a round happened to
// carry).
export const getSeasonStandings =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; snapshots: SnapshotStore }) =>
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
    const memberOnlyContributions = archives.map((archive) => {
      const contribution = crewContribution(archive);
      return {
        ...contribution,
        lines: contribution.lines.filter((line) => memberIds.has(line.golferId)),
        headToHead: contribution.headToHead.filter((h2h) => memberIds.has(h2h.a) && memberIds.has(h2h.b)),
      };
    });

    const { ledger, headToHead } = aggregateSeason(memberOnlyContributions);

    const rounds: readonly CountedRoundView[] = [...counted]
      .sort((a, b) => b.finalizedAtMs - a.finalizedAtMs) // newest-first
      .map((entry) => ({ roundId: entry.roundId, finalizedAt: entry.finalizedAtMs, appendedBy: entry.appendedBy }));

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
    };
  };
