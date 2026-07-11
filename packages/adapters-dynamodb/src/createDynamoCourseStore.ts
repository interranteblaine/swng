import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Course, CourseId } from "@swng/domain";
import { courseNameKey } from "@swng/domain";
import type { CourseStore } from "@swng/application";
import { ApplicationError } from "@swng/application";
import { courseGsi1pk, courseIdFromPk, coursePk, courseSk } from "./keys.js";

export const createDynamoCourseStore = (config: { client: DynamoDBDocumentClient; tableName: string }): CourseStore => {
  const { client, tableName } = config;

  return {
    put: async (course: Course, expectedRevision: number | undefined) => {
      // revision is store-only bookkeeping (never on the Course aggregate itself, same split
      // as the in-memory fake) — a create always lands revision 1; a replace's condition
      // checks the caller's expected value but writes one past it, so the next conflict
      // check is always against what's actually stored.
      const revision = expectedRevision === undefined ? 1 : expectedRevision + 1;
      const item = {
        pk: coursePk(course.courseId),
        sk: courseSk,
        revision,
        name: course.name,
        gsi1pk: courseGsi1pk,
        gsi1sk: courseNameKey(course.name), // the ONE normalization (domain) — search's Query uses the same
        course,
      };
      const condition =
        expectedRevision === undefined
          ? { ConditionExpression: "attribute_not_exists(pk)" }
          : { ConditionExpression: "revision = :expected", ExpressionAttributeValues: { ":expected": expectedRevision } };

      try {
        await client.send(new PutCommand({ TableName: tableName, Item: item, ...condition }));
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          const detail = expectedRevision === undefined ? "already exists" : `revision mismatch (expected ${expectedRevision})`;
          throw new ApplicationError("course-conflict", `course ${course.courseId} ${detail}`);
        }
        throw error;
      }
    },

    get: async (courseId: CourseId) => {
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: coursePk(courseId), sk: courseSk },
          // Consistent for the same reason createDynamoEventJournal's headSeq is: this is the
          // read retryOnConflict (application/src/retryOnConflict.ts — shared, not course-
          // specific) bases its next mutation and expectedRevision on, so an eventually-
          // consistent read here could hand back an already-stale revision and needlessly
          // spin (or fail) the retry loop.
          ConsistentRead: true,
        }),
      );
      const item = result.Item as { course: Course; revision: number } | undefined;
      return item ? { course: item.course, revision: item.revision } : undefined;
    },

    search: async (nameKeyPrefix: string, limit: number) => {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :gsi1pk AND begins_with(gsi1sk, :prefix)",
          ExpressionAttributeValues: { ":gsi1pk": courseGsi1pk, ":prefix": nameKeyPrefix },
          Limit: limit,
        }),
      );
      // Items are INCLUDE-projected to `name` only (plus the base table's key attributes,
      // always projected regardless of ProjectionType) — courseId parses from `pk`
      // (courseIdFromPk), never a separate stored `courseId` attribute.
      return (result.Items ?? []).map((item) => ({
        courseId: courseIdFromPk(item.pk as string),
        name: item.name as string,
      }));
    },
  };
};
