import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { RoundId, Score } from "@swng/domain";
import type { ScoreRepository } from "@swng/application";
import { roundPk, SCORE_SK_PREFIX } from "./keys";
import type { DynamoConfig } from "./config";
import { ScoreItem, toScoreItem, fromScoreItem } from "./scoreItems";

export function createDynamoScoreRepository(
  config: DynamoConfig
): ScoreRepository {
  const { tableName, docClient } = config;

  async function upsertScore(score: Score): Promise<void> {
    const item: ScoreItem = toScoreItem(score);

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );
  }

  async function listScores(roundId: RoundId): Promise<Score[]> {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": roundPk(roundId),
          ":skPrefix": SCORE_SK_PREFIX,
        },
      })
    );

    const items = (result.Items ?? []) as ScoreItem[];
    return items.map(fromScoreItem);
  }

  return {
    upsertScore,
    listScores,
  };
}
