import type { CrewId, CrewRoundContribution, GolferId, GolferRoundLine, HeadToHeadRecord, SeasonLedgerLine } from "@swng/domain";

// The season ledger + head-to-head records a crew round projects into (M8 plan,
// architecture.md's `LEDGER#crew#season` / `H2H#crew#a#b`) — exactly aggregateSeason's
// return shape (crew/ledger.ts), so putSeasonRecords/getSeasonRecords never re-derive a
// different shape from what the pure fold already produces.
export interface CrewSeasonRecords {
  readonly ledger: readonly SeasonLedgerLine[];
  readonly headToHead: readonly HeadToHeadRecord[];
}

// The rebuildable projections a finalized round writes into (architecture.md §2/§4): one
// history line per participant per round — upserted by (golferId, roundId), so a stream
// retry or a rebuild replay landing the SAME archive twice is a no-op, not an accumulation —
// and one running index snapshot per golfer. wipeGolfer is rebuildProjections' first step:
// clear a golfer's projections entirely before replaying every archive that touches them
// from scratch, so no stale line/snapshot from a projection that no longer applies survives
// the rebuild.
//
// M8 adds the crew season ledger, same upsert-then-recompute shape: putCrewRound upserts one
// archive's contribution by (crewId, roundId) — never `+=` — and putSeasonRecords always
// carries the WHOLE recomputed (crew, season) records, replacing whatever was there. Season
// boundaries are UTC calendar years (projectArchive.ts derives them from finalizedAtMs); a
// crew's history can span several season buckets, each independently keyed.
export interface ProjectionStore {
  putHistoryLine(golferId: GolferId, line: GolferRoundLine & { readonly finalizedAtMs: number }): Promise<void>;
  // oldest → newest (finalizedAtMs order) — the order combineNineHoleDifferentials and
  // computeIndex need; a wire response reverses this for "newest first" display.
  listHistory(golferId: GolferId): Promise<readonly (GolferRoundLine & { readonly finalizedAtMs: number })[]>;
  putIndex(golferId: GolferId, snapshot: { readonly value: number; readonly computedAtMs: number; readonly differentialsUsed: number }): Promise<void>;
  getIndex(golferId: GolferId): Promise<{ value: number; computedAtMs: number; differentialsUsed: number } | undefined>;
  wipeGolfer(golferId: GolferId): Promise<void>;
  // Upsert by (crewId, roundId) via entry.roundId — a repeat put for the same round replaces,
  // never accumulates.
  putCrewRound(crewId: CrewId, season: number, entry: CrewRoundContribution & { readonly finalizedAtMs: number }): Promise<void>;
  listCrewRounds(crewId: CrewId, season: number): Promise<readonly (CrewRoundContribution & { readonly finalizedAtMs: number })[]>;
  putSeasonRecords(crewId: CrewId, season: number, records: CrewSeasonRecords): Promise<void>;
  getSeasonRecords(crewId: CrewId, season: number): Promise<CrewSeasonRecords | undefined>;
  // rebuildProjections' first step for every crew TOUCHED by the archive set (mirrors
  // wipeGolfer above) — `seasons` is supplied by the caller (rebuildProjections already
  // collected them from the archives it's about to replay), so this store never has to
  // discover its own keyspace.
  wipeCrew(crewId: CrewId, seasons: readonly number[]): Promise<void>;
}
