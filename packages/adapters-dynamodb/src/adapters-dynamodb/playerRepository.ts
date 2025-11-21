import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Player, PlayerId, RoundId } from "@swng/domain";
import type { PlayerRepository } from "@swng/application";
import { roundPk, PLAYER_SK_PREFIX, playerSk } from "./keys";
import type { DynamoConfig } from "./config";
import { PlayerItem, toPlayerItem, fromPlayerItem } from "./playerItems";

export function createDynamoPlayerRepository(
  config: DynamoConfig
): PlayerRepository {
  const { tableName, docClient } = config;

  async function createPlayer(player: Player): Promise<void> {
    const item: PlayerItem = toPlayerItem(player);

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression:
          "attribute_not_exists(PK) AND attribute_not_exists(SK)",
      })
    );
  }

  async function updatePlayer(player: Player): Promise<void> {
    const item: PlayerItem = toPlayerItem(player);

    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );
  }

  async function getPlayer(
    roundId: RoundId,
    playerId: PlayerId
  ): Promise<Player | null> {
    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: roundPk(roundId),
          SK: playerSk(playerId),
        },
      })
    );

    const raw = result.Item as PlayerItem | undefined;
    if (!raw) return null;

    return fromPlayerItem(raw);
  }

  async function listPlayers(roundId: RoundId): Promise<Player[]> {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": roundPk(roundId),
          ":skPrefix": PLAYER_SK_PREFIX,
        },
      })
    );

    const items = (result.Items ?? []) as PlayerItem[];
    return items.map(fromPlayerItem);
  }

  return {
    createPlayer,
    updatePlayer,
    getPlayer,
    listPlayers,
  };
}
