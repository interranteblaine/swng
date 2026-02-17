import { DeleteCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { PlayerId, RoundId, Score } from "@swng/domain";
import type { ScoreRepository } from "@swng/application";
import { roundPk, scoreSk, SCORE_SK_PREFIX } from "./keys";
import type { DynamoConfig } from "./config";
import { ScoreItem, toScoreItem, fromScoreItem } from "./scoreItems";

export function createDynamoScoreRepository(
  config: DynamoConfig
): ScoreRepository {
  const { tableName, docClient, logger } = config;

  async function upsertScore(score: Score): Promise<void> {
    const item: ScoreItem = toScoreItem(score);

    logger?.debug("DDB upsertScore", {
      tableName,
      roundId: score.roundId,
      playerId: score.playerId,
      holeNumber: score.holeNumber,
    });

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );
  }

  async function deleteScore(roundId: RoundId, playerId: PlayerId, holeNumber: number): Promise<void> {
    logger?.debug("DDB deleteScore", {
      tableName,
      roundId,
      playerId,
      holeNumber,
    });

    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: roundPk(roundId),
          SK: scoreSk(playerId, holeNumber),
        },
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
    const scores = items.map(fromScoreItem);
    logger?.debug("DDB listScores", {
      tableName,
      roundId,
      count: scores.length,
    });
    return scores;
  }

  return {
    upsertScore,
    deleteScore,
    listScores,
  };
}
