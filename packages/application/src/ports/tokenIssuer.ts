import type { CrewId, GolferId, RoundId } from "@swng/domain";

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

// Crew membership (invited in, accountable out): what a crew-invite token proves — this
// bearer holds a link, minted by `inviterGolferId`, that admits its holder to `crewId` — NOT
// "this bearer is already a member of anything." No roundId at all (a crew-invite opens no
// round, no socket — see the union's own doc note below). Unlike ParticipantClaims' hidden
// wire-only `exp` (never surfaced on the claims themselves), `expiresAtMs` rides here as a
// plain, inspectable claim ON PURPOSE: peekCrewInvite/joinCrewByInvite need to tell "this link
// is past its 7-day window" (crew-invite-expired) apart from "this link is otherwise unusable"
// — bad signature, or its inviter has since left the crew (crew-invite-invalid) — as two
// DIFFERENT wire-facing error codes with two different copy strings (spec §5). A single
// undefined-collapsing verify() can't carry that distinction, so — deliberately, unlike every
// other scope here — hmacTokenIssuer's crew-invite verify() arm does NOT gate on expiry itself;
// it stays exactly what verify() has always been (prove authenticity, not adjudicate business
// meaning) and the calling use case compares `expiresAtMs` against its own Clock instead.
export interface CrewInviteClaims {
  readonly crewId: CrewId;
  readonly inviterGolferId: GolferId;
  readonly expiresAtMs: number;
}

// The ONE claims union both issue() and verify() speak — `scope` is the discriminant a caller
// (the dispatcher, ownmost) narrows on to learn what a verified bearer may do. issue() takes
// the SAME union verify() returns: minting any kind of token goes through this one port, one
// HMAC signer underneath (hmacTokenIssuer.ts) — never a parallel signer.
//
// SUPERSEDED INVARIANT (crew membership, invited in): this union used to promise "every
// variant carries roundId", which let wsConnect's subscribe gate and the dispatcher's
// participant/round-read tiers read `claims.roundId` with no scope check at all. The
// crew-invite variant above breaks that — it carries no roundId, on purpose (a crew invite
// opens no round, no socket, nothing but a crew join). Every one of those three call sites now
// narrows on `scope` FIRST and rejects a crew-invite bearer outright (as if no usable token had
// been presented at all) before ever touching `.roundId` — never let one leak through to a
// round-scoped surface it was never meant to open.
export type TokenClaims =
  | ({ readonly scope: "participant" } & ParticipantClaims)
  | ({ readonly scope: "spectator" } & SpectatorClaims)
  | ({ readonly scope: "crew-invite" } & CrewInviteClaims);

export interface TokenIssuer {
  issue(claims: TokenClaims): string;
  verify(token: string): TokenClaims | undefined;
}
