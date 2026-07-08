import { describe, expect, it } from "vitest";
import { golferId, roundId } from "@swng/domain";
import { createFixedClock } from "@swng/application";
import type { ParticipantClaims } from "@swng/application";
import { createHmacTokenIssuer } from "./hmacTokenIssuer.js";

const claims: ParticipantClaims = { roundId: roundId("round-1"), golferId: golferId("golfer-1") };

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
