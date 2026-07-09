import { courseId as toCourseId, createCourse as createCourseEntity } from "@swng/domain";
import type { CreateCourseRequest, CreateCourseResponse } from "@swng/contracts";
import type { Clock } from "../ports/clock.js";
import type { CourseStore } from "../ports/courseStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { Logger } from "../ports/logger.js";
import { toCourseView } from "./courseView.js";

export const createCourse =
  (deps: { courseStore: CourseStore; idGenerator: IdGenerator; clock: Clock; logger: Logger }) =>
  async (command: CreateCourseRequest): Promise<CreateCourseResponse> => {
    const id = toCourseId(deps.idGenerator.newId());
    // Domain validation (invalid-course-name, invalid-tee-name, invalid-rating, ...) throws
    // DomainError and propagates uncaught — same idiom as startRound's findTeeSet call.
    const course = createCourseEntity({ courseId: id, name: command.name, tee: command.tee, enteredBy: command.enteredBy, nowMs: deps.clock.now() });

    // A fresh, server-minted courseId never collides with an existing item, so unlike
    // addTeeSet/verifyTeeSet this create has nothing to retry against — expectedRevision
    // undefined asks the store to condition on "item absent," which a fresh id always is.
    await deps.courseStore.put(course, undefined);
    deps.logger.info("course-created", { courseId: id, name: command.name });

    return { course: toCourseView(course) };
  };
