import { createHmac, timingSafeEqual } from "node:crypto";
import { crewId, golferId, roundId } from "@swng/domain";
import type { Clock, TokenClaims, TokenIssuer } from "@swng/application";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// A participant token's wire payload — unchanged from pre-M9 EXCEPT `scope` is now stamped
// explicitly on every freshly-issued token. `scope` is OPTIONAL here (not required) precisely
// so a payload minted by the pre-M9 issuer — {roundId, golferId, exp}, no `scope` key at all —
// still parses: isTokenPayload's own check below treats an absent scope as "participant" (the
// brief's binding backward-compat rule: a token minted before this deploy must keep working).
interface ParticipantPayload {
  readonly scope?: "participant";
  readonly roundId: string;
  readonly golferId: string;
  readonly exp: number;
}

// M9 Task 3 (share): a spectator token's wire payload — round-scoped only, no golferId (no one
// to author as), and deliberately no `exp` at all: the payload itself carries no expiry to
// compare against, which is what makes the token non-expiring rather than merely long-lived.
interface SpectatorPayload {
  readonly scope: "spectator";
  readonly roundId: string;
}

// Crew membership (invited in, accountable out): a crew-invite token's wire payload —
// `expiresAtMs` rides here as a PLAIN CLAIM, not a hidden mechanism field like
// ParticipantPayload's `exp` (never surfaced on ParticipantClaims): verify() below does NOT
// compare it to the clock — see TokenClaims' own doc comment (ports/tokenIssuer.ts) for why
// that's deliberate, not an oversight.
interface CrewInvitePayload {
  readonly scope: "crew-invite";
  readonly crewId: string;
  readonly inviterGolferId: string;
  readonly expiresAtMs: number;
}

type TokenPayload = ParticipantPayload | SpectatorPayload | CrewInvitePayload;

const sign = (secret: string, encodedPayload: string): string => createHmac("sha256", secret).update(encodedPayload).digest("base64url");

const isParticipantPayload = (value: unknown): value is ParticipantPayload =>
  typeof value === "object" &&
  value !== null &&
  ((value as Partial<ParticipantPayload>).scope === undefined || (value as Partial<ParticipantPayload>).scope === "participant") &&
  typeof (value as Partial<ParticipantPayload>).roundId === "string" &&
  typeof (value as Partial<ParticipantPayload>).golferId === "string" &&
  typeof (value as Partial<ParticipantPayload>).exp === "number";

const isSpectatorPayload = (value: unknown): value is SpectatorPayload =>
  typeof value === "object" &&
  value !== null &&
  (value as Partial<SpectatorPayload>).scope === "spectator" &&
  typeof (value as Partial<SpectatorPayload>).roundId === "string";

const isCrewInvitePayload = (value: unknown): value is CrewInvitePayload =>
  typeof value === "object" &&
  value !== null &&
  (value as Partial<CrewInvitePayload>).scope === "crew-invite" &&
  typeof (value as Partial<CrewInvitePayload>).crewId === "string" &&
  typeof (value as Partial<CrewInvitePayload>).inviterGolferId === "string" &&
  typeof (value as Partial<CrewInvitePayload>).expiresAtMs === "number";

// node:crypto is legal here (lambda is server-only) — graduates to an adapter package only
// when a second consumer exists (M3 plan). Participant token shape: base64url(JSON{roundId,
// golferId, exp[, scope]}) + "." + base64url(hmacSha256(secret, payload)); verify is
// timingSafeEqual on the signature plus `exp > clock.now()` — never a naive wall-clock read
// (conventions §4), always via Clock.
//
// M9 Task 3 (share): a spectator token is the SAME mechanism, one new scope value — issue()
// and verify() are still the ONE sign/verify path (no parallel signer). A spectator payload
// carries no `exp`, so verify() never compares it against the clock at all: the token is
// deterministic (no randomness/timestamp anywhere in the payload — the same roundId always
// produces the byte-identical token, i.e. the byte-identical share link) and non-expiring by
// construction, not by a huge ttl. No revocation in v1 (a ship-milestone ledger line).
//
// Crew membership (invited in, accountable out): a crew-invite token is the SAME mechanism
// again, a third scope value — issue()/verify() stay the ONE path (no parallel signer). Unlike
// participant, verify()'s crew-invite arm does NOT compare `expiresAtMs` to the clock at all —
// it round-trips the claim verbatim once signature+shape check out, expired or not. This is
// deliberate, not a gap: TokenClaims' own doc comment (ports/tokenIssuer.ts) explains why —
// peekCrewInvite/joinCrewByInvite need to tell "expired" apart from "otherwise unusable" as two
// different wire codes, a distinction a single undefined-collapsing verify() can't carry, so
// expiry enforcement for THIS scope lives one level up, in the calling use case's own Clock.
export const createHmacTokenIssuer = (config: { secret: string; clock: Clock; ttlMs?: number }): TokenIssuer => {
  const { secret, clock } = config;
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;

  return {
    issue: (claims: TokenClaims): string => {
      let payload: TokenPayload;
      if (claims.scope === "spectator") {
        payload = { scope: "spectator", roundId: claims.roundId };
      } else if (claims.scope === "crew-invite") {
        // expiresAtMs comes from the CALLER (mintCrewInvite stamps it via ITS OWN Clock,
        // clock.now() + CREW_INVITE_TTL_MS) — unlike a participant's `exp`, this issuer never
        // computes it itself; it only carries the claim's own value through to the wire.
        payload = { scope: "crew-invite", crewId: claims.crewId, inviterGolferId: claims.inviterGolferId, expiresAtMs: claims.expiresAtMs };
      } else {
        payload = { scope: "participant", roundId: claims.roundId, golferId: claims.golferId, exp: clock.now() + ttlMs };
      }
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
      return `${encodedPayload}.${sign(secret, encodedPayload)}`;
    },

    verify: (token: string): TokenClaims | undefined => {
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

      // Spectator checked first: its own discriminant (`scope === "spectator"`) is
      // unambiguous, and unlike a participant payload it never has an `exp` to compare.
      if (isSpectatorPayload(parsed)) return { scope: "spectator", roundId: roundId(parsed.roundId) };

      // Crew-invite: no clock comparison here (this function's own doc comment above) — the
      // claim round-trips verbatim, expired or not, once signature+shape check out.
      if (isCrewInvitePayload(parsed)) {
        return {
          scope: "crew-invite",
          crewId: crewId(parsed.crewId),
          inviterGolferId: golferId(parsed.inviterGolferId),
          expiresAtMs: parsed.expiresAtMs,
        };
      }

      if (isParticipantPayload(parsed)) {
        if (parsed.exp <= clock.now()) return undefined;
        return { scope: "participant", roundId: roundId(parsed.roundId), golferId: golferId(parsed.golferId) };
      }

      return undefined;
    },
  };
};
