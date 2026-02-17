import type {
  Course,
  CourseId,
  IsoDateTime,
  TeeSet,
} from "@swng/domain";
import {
  COURSE_METADATA_SK,
  COURSES_GSI1PK,
  coursePk,
  courseGsi1Sk,
} from "./keys";

export interface CourseItem {
  PK: string;
  SK: typeof COURSE_METADATA_SK;
  GSI1PK: typeof COURSES_GSI1PK;
  GSI1SK: string;
  courseId: CourseId;
  name: string;
  location?: string;
  holeCount: number;
  teeSets: TeeSet[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export function toCourseItem(course: Course): CourseItem {
  return {
    PK: coursePk(course.courseId),
    SK: COURSE_METADATA_SK,
    GSI1PK: COURSES_GSI1PK,
    GSI1SK: courseGsi1Sk(course.courseId),
    courseId: course.courseId,
    name: course.name,
    location: course.location,
    holeCount: course.holeCount,
    teeSets: course.teeSets,
    createdAt: course.createdAt,
    updatedAt: course.updatedAt,
  };
}

export function fromCourseItem(item: CourseItem): Course {
  return {
    courseId: item.courseId,
    name: item.name,
    location: item.location,
    holeCount: item.holeCount,
    teeSets: item.teeSets,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}
