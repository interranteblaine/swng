import type { Golfer } from "@swng/domain";
import { golferId } from "@swng/domain";
import type { GetMeResponse } from "@swng/contracts";
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
// means. A fresh id never collides with an existing item, so the create branch's put is
// unconditional (expectedRevision undefined); the rare race of two tabs' first-ever write
// for the same sub landing simultaneously surfaces as "golfer-conflict" on the loser, which
// self-heals on its next GET /me (getBySub then finds the winner's row) — not worth a retry
// loop for beta.
export const getOrCreateGolfer = async (
  deps: { golferStore: GolferStore; idGenerator: IdGenerator },
  claims: AccountClaims,
): Promise<{ golfer: Golfer; sub: string; revision: number }> => {
  const existing = await deps.golferStore.getBySub(claims.sub);
  if (existing) return existing;

  const golfer: Golfer = { id: golferId(deps.idGenerator.newId()), name: defaultGolferName(claims), handicap: {} };
  await deps.golferStore.put({ ...golfer, sub: claims.sub }, undefined);
  return { golfer, sub: claims.sub, revision: 1 };
};

// GET /me NEVER creates (plan amendment, controller-decided — supersedes the plan's original
// "get-or-create"): a get-or-create here would bind the sub the moment ANY screen calls
// GET /me (e.g. on sign-in), so by the time a golfer reaches a claim button their sub is
// already bound to their own freshly-minted golfer — every claimGolfer call would then hit
// the "sub already bound elsewhere" collision arm and the plan's own headline scenario
// ("claim the ghost you've been all season") could never succeed. Read-only fixes that:
// an unbound sub gets `golfer: null`; updateMyGolfer (PUT /me) is the one create path, and
// claimGolfer creates the target ghost's row directly via golferStore.claim.
export const getMyGolfer =
  (deps: { golferStore: GolferStore }) =>
  async (claims: AccountClaims): Promise<GetMeResponse> => {
    const found = await deps.golferStore.getBySub(claims.sub);
    return { golfer: found ? toGolferView(found.golfer) : null };
  };
