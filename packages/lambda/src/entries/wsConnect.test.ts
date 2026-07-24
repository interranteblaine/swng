import { beforeAll, describe, expect, it, vi } from "vitest";
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
// wsConnect.ts builds its whole `app` (compositionRoot's buildApp) lazily, on the handler's
// FIRST invocation, cached for the module's lifetime (its own doc comment) — env vars must be
// set BEFORE the dynamic import below runs, same as before Task 4. Task 4 made buildApp async:
// it now awaits the token-signing secret from Secrets Manager, so this suite mocks
// @swng/adapters-secretsmanager's createSecretsManagerReader (below) rather than letting
// wsConnect's own default reader make a real AWS call — every case here is still a REJECTION,
// returned before `app.registry.register` (the one call that would need a real DynamoDB) is
// ever reached.
const TOKEN_SECRET = vi.hoisted(() => "ws-connect-test-secret");

// Hoisted (vi.mock factories run before this file's own top-level code, Vitest's own
// documented ordering) — wsConnect.ts's lazy buildApp() call uses the REAL default reader
// (no injected seam at the entry level, by design: entries/http.ts's own doc comment), so the
// module it comes from is mocked here instead, the same "swap the technology, not the port"
// idea @swng/adapters-secretsmanager itself exists for.
vi.mock("@swng/adapters-secretsmanager", () => ({
  createSecretsManagerReader: () => async (_arn: string): Promise<string> => TOKEN_SECRET,
}));

let handler: (event: APIGatewayProxyWebsocketEventV2) => Promise<APIGatewayProxyStructuredResultV2>;

beforeAll(async () => {
  process.env["TABLE_ROUNDS"] = "rounds-table";
  process.env["TABLE_CONNECTIONS"] = "connections-table";
  process.env["TOKEN_SECRET_ARN"] = "arn:aws:secretsmanager:us-east-1:111122223333:secret:swng-token-secret-test";
  process.env["WS_ENDPOINT"] = "https://example.execute-api.us-east-1.amazonaws.com/test";
  const mod = await import("./wsConnect.js");
  handler = mod.handler as typeof handler;
});

// The SAME HMAC mechanism wsConnect's own app.tokens uses (createHmacTokenIssuer, keyed by the
// SAME TOKEN_SECRET the mocked reader above resolves) — a standalone instance, since
// wsConnect.ts exports no seam to reach its own app.tokens directly.
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
