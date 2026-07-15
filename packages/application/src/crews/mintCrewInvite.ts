import type { CrewId } from "@swng/domain";
import type { MintCrewInviteResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { Clock } from "../ports/clock.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { TokenIssuer } from "../ports/tokenIssuer.js";
import { requireCrewMember } from "./membership.js";

// Crew membership (invited in, accountable out — spec §2): the weekly social cycle bounds a
// leaked link with zero revocation infrastructure. Mirrors M9's participant-token DEFAULT_TTL_MS
// idiom (hmacTokenIssuer.ts) but lives HERE, application-side, not inside the issuer — the
// issuer stays a dumb sign/verify boundary; the 7-day business rule belongs to the use case that
// spends a Clock reading on it, same split as every other "the issuer signs what it's handed"
// scope (getShareLink.ts's own doc comment).
export const CREW_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// POST /crews/{crewId}/invites (golfer auth, member-gated — spec §2): mints a stateless HMAC
// token, the SAME TokenIssuer/hmacTokenIssuer one-signer as participant/spectator tokens (M9's
// "never a parallel signer"). ANY member may invite (spec §1: "everything else stays
// egalitarian... any member invites" — mirrors round's own "any participant can finalize").
// Non-deterministic on purpose (unlike getShareLink's immortal, byte-identical link): every
// call mints a FRESH 7-day window from `clock.now()`, so a repeat call is a genuinely new
// invite, not a cache hit.
export const mintCrewInvite =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; tokenIssuer: TokenIssuer; clock: Clock }) =>
  async (claims: AccountClaims, id: CrewId): Promise<MintCrewInviteResponse> => {
    // member-only: not-a-member (or golfer-required-folded-into-it) propagates for a
    // non-member/unbound caller — requireCrewMember's own membership.ts doc comment.
    const { crew } = await requireCrewMember(deps, claims, id);
    // requireCrewMember already proved claims.sub resolves to a golfer ON this crew's roster —
    // the same re-read leaveCrew.ts's own `account!` idiom relies on.
    const account = await deps.golferStore.getBySub(claims.sub);
    const inviterGolferId = account!.golfer.id;

    const expiresAtMs = deps.clock.now() + CREW_INVITE_TTL_MS;
    const token = deps.tokenIssuer.issue({ scope: "crew-invite", crewId: crew.id, inviterGolferId, expiresAtMs });

    return { token, expiresAtMs };
  };
