import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { buildApp } from "../compositionRoot.js";

// Composition happens ONCE at module scope (cold start) — see entries/http.ts.
const app = buildApp(process.env);

// $connect: the WS handshake carries the participant token as a query param (`?token=`),
// not a header — API Gateway's WebSocket protocol has no room for one at connect time. The
// token's roundId becomes the subscription (registry.register), never a value the client
// picks independently; API Gateway rejects the upgrade outright on a non-2xx response, so
// an unverifiable token never reaches the registry at all.
export const handler = async (event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> => {
  const token = event.queryStringParameters?.["token"];
  const claims = token ? app.tokens.verify(token) : undefined;
  if (!claims) return { statusCode: 401, body: "invalid token" };

  await app.registry.register(event.requestContext.connectionId, claims.roundId);
  return { statusCode: 200, body: "connected" };
};
