import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type {
  RoundConfig,
  RoundId,
  RoundSnapshot,
  RoundState,
  Player,
  Score,
} from "@swng/domain";
import type { RoundRepository } from "@swng/application";
import { ApplicationError } from "@swng/application";
import {
  roundPk,
  CONFIG_SK,
  STATE_SK,
  PLAYER_SK_PREFIX,
  SCORE_SK_PREFIX,
  codeGsiPk,
  GSI1_NAME,
} from "./keys";
import {
  RoundConfigItem,
  RoundStateItem,
  fromConfigItem,
  fromStateItem,
  toConfigItem,
  toStateItem,
} from "./roundItems";
import { fromPlayerItem, PlayerItem } from "./playerItems";
import { fromScoreItem, ScoreItem } from "./scoreItems";
import { DynamoConfig } from "./config";

export function createDynamoRoundRepository(
  config: DynamoConfig
): RoundRepository {
  const { tableName, docClient } = config;

  async function getRoundSnapshot(
    roundId: RoundId
  ): Promise<RoundSnapshot | null> {
    const pk = roundPk(roundId);

    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: {
          ":pk": pk,
        },
      })
    );

    const items = result.Items ?? [];
    if (items.length === 0) {
      return null;
    }

    let configItem: RoundConfigItem | undefined;
    let stateItem: RoundStateItem | undefined;
    const playerItems: PlayerItem[] = [];
    const scoreItems: ScoreItem[] = [];

    for (const raw of items) {
      const sk = raw.SK as string;
      if (sk === CONFIG_SK) {
        configItem = raw as RoundConfigItem;
      } else if (sk === STATE_SK) {
        stateItem = raw as RoundStateItem;
      } else if (sk.startsWith(PLAYER_SK_PREFIX)) {
        playerItems.push(raw as PlayerItem);
      } else if (sk.startsWith(SCORE_SK_PREFIX)) {
        scoreItems.push(raw as ScoreItem);
      }
    }

    if (!configItem || !stateItem) {
      return null;
    }

    const configDomain: RoundConfig = fromConfigItem(configItem);
    const stateDomain: RoundState = fromStateItem(stateItem);
    const players: Player[] = playerItems.map(fromPlayerItem);
    const scores: Score[] = scoreItems.map(fromScoreItem);

    return {
      config: configDomain,
      state: stateDomain,
      players,
      scores,
    };
  }

  async function getRoundSnapshotByAccessCode(
    accessCode: string
  ): Promise<{ roundId: RoundId; snapshot: RoundSnapshot } | null> {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: GSI1_NAME,
        KeyConditionExpression: "GSI1PK = :gpk",
        ExpressionAttributeValues: {
          ":gpk": codeGsiPk(accessCode),
        },
        Limit: 1,
      })
    );

    const rawConfig = result.Items?.[0] as RoundConfigItem | undefined;
    if (!rawConfig) return null;

    const roundId = rawConfig.roundId;
    const snapshot = await getRoundSnapshot(roundId);
    if (!snapshot) return null;

    return { roundId, snapshot };
  }

  async function saveConfig(configDomain: RoundConfig): Promise<void> {
    const item = toConfigItem(configDomain);

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );
  }

  async function saveState(
    stateDomain: RoundState,
    expectedVersion?: number
  ): Promise<void> {
    const item = toStateItem(stateDomain);

    try {
      if (expectedVersion === undefined) {
        // Initial write: ensure the state item does not already exist
        await docClient.send(
          new PutCommand({
            TableName: tableName,
            Item: item,
            ConditionExpression: "attribute_not_exists(PK)",
          })
        );
      } else {
        // Update write: ensure we're writing over the version we observed
        await docClient.send(
          new PutCommand({
            TableName: tableName,
            Item: item,
            ConditionExpression: "stateVersion = :prevVersion",
            ExpressionAttributeValues: {
              ":prevVersion": expectedVersion,
            },
          })
        );
      }
    } catch (err: unknown) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new ApplicationError("CONFLICT", "State version mismatch");
      }
      throw err;
    }
  }

  return {
    getRoundSnapshot,
    getRoundSnapshotByAccessCode,
    saveConfig,
    saveState,
  };
}
