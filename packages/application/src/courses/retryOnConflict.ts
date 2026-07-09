import type { Course, CourseId } from "@swng/domain";
import { ApplicationError } from "../errors.js";
import type { CourseStore } from "../ports/courseStore.js";

// Small, bounded optimistic-concurrency retry for a single-course mutation: re-read the
// course + its current revision, let the caller re-derive the next Course value (every
// domain mutation here — addTeeSet, verifyTeeSet — is a pure function of the current
// Course, so replaying it against a fresher read IS "try again"), and re-put under that
// revision. This has a precedent in adapters-dynamodb's journal append retry, but
// deliberately skips that retry's full-jitter backoff timer: the journal's loop exists to
// de-lockstep a burst of CONCURRENT machine writers hammering one round's head slot at
// outing scale, where courses see rare, human-paced edits to the same tee set — a tight
// bounded loop with no artificial delay is enough here, and a real backoff can be added
// later if beta telemetry says otherwise.
const MAX_ATTEMPTS = 5;

export const retryOnConflict = async (courseStore: CourseStore, courseId: CourseId, mutate: (course: Course) => Course): Promise<Course> => {
  let lastConflict: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const found = await courseStore.get(courseId);
    if (!found) throw new ApplicationError("course-not-found");

    const next = mutate(found.course);
    try {
      await courseStore.put(next, found.revision);
      return next;
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.code !== "course-conflict") throw error;
      lastConflict = error;
    }
  }
  throw lastConflict;
};
