import type { Golfer } from "@swng/domain";
import { golferId } from "@swng/domain";
import type { GetMeResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import { ensureGolfer } from "./ensureGolfer.js";
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

// GET /me get-or-creates (accounts-only identity spec §2, controller ruling — this DELIBERATELY
// reverses the M7 "GET /me never creates" rule). That old rule existed only to protect claimable
// ghosts: an auto-create bound the sub before a later claim could run, wedging the claim flow. The
// spec kills ghosts, so the ambiguity that motivated the rule is gone — the first authenticated
// request that needs the caller's golfer now mints it (ensureGolfer: placeholderName(sub) +
// namePlaceholder: true, via the M9 SUB# transaction). The response's `golfer` is therefore never
// null in practice, but the type stays nullable — it's the shared GetMeResponse the wire already
// speaks, and tightening it is out of this additive task's scope.
export const getMyGolfer =
  (deps: { golferStore: GolferStore; idGenerator: IdGenerator }) =>
  async (claims: AccountClaims): Promise<GetMeResponse> => {
    const golfer = await ensureGolfer(deps)(claims);
    return { golfer: toGolferView(golfer) };
  };
