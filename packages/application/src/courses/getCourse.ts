import type { CourseId } from "@swng/domain";
import type { GetCourseResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { CourseStore } from "../ports/courseStore.js";
import { toCourseView } from "./courseView.js";

export const getCourse =
  (deps: { courseStore: CourseStore }) =>
  async (id: CourseId): Promise<GetCourseResponse> => {
    const found = await deps.courseStore.get(id);
    if (!found) throw new ApplicationError("course-not-found");
    return { course: toCourseView(found.course) };
  };
