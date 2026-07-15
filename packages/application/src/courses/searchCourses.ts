import { courseNameKey } from "@swng/domain";
import type { SearchCoursesResponse } from "@swng/contracts";
import type { CardStore } from "../ports/cardStore.js";

const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 25;

// Empty-after-trim queries are rejected at the route layer (ContractError, via routes.ts's
// hand-parsed parseSearchQuery — there is no wire query schema for GET /courses; query rides
// the URL, not a JSON body) before this ever runs, so this only has to normalize (the ONE
// nameKey normalization, courseNameKey — same one the card store's pointer write uses) and
// clamp, not re-validate presence. Results now carry holeCount (CardStore.search's own shape).
export const searchCourses =
  (deps: { cardStore: CardStore }) =>
  async (query: string, limit: number = DEFAULT_LIMIT): Promise<SearchCoursesResponse> => {
    const clampedLimit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(limit)));
    const courses = await deps.cardStore.search(courseNameKey(query), clampedLimit);
    return { courses };
  };
