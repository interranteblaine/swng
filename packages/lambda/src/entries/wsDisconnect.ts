import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { buildApp } from "../compositionRoot.js";
import type { App } from "../compositionRoot.js";

// Composition happens ONCE per cold start — see entries/http.ts's own doc comment (buildApp
// is async since Task 4; a cached Promise replaces the old synchronous module-scope call).
let appPromise: Promise<App> | undefined;

// $disconnect: always succeeds — a connection that was never registered (e.g. it never
// completed $connect) is simply a no-op deregister, not an error condition.
export const handler = async (event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> => {
  // See entries/http.ts's own doc comment: a rejected cold-start secret fetch must not poison
  // the warm container — clearing appPromise back to undefined before rethrowing makes the next
  // invocation retry buildApp from scratch instead of replaying the same rejection forever.
  appPromise ??= buildApp(process.env).catch((e) => {
    appPromise = undefined;
    throw e;
  });
  const app = await appPromise;
  await app.registry.deregister(event.requestContext.connectionId);
  return { statusCode: 200, body: "disconnected" };
};
