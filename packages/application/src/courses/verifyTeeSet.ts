import { verifyTeeSet as verifyTeeSetEntity } from "@swng/domain";
import type { CourseId } from "@swng/domain";
import type { VerifyTeeSetRequest, VerifyTeeSetResponse } from "@swng/contracts";
import type { Clock } from "../ports/clock.js";
import type { CourseStore } from "../ports/courseStore.js";
import type { Logger } from "../ports/logger.js";
import { toCourseView } from "./courseView.js";
import { retryOnConflict } from "./retryOnConflict.js";

export const verifyTeeSet =
  (deps: { courseStore: CourseStore; clock: Clock; logger: Logger }) =>
  async (id: CourseId, command: VerifyTeeSetRequest): Promise<VerifyTeeSetResponse> => {
    // unknown-tee-set (DomainError) propagates uncaught — same idiom as startRound's
    // findTeeSet call; a genuine write race surfaces as "course-conflict" and is retried.
    const course = await retryOnConflict(deps.courseStore, id, (current) =>
      verifyTeeSetEntity(current, { teeName: command.teeName, verifierName: command.verifierName, nowMs: deps.clock.now() }),
    );
    deps.logger.info("tee-set-verified", { courseId: id, teeName: command.teeName, verifierName: command.verifierName });

    return { course: toCourseView(course) };
  };
