import type { DynamoDBDocumentClient, QueryCommandInput } from "@aws-sdk/lib-dynamodb";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

// The one ExclusiveStartKey pagination loop (conventions §0: "the second instance, build the
// general version") — journal.read (createDynamoEventJournal.ts) and registry.listByRound
// (createDynamoConnectionRegistry.ts) both page a Query to exhaustion, and used to duplicate
// this loop verbatim (M3 final review deferral, task-6-report.md) until this extraction.
// `mapItem` narrows each raw page Item to whatever the caller actually wants (an event, a
// connectionId, …); callers pass every Query param except ExclusiveStartKey, which this owns.
export const queryAllPages = async <T>(
  client: DynamoDBDocumentClient,
  input: Omit<QueryCommandInput, "ExclusiveStartKey">,
  mapItem: (item: Record<string, unknown>) => T,
): Promise<T[]> => {
  const results: T[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey }));
    for (const item of result.Items ?? []) results.push(mapItem(item));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return results;
};
