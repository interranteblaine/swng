import { PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import type { BroadcastPort } from "@swng/application";
import type { RoundId } from "@swng/domain";
import type { ApiGatewayBroadcastConfig } from "./config";

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
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createApiGatewayBroadcastPort(
  config: ApiGatewayBroadcastConfig
): BroadcastPort {
  const { connectionRepo, client, logger } = config;

  async function sendToRound(
    roundId: RoundId,
    payload: unknown
  ): Promise<void> {
    let connections = await connectionRepo.listConnections(roundId);
    if (!connections.length) {
      await sleep(150);
      connections = await connectionRepo.listConnections(roundId);
      if (!connections.length) return;
    }

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
              logger?.warn?.("Failed to prune stale connection", {
                roundId,
                connectionId: conn.connectionId,
                pruneErr,
              });
            }
          } else {
            logger?.warn?.("Failed to broadcast to connection", {
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
    async notify(roundId: RoundId, message: unknown): Promise<void> {
      await sendToRound(roundId, message);
    },
  };
}
