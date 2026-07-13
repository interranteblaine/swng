import type { GolferId } from "@swng/domain";
import { ApplicationError } from "../errors.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";

// The claimed-golferId rule — ONE implementation shared by startRound (the host's own golferId
// AND every entry in `players`), joinRound (Task 5b's original home for this rule), and
// addParticipant, so the four arms below can't drift across the three surfaces that let a
// caller supply an EXISTING golferId instead of minting a fresh one.
//
// Deliberately narrow: this function only judges a SUPPLIED id. It NEVER mints — "no
// golferId supplied" is each call site's OWN branch (`command.golferId !== undefined ? ... :
// golferId(deps.ids.newId())`), never routed through here, so the "absent golferId mints a
// fresh id" behavior is byte-identical to what every call site already did before this
// extraction existed.
export interface GolferIdentityContext {
  // The CALLING account's verified Cognito sub, when the surface has one to offer — enables
  // both the "as-self" arm and the co-membership arm below. StartRound/JoinRound may carry one
  // (a signed-in caller acting on their own behalf); AddParticipant's participant-token auth
  // never does (a round-scoped token proves "you're in this round," never "you're this Cognito
  // user"), so its calls always pass sub: undefined, which disables BOTH of those arms for that
  // surface — a claimed golfer can only be seated through it if it's unclaimed.
  readonly sub?: string;
}

// Arm order is deliberate and documented here once (rather than re-argued per branch): the
// cheap arms that need only the single `existing` read run first, and the co-membership arm —
// the only one that spends further store round-trips (getBySub + two listByGolfer) — runs
// LAST, reached only when neither cheap arm resolved.
//   1. as-self        — bound sub === caller's own sub (no extra store call beyond `existing`)
//   2. unclaimed-reuse — no bound sub at all (no extra store call beyond `existing`)
//   3. co-membership  — caller and target share a crew (three further store reads)
//   4. reject         — golfer-claimed
export const resolveSuppliedGolfer =
  (deps: { golferStore: GolferStore; crewStore: CrewStore }) =>
  async (suppliedGolferId: GolferId, ctx: GolferIdentityContext): Promise<GolferId> => {
    const existing = await deps.golferStore.get(suppliedGolferId);

    // 1. As-self: the caller's OWN verified sub matches the bound sub — proves identity, no
    //    crew involved. (An unclaimed target has `existing?.sub` undefined and can never match
    //    a real ctx.sub, so ordering this ahead of unclaimed-reuse is purely which cheap check
    //    runs first — both decide from the one `existing` read and are mutually exclusive.)
    if (ctx.sub !== undefined && existing?.sub === ctx.sub) return suppliedGolferId;

    // 2. Unclaimed-reuse: absence of a bound sub means unclaimed (golferStore.ts's port doc:
    //    rows are lazy) — only a row WITH a sub blocks reuse. Same T5b behavior this rule was
    //    extracted from.
    if (existing?.sub === undefined) return suppliedGolferId;

    // 3. Co-membership consent: the caller is signed in, acting on someone OTHER than
    //    themselves, and the two share at least one crew — so the crew relationship itself
    //    vouches for seating the claimed target, no Bearer token proving they ARE that golfer.
    //    Round-is-a-sealed-leaf: consent flows from the crew, derived from the caller's OWN
    //    crews, NOT from any tag on the round (a round no longer names a crew). Reachable only
    //    when ctx.sub is present, which structurally excludes the participant-token surface
    //    (addParticipant), exactly as it excludes the as-self arm above.
    if (ctx.sub !== undefined) {
      const caller = await deps.golferStore.getBySub(ctx.sub);
      if (caller !== undefined && caller.golfer.id !== suppliedGolferId) {
        const callerCrews = await deps.crewStore.listByGolfer(caller.golfer.id);
        const targetCrewIds = new Set((await deps.crewStore.listByGolfer(suppliedGolferId)).map((crew) => crew.crewId));
        if (callerCrews.some((crew) => targetCrewIds.has(crew.crewId))) return suppliedGolferId;
      }
    }

    // 4. Otherwise the target is claimed by someone else and no consent path applies.
    throw new ApplicationError("golfer-claimed", `golfer ${suppliedGolferId} is claimed`);
  };
