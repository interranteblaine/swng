import type { GolferId, GolferRoundLine } from "@swng/domain";

// The rebuildable projections a finalized round writes into (architecture.md §2/§4): one
// history line per participant per round — upserted by (golferId, roundId), so a stream
// retry or a rebuild replay landing the SAME archive twice is a no-op, not an accumulation —
// and one running index snapshot per golfer. wipeGolfer is rebuildProjections' first step:
// clear a golfer's projections entirely before replaying every archive that touches them
// from scratch, so no stale line/snapshot from a projection that no longer applies survives
// the rebuild.
export interface ProjectionStore {
  putHistoryLine(golferId: GolferId, line: GolferRoundLine & { readonly finalizedAtMs: number }): Promise<void>;
  // oldest → newest (finalizedAtMs order) — the order combineNineHoleDifferentials and
  // computeIndex need; a wire response reverses this for "newest first" display.
  listHistory(golferId: GolferId): Promise<readonly (GolferRoundLine & { readonly finalizedAtMs: number })[]>;
  putIndex(golferId: GolferId, snapshot: { readonly value: number; readonly computedAtMs: number; readonly differentialsUsed: number }): Promise<void>;
  getIndex(golferId: GolferId): Promise<{ value: number; computedAtMs: number; differentialsUsed: number } | undefined>;
  wipeGolfer(golferId: GolferId): Promise<void>;
}
