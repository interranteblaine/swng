import type { Golfer } from "@swng/domain";
import { golferId } from "@swng/domain";
import type { GetMeResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import { toGolferView } from "./golferView.js";

// A brand-new golfer's starting name — used both here (fresh GET /me) and by claimGolfer's
// own create branch (a claim from a sub that's never been seen before). The JWT carries
// little beyond sub/email at first sign-in; ProfilePage's name field (updateMyGolfer) is
// what a golfer edits afterward.
export const defaultGolferName = (claims: AccountClaims): string => claims.email?.split("@")[0] || "Golfer";

// Golfer items are lazy (M7 plan): nothing exists for a sub until its first PUT /me
// (updateMyGolfer, below) or a claim. Shared by updateMyGolfer's get-or-create AND
// claimGolfer's create branch (via defaultGolferName) so nothing drifts on what "fresh"
// means.
//
// M9 hardening: create is now a `put` (bare, unclaimed row) followed by a `bindSub` — the OLD
// single `put({...golfer, sub}, undefined)` let two tabs' first-ever PUT /me for the SAME
// brand-new sub each create their OWN golfer row (each put targets a DIFFERENT freshly-minted
// golferId, so both unconditional creates succeeded — the "known duplicate-golfer race
// window" gsi2's eventual consistency never actually caught). bindSub's pointer condition is
// the real, strongly-consistent arbiter now: the LOSER's bindSub throws
// "golfer-already-claimed", caught here and turned into "read the pointer, return the
// WINNER's golfer" — both tabs converge on the SAME identity instead of splitting into two.
export const getOrCreateGolfer = async (
  deps: { golferStore: GolferStore; idGenerator: IdGenerator },
  claims: AccountClaims,
): Promise<{ golfer: Golfer; sub: string; revision: number }> => {
  const existing = await deps.golferStore.getBySub(claims.sub);
  if (existing) return existing;

  const golfer: Golfer = { id: golferId(deps.idGenerator.newId()), name: defaultGolferName(claims), handicap: {} };
  await deps.golferStore.put(golfer, undefined);

  try {
    await deps.golferStore.bindSub(golfer.id, claims.sub);
  } catch (error) {
    if (error instanceof ApplicationError && error.code === "golfer-already-claimed") {
      const winner = await deps.golferStore.getBySub(claims.sub);
      if (winner) return winner;
    }
    throw error;
  }

  const bound = await deps.golferStore.get(golfer.id);
  // bindSub just succeeded, so the item is guaranteed to exist now (mirrors claimGolfer.ts's
  // own idiom).
  return { golfer: bound!.golfer, sub: claims.sub, revision: bound!.revision };
};

// GET /me NEVER creates (plan amendment, controller-decided — supersedes the plan's original
// "get-or-create"): a get-or-create here would bind the sub the moment ANY screen calls
// GET /me (e.g. on sign-in), so by the time a golfer reaches a claim button their sub is
// already bound to their own freshly-minted golfer — every claimGolfer call would then hit
// the "sub already bound elsewhere" collision arm and the plan's own headline scenario
// ("claim the ghost you've been all season") could never succeed. Read-only fixes that:
// an unbound sub gets `golfer: null`; updateMyGolfer (PUT /me) is the one create path, and
// claimGolfer creates the target ghost's row directly via `put` + `bindSub` (claimGolfer.ts).
export const getMyGolfer =
  (deps: { golferStore: GolferStore }) =>
  async (claims: AccountClaims): Promise<GetMeResponse> => {
    const found = await deps.golferStore.getBySub(claims.sub);
    return { golfer: found ? toGolferView(found.golfer) : null };
  };
