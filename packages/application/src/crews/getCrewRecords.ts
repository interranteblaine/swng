import { aggregateSeason, partnerRecords, sharedRoundIds } from "@swng/domain";
import type { CrewId } from "@swng/domain";
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
// (rosterFilteredContribution — one implementation, never a second), plus partner records.
// `titles` is transitional-empty (crowning is deleted, spec 2026-07-22 §3) — this whole use
// case + route is itself deleted next task (spec §4).
export const getCrewRecords =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; snapshots: SnapshotStore; projectionStore: ProjectionStore }) =>
  async (claims: AccountClaims, id: CrewId): Promise<CrewRecordsResponse> => {
    const { crew } = await requireCrewMember(deps, claims, id);
    const memberIds = new Set(crew.members.map((member) => member.golferId));
    const nameByGolfer = new Map(crew.members.map((member) => [member.golferId, member.name]));

    // ONE listLines per roster member (Promise.all) — the same fetch getSeasonStandings.ts
    // performs, feeding the all-time shared-round derivation below.
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

    const memberOnlyContributions = archives.map((archive) => rosterFilteredContribution(archive, memberIds));
    const { ledger, headToHead } = aggregateSeason(memberOnlyContributions);
    const partners = partnerRecords(archives, memberIds).map((pair) => ({
      ...pair,
      nameA: nameByGolfer.get(pair.a) ?? pair.a,
      nameB: nameByGolfer.get(pair.b) ?? pair.b,
    }));

    // Titles: crowning is deleted whole (spec 2026-07-22 §1/§3 — a crew season is a tracking
    // window, not a defined competition with a winner to anoint; there is no more `status`/
    // `closedAtMs` for a "closed season" title to gate on). This whole use case + its route are
    // themselves deleted next task (spec §4, "All-time collapses into the concept") — `titles`
    // stays on the wire shape but is always empty in the meantime, never computed from a
    // deleted lifecycle flag.
    const titles: CrewRecordsResponse["titles"] = [];

    return {
      rounds: sharedEver.length,
      ledger: ledger.map((line) => ({ ...line, name: nameByGolfer.get(line.golferId) ?? line.golferId })),
      headToHead,
      partners,
      titles,
    };
  };
