import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { buildApp } from "../compositionRoot.js";
import type { App } from "../compositionRoot.js";

// Composition happens ONCE per cold start — see entries/http.ts's own doc comment (buildApp
// is async since Task 4; a cached Promise replaces the old synchronous module-scope call).
let appPromise: Promise<App> | undefined;

// $connect: the WS handshake carries a round token as a query param (`?token=`), not a
// header — API Gateway's WebSocket protocol has no room for one at connect time. Either
// scope subscribes identically (M9 Task 3, share: a spectator token's roundId works exactly
// like a participant token's here — verify() itself is the only place scope is ever checked
// for ANY route, and this route doesn't care which kind of bearer it got, only that the
// token's roundId is real) — the token's roundId becomes the subscription (registry.register),
// never a value the client picks independently; API Gateway rejects the upgrade outright on a
// non-2xx response, so an unverifiable token never reaches the registry at all.
//
// There is no $default route on this WebSocket API (swngStack.ts's own comment: "every WS
// message this system sends is server -> client broadcast, never client -> server"), so an
// inbound send — from a participant OR a spectator connection — has nowhere to route to at
// all; API Gateway answers it directly, this Lambda is never invoked for one. A spectator
// connection's write-rejection is therefore structural (no code path exists), not a runtime
// check this handler performs.
export const handler = async (event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> => {
  // See entries/http.ts's own doc comment: a rejected cold-start secret fetch must not poison
  // the warm container — clearing appPromise back to undefined before rethrowing makes the next
  // invocation retry buildApp from scratch instead of replaying the same rejection forever.
  appPromise ??= buildApp(process.env).catch((e) => {
    appPromise = undefined;
    throw e;
  });
  const app = await appPromise;

  const token = event.queryStringParameters?.["token"];
  const claims = token ? app.tokens.verify(token) : undefined;
  // Crew membership (invited in, accountable out): a crew-invite token verifies fine — it's a
  // REAL bearer — but carries no roundId at all (TokenClaims' own doc comment,
  // ports/tokenIssuer.ts, on why the union's old "every variant carries roundId" invariant no
  // longer holds). Narrowed OUT here, same 401 as no/garbage token: it opens no round, no
  // socket, nothing but a crew join — never reaches `claims.roundId` below.
  if (!claims || claims.scope === "crew-invite") return { statusCode: 401, body: "invalid token" };

  await app.registry.register(event.requestContext.connectionId, claims.roundId);
  return { statusCode: 200, body: "connected" };
};
