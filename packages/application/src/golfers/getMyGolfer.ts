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

// Golfer items are lazy (M7 plan): nothing exists for a sub until its first GET /me or a
// claim. Shared by getMyGolfer (below) and updateMyGolfer so the two never drift on what
// "fresh" means — a PUT before any prior GET /me still lands on a real row. A fresh id
// never collides with an existing item, so the create branch's put is unconditional
// (expectedRevision undefined); the rare race of two tabs signing in for the very first
// time simultaneously surfaces as "golfer-conflict" on the loser, which self-heals on its
// next GET /me (getBySub then finds the winner's row) — not worth a retry loop for beta.
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

export const getMyGolfer =
  (deps: { golferStore: GolferStore; idGenerator: IdGenerator }) =>
  async (claims: AccountClaims): Promise<GetMeResponse> => {
    const found = await getOrCreateGolfer(deps, claims);
    return { golfer: toGolferView(found.golfer) };
  };
