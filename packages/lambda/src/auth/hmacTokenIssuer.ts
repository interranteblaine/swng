import { createHmac, timingSafeEqual } from "node:crypto";
import { golferId, roundId } from "@swng/domain";
import type { Clock, ParticipantClaims, TokenIssuer } from "@swng/application";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface TokenPayload {
  readonly roundId: string;
  readonly golferId: string;
  readonly exp: number;
}

const sign = (secret: string, encodedPayload: string): string => createHmac("sha256", secret).update(encodedPayload).digest("base64url");

const isTokenPayload = (value: unknown): value is TokenPayload =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Partial<TokenPayload>).roundId === "string" &&
  typeof (value as Partial<TokenPayload>).golferId === "string" &&
  typeof (value as Partial<TokenPayload>).exp === "number";

// node:crypto is legal here (lambda is server-only) — graduates to an adapter package only
// when a second consumer exists (M3 plan). Token shape: base64url(JSON{roundId,golferId,exp})
// + "." + base64url(hmacSha256(secret, payload)); verify is timingSafeEqual on the signature
// plus `exp > clock.now()` — never a naive wall-clock read (conventions §4), always via Clock.
export const createHmacTokenIssuer = (config: { secret: string; clock: Clock; ttlMs?: number }): TokenIssuer => {
  const { secret, clock } = config;
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;

  return {
    issue: (claims: ParticipantClaims): string => {
      const payload: TokenPayload = { roundId: claims.roundId, golferId: claims.golferId, exp: clock.now() + ttlMs };
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
      return `${encodedPayload}.${sign(secret, encodedPayload)}`;
    },

    verify: (token: string): ParticipantClaims | undefined => {
      const parts = token.split(".");
      if (parts.length !== 2) return undefined;
      const [encodedPayload, signature] = parts as [string, string];

      // Constant-time compare, but only once the lengths already match — timingSafeEqual
      // throws on a length mismatch rather than returning false, so a garbage/short
      // signature (never issued by this issuer) must be rejected before it's called.
      const expected = Buffer.from(sign(secret, encodedPayload));
      const actual = Buffer.from(signature);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;

      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
      } catch {
        return undefined;
      }
      if (!isTokenPayload(parsed)) return undefined;
      if (parsed.exp <= clock.now()) return undefined;

      return { roundId: roundId(parsed.roundId), golferId: golferId(parsed.golferId) };
    },
  };
};
