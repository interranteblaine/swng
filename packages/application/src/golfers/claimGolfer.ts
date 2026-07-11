import type { ClaimGolferRequest, GolferResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { GolferStore } from "../ports/golferStore.js";
import { defaultGolferName } from "./getMyGolfer.js";
import { toGolferView } from "./golferView.js";

// "GolferMerged" (a sub whose OWN golfer already carries history attempting to claim a
// SECOND, different golferId) is explicitly out of v1 scope (M7 plan) — this precheck
// rejects it with the same code a genuine double-claim gets, rather than attempting any
// merge. The precheck runs BEFORE the target golferId is ever touched (no put, no bindSub),
// so a rejected attempt never creates an item under it either.
//
// This precheck's normal-flow case is now genuinely unbound (getMyGolfer.ts's GET /me
// plan amendment): a sub that's only ever GET-ed (never PUT or claimed) has no golfer row,
// so boundElsewhere is undefined and the first claim proceeds straight through — the
// "GolferMerged" arm above only fires for a sub that's already PUT its own profile or
// claimed a different ghost.
//
// M9 hardening (replaces the old `golferStore.claim`, which both created AND bound in one
// call): a ghost claimed for the first time has no golfer item yet (golfer items are lazy) —
// this `put`s a fresh, unclaimed row directly under the SAME golferId the round already knows
// the player by (papercut 5, M8 plan: command.name, when supplied, seeds it; otherwise the
// claims-derived default), THEN `bindSub`s it. An EXISTING row (already-ghosted, unclaimed)
// skips the put entirely, so it's never renamed no matter what name is passed. bindSub is the
// ONE atomic arbiter regardless of which branch ran — a losing claimant's put on a fresh
// golferId can itself lose a create race (swallowed below as harmless: the row now exists,
// created by whoever won), but bindSub's OWN condition is what actually decides who wins the
// CLAIM, surfacing "golfer-already-claimed" on the loser either way.
export const claimGolfer =
  (deps: { golferStore: GolferStore }) =>
  async (claims: AccountClaims, command: ClaimGolferRequest): Promise<GolferResponse> => {
    const boundElsewhere = await deps.golferStore.getBySub(claims.sub);
    if (boundElsewhere && boundElsewhere.golfer.id !== command.golferId) {
      throw new ApplicationError("golfer-already-claimed", `sub already bound to golfer ${boundElsewhere.golfer.id}`);
    }

    const existing = await deps.golferStore.get(command.golferId);
    if (!existing) {
      try {
        await deps.golferStore.put({ id: command.golferId, name: command.name ?? defaultGolferName(claims), handicap: {} }, undefined);
      } catch (error) {
        if (!(error instanceof ApplicationError) || error.code !== "golfer-conflict") throw error;
        // A concurrent claimant's put won the create race first — harmless: the row exists
        // now, bindSub below is what actually arbitrates who WINS the claim.
      }
    }

    await deps.golferStore.bindSub(command.golferId, claims.sub);

    const found = await deps.golferStore.get(command.golferId);
    // bindSub just succeeded, so the item is guaranteed to exist now.
    return { golfer: toGolferView(found!.golfer) };
  };
