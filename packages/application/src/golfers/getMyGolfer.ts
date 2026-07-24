import type { GetMeResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { Metrics } from "../ports/metrics.js";
import { ensureGolfer } from "./ensureGolfer.js";
import { toGolferView } from "./golferView.js";

// GET /me get-or-creates (accounts-only identity spec §2, controller ruling — this DELIBERATELY
// reverses the M7 "GET /me never creates" rule). That old rule existed only to protect claimable
// ghosts: an auto-create bound the sub before a later claim could run, wedging the claim flow. The
// spec kills ghosts, so the ambiguity that motivated the rule is gone — the first authenticated
// request that needs the caller's golfer now mints it (ensureGolfer: placeholderName(sub) +
// namePlaceholder: true, via the M9 SUB# transaction, sub-only — never the email). The response's
// `golfer` is therefore never null in practice, but the type stays nullable — it's the shared
// GetMeResponse the wire already speaks, and tightening it is out of scope.
export const getMyGolfer =
  (deps: { golferStore: GolferStore; idGenerator: IdGenerator; metrics?: Metrics }) =>
  async (claims: AccountClaims): Promise<GetMeResponse> => {
    const golfer = await ensureGolfer(deps)(claims);
    return { golfer: toGolferView(golfer) };
  };
