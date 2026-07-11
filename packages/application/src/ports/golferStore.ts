import type { Golfer, GolferId } from "@swng/domain";

// A Golfer's identity is lazy (M7 plan): no item exists until the first GET /me (get-or-
// create from a fresh sub) or the first claim on a ghost. Revision-conditional CRUD like
// CourseStore (courseStore.ts), same expectedRevision contract, same conflict shape, here
// named "golfer-conflict".
export interface GolferStore {
  // expectedRevision undefined ⇒ create (condition: item absent); n ⇒ replace revision n
  // (condition: stored revision === n). On condition failure throws the application-layer
  // error idiom (errors.ts) with code "golfer-conflict".
  //
  // M9 hardening: a REPLACE (expectedRevision defined) that would CLEAR a currently-bound sub
  // is refused — throws "sub-drop-forbidden" instead of silently unbinding. Every real call
  // site (golfers/updateMyGolfer.ts) already re-passes its own `found.sub` on every replace, so
  // this is a programmer-error net, not a concurrency invariant (that's bindSub's job below) —
  // a deliberate 500 in the lambda's error-mapping module, never a client-shaped 4xx.
  // Establishing a NEW binding on create is still accepted here (kept for direct-put test
  // fixtures), but no real call site does that anymore — see bindSub's own doc below.
  put(golfer: Golfer & { readonly sub?: string }, expectedRevision: number | undefined): Promise<void>;
  get(golferId: GolferId): Promise<{ golfer: Golfer; sub?: string; revision: number } | undefined>;
  // M9 hardening: reads via the base-table SUB#<sub> pointer item bindSub maintains
  // (ConsistentRead in the real adapter) — gsi2's own sub→golfer projection (still written, for
  // rollback safety) is no longer read by anything. keys.ts's golferSubPk doc comment has the
  // full "why": gsi2 is eventually consistent, which is exactly the race this move closes.
  getBySub(sub: string): Promise<{ golfer: Golfer; sub: string; revision: number } | undefined>;
  // M9 hardening (replaces the old `claim`): atomically binds `sub` to an EXISTING golferId
  // row — in the real adapter, ONE TransactWriteItems call writes the SUB#<sub> pointer item
  // (condition: attribute_not_exists(pk)) AND sets `sub` on the golfer row (condition:
  // attribute_exists(pk) AND attribute_not_exists(sub)). Either condition failing throws
  // "golfer-already-claimed" — the ONE primitive now enforces BOTH invariants: no sub is ever
  // bound to two different golferIds (the pointer condition — this closes the M7-era
  // gsi2-eventual-consistency duplicate-golfer race, since the pointer is a real, strongly-
  // consistent base-table key, not a GSI projection), and no golferId is ever claimed twice
  // (the row condition, the same guarantee the old `claim`'s attribute_not_exists(sub) already
  // gave). Requires the row to ALREADY exist — bindSub never creates one, unlike the old
  // `claim`; a caller claiming a ghost that's never had a row yet (golfers/claimGolfer.ts) or
  // creating a fresh account golfer (golfers/getMyGolfer.ts's getOrCreateGolfer) `put`s it
  // first, then binds.
  bindSub(golferId: GolferId, sub: string): Promise<void>;
}
