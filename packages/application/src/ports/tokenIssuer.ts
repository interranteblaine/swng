import type { GolferId, RoundId } from "@swng/domain";

// What a participant token proves: this bearer is this golfer, in this round. GolferId is
// deliberately not the Cognito sub (architecture.md §3, Identity & access) — a participant
// token is issued off a join code, no account required.
export interface ParticipantClaims {
  readonly roundId: RoundId;
  readonly golferId: GolferId;
}

// M9 Task 3 (share): what a spectator token proves — this bearer may READ this round, nothing
// more. No golferId (a spectator authors no events, so there's nobody to bind), and — unlike
// ParticipantClaims — no expiry rides in the wire payload at all (hmacTokenIssuer.ts's own
// doc comment: a share link is deterministic and non-expiring by design, not an oversight).
export interface SpectatorClaims {
  readonly roundId: RoundId;
}

// The ONE claims union both issue() and verify() speak — `scope` is the discriminant a caller
// (the dispatcher, ownmost) narrows on to learn what a verified bearer may do. Every variant
// carries `roundId`, so a roundId-only check (wsConnect's own subscribe gate) never needs to
// switch on scope at all. issue() takes the SAME union verify() returns: minting either kind
// of token goes through this one port, one HMAC signer underneath (hmacTokenIssuer.ts) — never
// a parallel signer for spectator tokens.
export type TokenClaims = ({ readonly scope: "participant" } & ParticipantClaims) | ({ readonly scope: "spectator" } & SpectatorClaims);

export interface TokenIssuer {
  issue(claims: TokenClaims): string;
  verify(token: string): TokenClaims | undefined;
}
