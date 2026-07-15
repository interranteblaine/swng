import type { PeekCrewInviteRequest, PeekCrewInviteResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { Clock } from "../ports/clock.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { TokenIssuer } from "../ports/tokenIssuer.js";

// POST /crews/peek (auth none — spec §2): the capability-scoped preview a would-be joiner sees
// BEFORE signing in, mirroring PeekRound (courses.ts's own PeekRoundResponse doc comment) —
// crew name, member count, and the inviter's CURRENT roster name, nothing else. The consent
// screen is the join page's own first act ("Join The Saturday Boys? · 8 members · invited by
// Al"), never a silent auto-join.
//
// Deliberately re-derives every check joinCrewByInvite itself makes (expiry, inviter-still-a-
// member) rather than trusting a token that merely "looks fresh" — the crew doc is ALREADY read
// here for memberCount/inviterName, so the inviter check is free (spec §2: "the crew document is
// already read to add the joiner, so the check is free; peek enforces it too, so the preview
// never over-promises").
export const peekCrewInvite =
  (deps: { crewStore: CrewStore; tokenIssuer: TokenIssuer; clock: Clock }) =>
  async (command: PeekCrewInviteRequest): Promise<PeekCrewInviteResponse> => {
    const claims = deps.tokenIssuer.verify(command.token);
    if (!claims || claims.scope !== "crew-invite") throw new ApplicationError("crew-invite-invalid");

    // hmacTokenIssuer's crew-invite verify() arm deliberately does NOT gate on expiresAtMs
    // itself (ports/tokenIssuer.ts's own doc comment on CrewInviteClaims) — checked here,
    // against OUR OWN Clock, so "expired" and "otherwise invalid" stay two different codes.
    if (claims.expiresAtMs <= deps.clock.now()) throw new ApplicationError("crew-invite-expired");

    const found = await deps.crewStore.get(claims.crewId);
    if (!found) throw new ApplicationError("crew-invite-invalid"); // crews are never deleted (spec §6) — defensive only

    const inviter = found.crew.members.find((member) => member.golferId === claims.inviterGolferId);
    if (!inviter) throw new ApplicationError("crew-invite-invalid"); // the inviter has since left — checked at peek AND join (spec §2)

    return { crewName: found.crew.name, memberCount: found.crew.members.length, inviterName: inviter.name };
  };
