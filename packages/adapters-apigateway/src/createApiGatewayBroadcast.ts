import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import type { RoundEvent, RoundId } from "@swng/domain";
import type { Broadcast, ConnectionRegistry, Logger } from "@swng/application";
import type { WsEnvelope } from "@swng/contracts";

// Delivery sugar, not the correctness path (architecture.md §3) — a use case's publish must
// never fail because a socket went away or API Gateway hiccuped. Every connection's
// PostToConnection is isolated via allSettled so one bad connection can't shadow the rest,
// and every rejection is absorbed here: a stale connection (GoneException/410) self-heals
// the registry so future publishes stop paying for it; anything else is logged, never thrown.
export const createApiGatewayBroadcast = (config: { client: ApiGatewayManagementApiClient; connections: ConnectionRegistry; logger: Logger }): Broadcast => {
  const { client, connections, logger } = config;

  return {
    publish: async (roundId: RoundId, events: readonly RoundEvent[]): Promise<void> => {
      if (events.length === 0) return;

      const connectionIds = await connections.listByRound(roundId);
      if (connectionIds.length === 0) return;

      const envelope: WsEnvelope = { type: "events", roundId, events };
      const data = JSON.stringify(envelope);

      const outcomes = await Promise.allSettled(
        connectionIds.map((connectionId) => client.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: data }))),
      );

      await Promise.all(
        outcomes.map(async (outcome, index) => {
          if (outcome.status === "fulfilled") return;
          const connectionId = connectionIds[index]!; // outcomes and connectionIds are the same length, index-aligned by construction
          if (outcome.reason instanceof GoneException) {
            await connections.deregister(connectionId);
            return;
          }
          logger.error("createApiGatewayBroadcast: PostToConnection failed", {
            roundId,
            connectionId,
            error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          });
        }),
      );
    },
  };
};
