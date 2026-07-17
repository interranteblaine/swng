import type { Golfer } from "@swng/domain";
import type { GolferResponse, UpdateMeRequest } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import { ensureGolfer } from "./ensureGolfer.js";
import { toGolferView } from "./golferView.js";

// indexSource is the golfer's chosen index source (index-source model spec §3): picking a
// computed source (swng/whs) or asserting their own (declared) — patched exactly like
// name/homeCourseId. The stored value is a CHOICE, never a computed number, so adopting WHS
// tracks WHS live with no copy to drift (spec §2).
//
// PUT /me get-or-creates through the ONE shared ensureGolfer (accounts-only identity spec §2):
// a PUT before any prior GET /me still lands on a real, sub-bound row — minted with the
// deterministic placeholder name f(sub), NEVER the email (Cognito is a pure authenticator). A
// PUT carrying a real `name` then replaces that placeholder and drops the flag; ensureGolfer's
// own concurrent-first-request race handling means two tabs' first PUT converge on one golfer.
//
// No retry-on-conflict loop (unlike courses' retryOnConflict): this is a golfer editing
// THEIR OWN profile, not a shared resource multiple people race on — a genuine double-tap
// collision is rare enough that surfacing "golfer-conflict" for the caller to retry the
// whole request is simpler than a bounded loop, and self-heals on the next attempt.
export const updateMyGolfer =
  (deps: { golferStore: GolferStore; idGenerator: IdGenerator }) =>
  async (claims: AccountClaims, command: UpdateMeRequest): Promise<GolferResponse> => {
    // Ensure the caller's golfer exists (get-or-create), then re-read it by sub for its current
    // revision — ensureGolfer just guaranteed a bound row, so this read is non-null.
    await ensureGolfer(deps)(claims);
    const found = (await deps.golferStore.getBySub(claims.sub))!;

    // A PUT that lands a real name replaces the sub-derived placeholder, so the flag is DROPPED
    // (accounts-only identity spec §2, absent = false — never rewritten to `false`): destructure it
    // off, then re-add it only when this PUT leaves the name untouched (e.g. an index-source-only
    // edit before the funnel's name prompt) and the golfer was still on the placeholder.
    const { namePlaceholder: wasPlaceholder, ...golferBase } = found.golfer;
    const patched: Golfer = {
      ...golferBase,
      ...(command.name !== undefined ? { name: command.name } : {}),
      ...(command.homeCourseId !== undefined ? { homeCourseId: command.homeCourseId } : {}),
      ...(command.name === undefined && wasPlaceholder ? { namePlaceholder: true } : {}),
      // The chosen source when the PUT sends one, else the stored source untouched (partial-patch
      // semantics) — always a well-formed IndexSource, never a computed value cached (spec §2).
      handicap: command.indexSource !== undefined ? { indexSource: command.indexSource } : found.golfer.handicap,
    };

    await deps.golferStore.put({ ...patched, sub: found.sub }, found.revision);
    return { golfer: toGolferView(patched) };
  };
