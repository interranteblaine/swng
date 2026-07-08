import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { buildApp } from "../compositionRoot.js";

// Composition happens ONCE at module scope (cold start) — see entries/http.ts.
const app = buildApp(process.env);

// $disconnect: always succeeds — a connection that was never registered (e.g. it never
// completed $connect) is simply a no-op deregister, not an error condition.
export const handler = async (event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> => {
  await app.registry.deregister(event.requestContext.connectionId);
  return { statusCode: 200, body: "disconnected" };
};
