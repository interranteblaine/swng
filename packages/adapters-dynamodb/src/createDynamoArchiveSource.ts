import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { RoundArchive } from "@swng/domain";
import type { ArchiveSource } from "@swng/application";
import { archiveSk } from "./keys.js";

// rebuildProjections' ArchiveSource (M7 Task 4) — manual-invoke only (the rebuild entry, never
// a hot path), so a full table Scan filtered server-side to ARCHIVE items is acceptable at
// swng's documented scale (architecture.md §3: "a few thousand events across an afternoon").
// There's no GSI to Query instead: sk === "ARCHIVE" is shared by every round's single archive
// item, but pk varies per round, so a Scan is the only way to find them all.
export const createDynamoArchiveSource = (config: { client: DynamoDBDocumentClient; tableName: string }): ArchiveSource => {
  const { client, tableName } = config;

  return {
    listArchives: async function* (): AsyncIterable<RoundArchive> {
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const result = await client.send(
          new ScanCommand({
            TableName: tableName,
            FilterExpression: "sk = :archiveSk",
            ExpressionAttributeValues: { ":archiveSk": archiveSk },
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );
        for (const item of result.Items ?? []) {
          yield (item as { archive: RoundArchive }).archive;
        }
        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);
    },
  };
};
