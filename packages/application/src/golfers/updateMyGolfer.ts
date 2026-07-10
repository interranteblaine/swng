import type { Golfer } from "@swng/domain";
import type { GolferResponse, UpdateMeRequest } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import { getOrCreateGolfer } from "./getMyGolfer.js";
import { toGolferView } from "./golferView.js";

// official is self-maintained in v1 (architecture.md §2 / the M7 plan): a golfer typing
// their own GHIN index here IS the manual maintenance the doc describes, so it's patched
// exactly like declared/name/homeCourseId — no separate verification flow.
//
// updateMyGolfer (PUT /me) is now the ONLY get-or-create path (GET /me plan amendment:
// getMyGolfer.ts never writes) — a PUT before any prior GET /me still lands on a real row.
//
// No retry-on-conflict loop (unlike courses' retryOnConflict): this is a golfer editing
// THEIR OWN profile, not a shared resource multiple people race on — a genuine double-tap
// collision is rare enough that surfacing "golfer-conflict" for the caller to retry the
// whole request is simpler than a bounded loop, and self-heals on the next attempt.
export const updateMyGolfer =
  (deps: { golferStore: GolferStore; idGenerator: IdGenerator }) =>
  async (claims: AccountClaims, command: UpdateMeRequest): Promise<GolferResponse> => {
    const found = await getOrCreateGolfer(deps, claims);

    const patched: Golfer = {
      ...found.golfer,
      ...(command.name !== undefined ? { name: command.name } : {}),
      ...(command.homeCourseId !== undefined ? { homeCourseId: command.homeCourseId } : {}),
      handicap: {
        ...found.golfer.handicap,
        ...(command.declared !== undefined ? { declared: command.declared } : {}),
        ...(command.official !== undefined ? { official: command.official } : {}),
      },
    };

    await deps.golferStore.put({ ...patched, sub: found.sub }, found.revision);
    return { golfer: toGolferView(patched) };
  };
