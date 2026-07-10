import type { ClaimGolferRequest, GolferResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { GolferStore } from "../ports/golferStore.js";
import { defaultGolferName } from "./getMyGolfer.js";
import { toGolferView } from "./golferView.js";

// "GolferMerged" (a sub whose OWN golfer already carries history attempting to claim a
// SECOND, different golferId) is explicitly out of v1 scope (M7 plan) — this precheck
// rejects it with the same code a genuine double-claim gets, rather than attempting any
// merge. The precheck runs BEFORE golferStore.claim is ever called, so a rejected attempt
// never touches (or creates) an item under the target golferId.
//
// This precheck's normal-flow case is now genuinely unbound (getMyGolfer.ts's GET /me
// plan amendment): a sub that's only ever GET-ed (never PUT or claimed) has no golfer row,
// so boundElsewhere is undefined and the first claim proceeds straight through — the
// "GolferMerged" arm above only fires for a sub that's already PUT its own profile or
// claimed a different ghost.
export const claimGolfer =
  (deps: { golferStore: GolferStore }) =>
  async (claims: AccountClaims, command: ClaimGolferRequest): Promise<GolferResponse> => {
    const boundElsewhere = await deps.golferStore.getBySub(claims.sub);
    if (boundElsewhere && boundElsewhere.golfer.id !== command.golferId) {
      throw new ApplicationError("golfer-already-claimed", `sub already bound to golfer ${boundElsewhere.golfer.id}`);
    }

    // A ghost claimed for the first time has no golfer item yet (golfer items are lazy) —
    // golferStore.claim creates one under the SAME golferId the round already knows the
    // player by. The name seeds from THIS account's own claims (getMyGolfer's same
    // derivation): each round's own history keeps whatever name was recorded there at the
    // time; this is the unified identity's name going forward, editable via updateMyGolfer.
    await deps.golferStore.claim(command.golferId, claims.sub, defaultGolferName(claims));

    const found = await deps.golferStore.get(command.golferId);
    // claim() just succeeded without throwing, so the item is guaranteed to exist now.
    return { golfer: toGolferView(found!.golfer) };
  };
