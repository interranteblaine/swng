import {
  PutCommand,
  GetCommand,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Course, CourseId } from "@swng/domain";
import type { CourseRepository } from "@swng/application";
import {
  coursePk,
  COURSE_METADATA_SK,
  COURSES_GSI1PK,
  GSI1_NAME,
} from "./keys";
import { toCourseItem, fromCourseItem, CourseItem } from "./courseItems";
import { DynamoConfig } from "./config";

export function createDynamoCourseRepository(
  config: DynamoConfig
): CourseRepository {
  const { tableName, docClient, logger } = config;

  async function getCourse(courseId: CourseId): Promise<Course | null> {
    logger?.debug("DDB getCourse", { tableName, courseId });

    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: coursePk(courseId),
          SK: COURSE_METADATA_SK,
        },
      })
    );

    if (!result.Item) return null;

    return fromCourseItem(result.Item as CourseItem);
  }

  async function listCourses(): Promise<Course[]> {
    logger?.debug("DDB listCourses", { tableName });

    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: GSI1_NAME,
        KeyConditionExpression: "GSI1PK = :gpk",
        ExpressionAttributeValues: {
          ":gpk": COURSES_GSI1PK,
        },
      })
    );

    const items = (result.Items ?? []) as CourseItem[];
    return items.map(fromCourseItem);
  }

  async function saveCourse(course: Course): Promise<void> {
    const item = toCourseItem(course);
    logger?.debug("DDB saveCourse", { tableName, courseId: course.courseId });

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );
  }

  async function deleteCourse(courseId: CourseId): Promise<void> {
    logger?.debug("DDB deleteCourse", { tableName, courseId });

    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: coursePk(courseId),
          SK: COURSE_METADATA_SK,
        },
      })
    );
  }

  return {
    getCourse,
    listCourses,
    saveCourse,
    deleteCourse,
  };
}
