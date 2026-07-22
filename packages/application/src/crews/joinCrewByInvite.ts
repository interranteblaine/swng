import { addMember } from "@swng/domain";
import type { JoinCrewRequest, JoinCrewResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { Clock } from "../ports/clock.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { TokenIssuer } from "../ports/tokenIssuer.js";
import { retryOnConflict } from "../retryOnConflict.js";
import { toCrewView } from "./crewView.js";

// POST /crews/join (golfer auth — spec §2/§3): adds the CALLER's own account golfer as a member
// (role "member") off an expiring HMAC invite link — replaces joinCrewByCode's permanent
// join-code lookup outright (the SAME self-service shape, a different capability underneath).
// The caller joins as themselves — always; there is no other path in (add-by-id died with it —
// spec §3, "nobody is conscripted; they accept an invite").
export const joinCrewByInvite =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; tokenIssuer: TokenIssuer; clock: Clock }) =>
  async (claims: AccountClaims, command: JoinCrewRequest): Promise<JoinCrewResponse> => {
    const tokenClaims = deps.tokenIssuer.verify(command.token);
    if (!tokenClaims || tokenClaims.scope !== "crew-invite") throw new ApplicationError("crew-invite-invalid");

    // hmacTokenIssuer's crew-invite verify() arm deliberately does NOT gate on expiresAtMs
    // itself (ports/tokenIssuer.ts's own doc comment on CrewInviteClaims) — checked here,
    // against OUR OWN Clock, so "expired" and "otherwise invalid" stay two different codes.
    if (tokenClaims.expiresAtMs <= deps.clock.now()) throw new ApplicationError("crew-invite-expired");

    const found = await deps.crewStore.get(tokenClaims.crewId);
    if (!found) throw new ApplicationError("crew-invite-invalid"); // crews are never deleted (spec §6) — defensive only

    // Inviter-still-a-member — checked at BOTH peek and join (spec §2): a removed member's
    // outstanding invites die with their membership. The crew doc is already read to add the
    // joiner, so this check is free.
    const inviterStillMember = found.crew.members.some((member) => member.golferId === tokenClaims.inviterGolferId);
    if (!inviterStillMember) throw new ApplicationError("crew-invite-invalid");

    // Same wire-honesty rule as createCrew: joining needs the caller's OWN golfer to seat.
    const account = await deps.golferStore.getBySub(claims.sub);
    if (!account) throw new ApplicationError("golfer-required");

    // Idempotent re-join: already on the roster, return the crew as-is — no mutation, so no
    // wasted write and no chance of a duplicate-member race on an unconditional add
    // (joinCrewByCode's own precedent).
    if (found.crew.members.some((member) => member.golferId === account.golfer.id)) {
      return { crew: toCrewView(found.crew) };
    }

    const crew = await retryOnConflict(
      {
        get: async () => {
          const current = await deps.crewStore.get(tokenClaims.crewId);
          return current && { value: current.crew, revision: current.revision };
        },
        put: (value, revision) => deps.crewStore.put(value, revision),
      },
      (current) =>
        // Re-check against the FRESH read too — the check above can be stale under a race (two
        // joins for the same golfer landing concurrently); addMember is a no-op copy here
        // rather than a second call that would hit its own duplicate-member guard.
        current.members.some((member) => member.golferId === account.golfer.id)
          ? current
          : addMember(current, { golferId: account.golfer.id, name: account.golfer.name, role: "member" }),
      { notFound: "unknown-crew", conflict: "crew-conflict" },
    );

    return { crew: toCrewView(crew) };
  };
