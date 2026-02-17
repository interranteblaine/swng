import { createCourse } from "@swng/domain";
import type { Course, CourseId } from "@swng/domain";
import { ApplicationError } from "./errors";
import type {
  CourseService,
  CourseServiceDeps,
  CreateCourseInput,
} from "./types";

export function createCourseService(deps: CourseServiceDeps): CourseService {
  const { courseRepo, idGenerator, clock } = deps;

  return {
    async createCourse(
      input: CreateCourseInput
    ): Promise<{ course: Course }> {
      const now = clock.now();
      const course = createCourse({
        courseId: idGenerator.newCourseId(),
        name: input.name,
        location: input.location,
        holeCount: input.holeCount,
        teeSets: input.teeSets,
        createdAt: now,
        updatedAt: now,
      });

      await courseRepo.saveCourse(course);

      return { course };
    },

    async getCourse(courseId: CourseId): Promise<{ course: Course }> {
      const course = await courseRepo.getCourse(courseId);
      if (!course) {
        throw new ApplicationError("NOT_FOUND", "Course not found");
      }
      return { course };
    },

    async listCourses(): Promise<{ courses: Course[] }> {
      const courses = await courseRepo.listCourses();
      return { courses };
    },

    async deleteCourse(courseId: CourseId): Promise<void> {
      await courseRepo.deleteCourse(courseId);
    },
  };
}
