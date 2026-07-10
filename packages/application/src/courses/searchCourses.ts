import { courseNameKey } from "@swng/domain";
import type { SearchCoursesResponse } from "@swng/contracts";
import type { CourseStore } from "../ports/courseStore.js";

const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 25;

// Empty-after-trim queries are rejected at the route layer (ContractError, via routes.ts's
// hand-parsed parseSearchQuery — there is no wire query schema for GET /courses; query rides
// the URL, not a JSON body) before this ever runs, so this only has to normalize (the ONE
// nameKey normalization, courseNameKey — same one createCourse/addTeeSet's store write uses)
// and clamp, not re-validate presence.
export const searchCourses =
  (deps: { courseStore: CourseStore }) =>
  async (query: string, limit: number = DEFAULT_LIMIT): Promise<SearchCoursesResponse> => {
    const clampedLimit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(limit)));
    const courses = await deps.courseStore.search(courseNameKey(query), clampedLimit);
    return { courses };
  };
