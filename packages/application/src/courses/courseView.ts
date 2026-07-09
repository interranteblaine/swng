import type { Course } from "@swng/domain";
import { courseCardOf } from "@swng/domain";
import type { CourseView } from "@swng/contracts";

// The one place a Course aggregate becomes its wire projection — createCourse, addTeeSet,
// verifyTeeSet, and getCourse all return the same shape, so it's built once here rather
// than four times: `card` is exactly courseCardOf's output (what StartRound consumes),
// `teeSets` is CURRENT-versions-only metadata (superseded history stays server-side in v1 —
// the UI shows badges, not history).
export const toCourseView = (course: Course): CourseView => ({
  courseId: course.courseId,
  name: course.name,
  card: courseCardOf(course),
  teeSets: course.teeSets
    .filter((version) => version.status === "current")
    .map((version) => ({
      name: version.tee.name,
      version: version.version,
      provenance: version.provenance,
      enteredBy: version.enteredBy,
      verifiedBy: version.verifications.map((verification) => verification.name),
    })),
});
