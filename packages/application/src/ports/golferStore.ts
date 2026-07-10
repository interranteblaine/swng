import type { Golfer, GolferId } from "@swng/domain";

// A Golfer's identity is lazy (M7 plan): no item exists until the first GET /me (get-or-
// create from a fresh sub) or the first claim on a ghost. Revision-conditional CRUD like
// CourseStore (courseStore.ts) — same expectedRevision contract, same conflict shape, here
// named "golfer-conflict".
export interface GolferStore {
  // expectedRevision undefined ⇒ create (condition: item absent); n ⇒ replace revision n
  // (condition: stored revision === n). On condition failure throws the application-layer
  // error idiom (errors.ts) with code "golfer-conflict".
  put(golfer: Golfer & { readonly sub?: string }, expectedRevision: number | undefined): Promise<void>;
  get(golferId: GolferId): Promise<{ golfer: Golfer; sub?: string; revision: number } | undefined>;
  getBySub(sub: string): Promise<{ golfer: Golfer; sub: string; revision: number } | undefined>;
  // Atomically creates-or-updates the golfer item with `sub`, conditional on no EXISTING sub
  // binding on THIS golferId (attribute_not_exists(sub) in the real Dynamo adapter, Task 3).
  // `name` (and a fresh, empty HandicapProfile) only apply on the create branch — an item
  // that already exists unclaimed keeps its own name/handicap, only `sub` is set. A second
  // claimant on an already-bound golferId throws "golfer-already-claimed"; the OTHER
  // collision arm (a sub already bound to a DIFFERENT golferId — "GolferMerged," explicitly
  // out of v1 scope) is the CALLER's job via a getBySub(sub) precheck before ever calling
  // this (golfers/claimGolfer.ts), throwing the same code.
  claim(golferId: GolferId, sub: string, name: string): Promise<void>;
}
