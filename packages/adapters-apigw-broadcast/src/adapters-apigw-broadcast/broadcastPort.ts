import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import type { BroadcastPort, Logger } from "@swng/application";
import type { Player, Score, RoundState, RoundId } from "@swng/domain";
import type { ApiGatewayBroadcastConfig } from "./config";
import { noopLogger } from "./config";

function buildClient(
  cfg: ApiGatewayBroadcastConfig
): ApiGatewayManagementApiClient {
  if (cfg.client) return cfg.client;
  return new ApiGatewayManagementApiClient({
    region: cfg.region,
    endpoint: cfg.endpoint,
  });
}

function isGone(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  if ("name" in err && err.name === "GoneException") return true;

  if (
    "$metadata" in err &&
    err.$metadata &&
    typeof err.$metadata === "object" &&
    "httpStatusCode" in err.$metadata &&
    err.$metadata.httpStatusCode === 410
  ) {
    return true;
  }

  return false;
}

function encode(message: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(message));
}

export function createApiGatewayBroadcastPort(
  config: ApiGatewayBroadcastConfig
): BroadcastPort {
  const client = buildClient(config);
  const logger: Logger = config.logger ?? noopLogger;
  const { connectionRepo } = config;

  async function sendToRound(
    roundId: RoundId,
    payload: unknown
  ): Promise<void> {
    const connections = await connectionRepo.listConnections(roundId);
    if (!connections.length) return;

    const data = encode(payload);

    await Promise.allSettled(
      connections.map(async (conn) => {
        try {
          await client.send(
            new PostToConnectionCommand({
              ConnectionId: conn.connectionId,
              Data: data,
            })
          );
        } catch (err) {
          if (isGone(err)) {
            // prune stale connections
            try {
              await connectionRepo.removeConnection(roundId, conn.connectionId);
            } catch (pruneErr) {
              logger.warn?.("Failed to prune stale connection", {
                roundId,
                connectionId: conn.connectionId,
                pruneErr,
              });
            }
          } else {
            logger.warn?.("Failed to broadcast to connection", {
              roundId,
              connectionId: conn.connectionId,
              err,
            });
          }
        }
      })
    );
  }

  return {
    async broadcastPlayerJoined(
      roundId: RoundId,
      player: Player
    ): Promise<void> {
      await sendToRound(roundId, { type: "PlayerJoined", player });
    },

    async broadcastPlayerUpdated(
      roundId: RoundId,
      player: Player
    ): Promise<void> {
      await sendToRound(roundId, { type: "PlayerUpdated", player });
    },

    async broadcastScoreChanged(roundId: RoundId, score: Score): Promise<void> {
      await sendToRound(roundId, { type: "ScoreChanged", score });
    },

    async broadcastRoundStateChanged(
      roundId: RoundId,
      state: RoundState
    ): Promise<void> {
      await sendToRound(roundId, { type: "RoundStateChanged", state });
    },
  };
}
