import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import type { RoundEvent, RoundId } from "@swng/domain";
import type { Broadcast, ConnectionRegistry, Logger } from "@swng/application";
import type { WsEnvelope } from "@swng/contracts";

// Delivery sugar, not the correctness path (architecture.md §3) — a use case's publish must
// never fail because a socket went away or API Gateway hiccuped, and that guarantee has to
// cover the WHOLE body, not just the send fan-out: a registry blip in listByRound or
// deregister is exactly as much "delivery infrastructure had a bad day" as a dead socket,
// and must never propagate out and turn an already-persisted command into a 500. Every
// connection's PostToConnection is isolated via allSettled so one bad connection can't
// shadow the rest, and every rejection is absorbed here: a stale connection
// (GoneException/410) self-heals the registry so future publishes stop paying for it;
// anything else — including a registry failure itself — is logged, never thrown.
export const createApiGatewayBroadcast = (config: { client: ApiGatewayManagementApiClient; connections: ConnectionRegistry; logger: Logger }): Broadcast => {
  const { client, connections, logger } = config;

  return {
    publish: async (roundId: RoundId, events: readonly RoundEvent[]): Promise<void> => {
      if (events.length === 0) return;

      try {
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
              try {
                await connections.deregister(connectionId);
              } catch (error) {
                logger.error("createApiGatewayBroadcast: deregister failed", {
                  roundId,
                  connectionId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
              return;
            }
            logger.error("createApiGatewayBroadcast: PostToConnection failed", {
              roundId,
              connectionId,
              error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
            });
          }),
        );
      } catch (error) {
        // Anything unguarded above (listByRound, JSON.stringify, the allSettled/Promise.all
        // plumbing itself) lands here instead of rejecting publish() — logged, never thrown.
        logger.error("createApiGatewayBroadcast: publish failed", {
          roundId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
};
