import { verifyTeeSet as verifyTeeSetEntity } from "@swng/domain";
import type { CourseId } from "@swng/domain";
import type { VerifyTeeSetRequest, VerifyTeeSetResponse } from "@swng/contracts";
import type { Clock } from "../ports/clock.js";
import type { CourseStore } from "../ports/courseStore.js";
import type { Logger } from "../ports/logger.js";
import { retryOnConflict } from "../retryOnConflict.js";
import { toCourseView } from "./courseView.js";

export const verifyTeeSet =
  (deps: { courseStore: CourseStore; clock: Clock; logger: Logger }) =>
  async (id: CourseId, command: VerifyTeeSetRequest): Promise<VerifyTeeSetResponse> => {
    // unknown-tee-set and tee-set-revised (both DomainErrors) propagate uncaught — same idiom
    // as startRound's findTeeSet call; a genuine write race surfaces as "course-conflict" and
    // is retried. tee-set-revised is NOT a course-conflict: command.version is fixed by the
    // caller's own read (the card they looked at), not re-derived from whatever retryOnConflict
    // re-reads — so a revision landing mid-retry correctly fails the whole verify instead of
    // retrying into a silent transplant onto numbers the caller never saw.
    const course = await retryOnConflict(
      {
        get: async () => {
          const found = await deps.courseStore.get(id);
          return found && { value: found.course, revision: found.revision };
        },
        put: (value, revision) => deps.courseStore.put(value, revision),
      },
      (current) =>
        verifyTeeSetEntity(current, {
          teeName: command.teeName,
          verifierName: command.verifierName,
          expectedVersion: command.version,
          nowMs: deps.clock.now(),
        }),
      { notFound: "course-not-found", conflict: "course-conflict" },
    );
    deps.logger.info("tee-set-verified", { courseId: id, teeName: command.teeName, verifierName: command.verifierName });

    return { course: toCourseView(course) };
  };
