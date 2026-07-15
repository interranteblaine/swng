import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { crewId, golferId, roundId } from "@swng/domain";
import { createFixedClock } from "@swng/application";
import type { TokenClaims } from "@swng/application";
import { createHmacTokenIssuer } from "./hmacTokenIssuer.js";

const claims: TokenClaims = { scope: "participant", roundId: roundId("round-1"), golferId: golferId("golfer-1") };

describe("createHmacTokenIssuer", () => {
  it("round-trips issued claims through verify", () => {
    const tokens = createHmacTokenIssuer({ secret: "swng-secret", clock: createFixedClock(1_000) });
    const token = tokens.issue(claims);
    expect(tokens.verify(token)).toEqual(claims);
  });

  it("rejects a token whose payload segment was tampered with", () => {
    const tokens = createHmacTokenIssuer({ secret: "swng-secret", clock: createFixedClock(1_000) });
    const token = tokens.issue(claims);
    const [, signature] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ roundId: "round-EVIL", golferId: "golfer-1", exp: Number.MAX_SAFE_INTEGER })).toString(
      "base64url",
    );
    expect(tokens.verify(`${forgedPayload}.${signature}`)).toBeUndefined();
  });

  it("rejects a token whose signature segment was tampered with", () => {
    const tokens = createHmacTokenIssuer({ secret: "swng-secret", clock: createFixedClock(1_000) });
    const token = tokens.issue(claims);
    const [payload] = token.split(".");
    expect(tokens.verify(`${payload}.not-the-real-signature`)).toBeUndefined();
  });

  it("rejects an expired token once the clock has advanced past its ttl", () => {
    const clock = createFixedClock(0);
    const tokens = createHmacTokenIssuer({ secret: "swng-secret", clock, ttlMs: 100 });
    const token = tokens.issue(claims);
    for (let i = 0; i < 200; i += 1) clock.now(); // fixed clock ticks 1ms per read — walk it well past the 100ms ttl
    expect(tokens.verify(token)).toBeUndefined();
  });

  it("rejects a token issued by a different secret", () => {
    const clock = createFixedClock(1_000);
    const issued = createHmacTokenIssuer({ secret: "swng-secret", clock }).issue(claims);
    const verifier = createHmacTokenIssuer({ secret: "a-different-secret", clock });
    expect(verifier.verify(issued)).toBeUndefined();
  });

  it("rejects a malformed token (no signature segment)", () => {
    const tokens = createHmacTokenIssuer({ secret: "swng-secret", clock: createFixedClock(1_000) });
    expect(tokens.verify("not-a-token")).toBeUndefined();
  });
});

// M9 Task 3 (share): a spectator token — same signer, a narrower capability. Deterministic
// (no randomness/timestamp in its payload) and non-expiring (no `exp` field at all) by design
// — see hmacTokenIssuer.ts's own doc comment for why that's the deliberate v1 shape, not an
// oversight (no revocation in v1; that's a ship-milestone ledger line).
describe("createHmacTokenIssuer — spectator scope", () => {
  const spectatorClaims: TokenClaims = { scope: "spectator", roundId: roundId("round-1") };

  it("round-trips spectator claims through verify", () => {
    const tokens = createHmacTokenIssuer({ secret: "swng-secret", clock: createFixedClock(1_000) });
    const token = tokens.issue(spectatorClaims);
    expect(tokens.verify(token)).toEqual(spectatorClaims);
  });

  it("is byte-identical across repeat issues for the same round — the immortal link IS the token", () => {
    const tokens = createHmacTokenIssuer({ secret: "swng-secret", clock: createFixedClock(1_000) });
    expect(tokens.issue(spectatorClaims)).toBe(tokens.issue(spectatorClaims));
  });

  it("never expires — still verifies no matter how far the clock has advanced", () => {
    const clock = createFixedClock(0);
    const tokens = createHmacTokenIssuer({ secret: "swng-secret", clock, ttlMs: 100 });
    const token = tokens.issue(spectatorClaims);
    for (let i = 0; i < 10_000; i += 1) clock.now(); // walk WAY past any participant ttl
    expect(tokens.verify(token)).toEqual(spectatorClaims);
  });

  it("rejects a tampered spectator payload (wrong round spliced in)", () => {
    const tokens = createHmacTokenIssuer({ secret: "swng-secret", clock: createFixedClock(1_000) });
    const token = tokens.issue(spectatorClaims);
    const [, signature] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ scope: "spectator", roundId: "round-EVIL" })).toString("base64url");
    expect(tokens.verify(`${forgedPayload}.${signature}`)).toBeUndefined();
  });

  it("rejects a spectator token issued by a different secret", () => {
    const clock = createFixedClock(1_000);
    const issued = createHmacTokenIssuer({ secret: "swng-secret", clock }).issue(spectatorClaims);
    const verifier = createHmacTokenIssuer({ secret: "a-different-secret", clock });
    expect(verifier.verify(issued)).toBeUndefined();
  });

  // Backward compat (brief, binding): a token minted by the PRE-M9 issuer has no `scope` key
  // in its JSON payload at all (the old TokenPayload shape was just {roundId, golferId, exp})
  // — hand-built here with the SAME hmac mechanism createHmacTokenIssuer uses internally (sign
  // isn't exported; this mirrors the "tampered signature" tests' own precedent of hand-rolling
  // a payload/signature pair) rather than issue()'s own leading-edge shape.
  it("verifies a pre-M9 payload with no scope field as a participant", () => {
    const secret = "swng-secret";
    const legacyPayload = { roundId: "round-1", golferId: "golfer-1", exp: Number.MAX_SAFE_INTEGER };
    const encodedPayload = Buffer.from(JSON.stringify(legacyPayload)).toString("base64url");
    const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
    const legacyToken = `${encodedPayload}.${signature}`;

    const tokens = createHmacTokenIssuer({ secret, clock: createFixedClock(1_000) });
    expect(tokens.verify(legacyToken)).toEqual({ scope: "participant", roundId: roundId("round-1"), golferId: golferId("golfer-1") });
  });

  it("a participant token still expires (unlike a spectator token) — ttl unaffected by the scope tag", () => {
    const clock = createFixedClock(0);
    const tokens = createHmacTokenIssuer({ secret: "swng-secret", clock, ttlMs: 100 });
    const token = tokens.issue(claims); // claims = scope: "participant"
    for (let i = 0; i < 200; i += 1) clock.now();
    expect(tokens.verify(token)).toBeUndefined();
  });
});

// Crew membership (invited in, accountable out): a crew-invite token — same signer, a third
// scope. `expiresAtMs` rides as a plain, inspectable claim (unlike participant's hidden `exp`)
// and verify() deliberately does NOT gate on it — see hmacTokenIssuer.ts's own doc comment and
// TokenClaims' (ports/tokenIssuer.ts) for why: peekCrewInvite/joinCrewByInvite need "expired"
// and "otherwise invalid" as two DIFFERENT wire codes, so expiry enforcement for this scope
// lives one level up, in the calling use case's own Clock — this suite pins the issuer's own
// half of that split (round-trips, rejects tamper/wrong-secret, never itself gates on time).
describe("createHmacTokenIssuer — crew-invite scope", () => {
  const crewInviteClaims: TokenClaims = {
    scope: "crew-invite",
    crewId: crewId("crew-1"),
    inviterGolferId: golferId("golfer-1"),
    expiresAtMs: 1_000_000,
  };

  it("round-trips crew-invite claims through verify", () => {
    const tokens = createHmacTokenIssuer({ secret: "swng-secret", clock: createFixedClock(1_000) });
    const token = tokens.issue(crewInviteClaims);
    expect(tokens.verify(token)).toEqual(crewInviteClaims);
  });

  // The deliberate half of the split above: verify() itself never compares expiresAtMs to the
  // clock, so a token whose claimed expiresAtMs is already WAY in the past still round-trips
  // cleanly here — the issuer's job stops at "is this authentic", not "is this still good".
  it("does NOT reject an expired crew-invite at the issuer boundary — verify() still returns the claims verbatim", () => {
    const clock = createFixedClock(10_000_000); // far past crewInviteClaims.expiresAtMs
    const tokens = createHmacTokenIssuer({ secret: "swng-secret", clock });
    const token = tokens.issue(crewInviteClaims);
    expect(tokens.verify(token)).toEqual(crewInviteClaims);
  });

  it("rejects a tampered crew-invite payload (wrong crewId spliced in)", () => {
    const tokens = createHmacTokenIssuer({ secret: "swng-secret", clock: createFixedClock(1_000) });
    const token = tokens.issue(crewInviteClaims);
    const [, signature] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ scope: "crew-invite", crewId: "crew-EVIL", inviterGolferId: "golfer-1", expiresAtMs: 1_000_000 }),
    ).toString("base64url");
    expect(tokens.verify(`${forgedPayload}.${signature}`)).toBeUndefined();
  });

  it("rejects a crew-invite token issued by a different secret", () => {
    const clock = createFixedClock(1_000);
    const issued = createHmacTokenIssuer({ secret: "swng-secret", clock }).issue(crewInviteClaims);
    const verifier = createHmacTokenIssuer({ secret: "a-different-secret", clock });
    expect(verifier.verify(issued)).toBeUndefined();
  });

  it("rejects a malformed crew-invite payload (expiresAtMs missing)", () => {
    const tokens = createHmacTokenIssuer({ secret: "swng-secret", clock: createFixedClock(1_000) });
    const token = tokens.issue(crewInviteClaims);
    const [, signature] = token.split(".");
    const malformedPayload = Buffer.from(JSON.stringify({ scope: "crew-invite", crewId: "crew-1", inviterGolferId: "golfer-1" })).toString(
      "base64url",
    );
    expect(tokens.verify(`${malformedPayload}.${signature}`)).toBeUndefined();
  });
});
