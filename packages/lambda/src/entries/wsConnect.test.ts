import { beforeAll, describe, expect, it } from "vitest";
import type { APIGatewayProxyStructuredResultV2, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { crewId, golferId } from "@swng/domain";
import { createFixedClock } from "@swng/application";
import { createHmacTokenIssuer } from "../auth/hmacTokenIssuer.js";

// Crew membership (invited in, accountable out): wsConnect's own subscribe gate is one of the
// three roundId-consuming verifiers TokenClaims' own doc comment (ports/tokenIssuer.ts) calls
// out by name — a crew-invite token verifies fine (it's a REAL, authentic bearer) but carries
// no roundId at all, so it must be rejected as if no usable token had been presented, never let
// through to `claims.roundId` (which the crew-invite variant doesn't even have — a TS
// compile-time guarantee this test proves holds at runtime too).
//
// wsConnect.ts builds its whole `app` (compositionRoot's buildApp) ONCE at module scope (its
// own doc comment: "Composition happens ONCE at module scope (cold start)") — env vars must be
// set BEFORE the dynamic import below runs. buildApp never makes a network call at construction
// time (compositionRoot.test.ts's own "TABLE_CORE/TABLE_PROJECTIONS/... are optional" suites
// prove this directly, calling buildApp with a plain env object and asserting it doesn't throw)
// — only an ACTUAL registry write would, and this suite never reaches one: every case here is
// a REJECTION, returned before `app.registry.register` is ever called.
const TOKEN_SECRET = "ws-connect-test-secret";

let handler: (event: APIGatewayProxyWebsocketEventV2) => Promise<APIGatewayProxyStructuredResultV2>;

beforeAll(async () => {
  process.env["TABLE_ROUNDS"] = "rounds-table";
  process.env["TABLE_CONNECTIONS"] = "connections-table";
  process.env["TOKEN_SECRET"] = TOKEN_SECRET;
  process.env["WS_ENDPOINT"] = "https://example.execute-api.us-east-1.amazonaws.com/test";
  const mod = await import("./wsConnect.js");
  handler = mod.handler as typeof handler;
});

// The SAME HMAC mechanism wsConnect's own app.tokens uses (createHmacTokenIssuer, keyed by the
// SAME TOKEN_SECRET) — a standalone instance, since wsConnect.ts exports no seam to reach its
// own app.tokens directly.
const tokens = createHmacTokenIssuer({ secret: TOKEN_SECRET, clock: createFixedClock(1_000) });

const makeEvent = (token?: string): APIGatewayProxyWebsocketEventV2 =>
  ({
    requestContext: { connectionId: "conn-1" },
    queryStringParameters: token ? { token } : undefined,
  }) as unknown as APIGatewayProxyWebsocketEventV2;

describe("wsConnect handler — crew-invite tokens never open a socket", () => {
  it("401s a crew-invite token — a real, authentic bearer, but not a round-scoped one (spec §2)", async () => {
    const crewInviteToken = tokens.issue({
      scope: "crew-invite",
      crewId: crewId("crew-1"),
      inviterGolferId: golferId("golfer-1"),
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    });

    const result = await handler(makeEvent(crewInviteToken));
    expect(result.statusCode).toBe(401);
  });

  // Pre-existing behavior, unaffected — pinned here too so a future edit to the crew-invite
  // check can't accidentally widen (or narrow) the gate for these.
  it("401s with no token at all", async () => {
    const result = await handler(makeEvent());
    expect(result.statusCode).toBe(401);
  });

  it("401s a garbage token", async () => {
    const result = await handler(makeEvent("not-a-real-token"));
    expect(result.statusCode).toBe(401);
  });
});
