import { addTeeSet as addTeeSetEntity } from "@swng/domain";
import type { CourseId } from "@swng/domain";
import type { AddTeeSetRequest, AddTeeSetResponse } from "@swng/contracts";
import type { Clock } from "../ports/clock.js";
import type { CourseStore } from "../ports/courseStore.js";
import type { Logger } from "../ports/logger.js";
import { retryOnConflict } from "../retryOnConflict.js";
import { toCourseView } from "./courseView.js";

export const addTeeSet =
  (deps: { courseStore: CourseStore; clock: Clock; logger: Logger }) =>
  async (id: CourseId, command: AddTeeSetRequest): Promise<AddTeeSetResponse> => {
    // Domain validation and duplicate-tee-name both throw DomainError and propagate
    // uncaught (same idiom as createCourse); a genuine write race surfaces as
    // "course-conflict" from the store and is retried here on a fresh read.
    const course = await retryOnConflict(
      {
        get: async () => {
          const found = await deps.courseStore.get(id);
          return found && { value: found.course, revision: found.revision };
        },
        put: (value, revision) => deps.courseStore.put(value, revision),
      },
      (current) => addTeeSetEntity(current, { tee: command.tee, enteredBy: command.enteredBy, nowMs: deps.clock.now() }),
      { notFound: "course-not-found", conflict: "course-conflict" },
    );
    deps.logger.info("tee-set-added", { courseId: id, tee: command.tee.name });

    return { course: toCourseView(course) };
  };
