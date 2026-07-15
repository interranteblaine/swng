import type { CourseId } from "@swng/domain";
import type { GetCourseResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { CardStore } from "../ports/cardStore.js";
import { toCourseView } from "./courseView.js";

export const getCourse =
  (deps: { cardStore: CardStore }) =>
  async (id: CourseId): Promise<GetCourseResponse> => {
    const current = await deps.cardStore.getCurrent(id);
    if (!current) throw new ApplicationError("course-not-found");
    return { course: toCourseView(current) };
  };
