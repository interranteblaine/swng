import type { GolferId, RoundId } from "@swng/domain";

// What a participant token proves: this bearer is this golfer, in this round. GolferId is
// deliberately not the Cognito sub (architecture.md §3, Identity & access) — a participant
// token is issued off a join code, no account required.
export interface ParticipantClaims {
  readonly roundId: RoundId;
  readonly golferId: GolferId;
}

export interface TokenIssuer {
  issue(claims: ParticipantClaims): string;
  verify(token: string): ParticipantClaims | undefined;
}
