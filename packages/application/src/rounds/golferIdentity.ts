import type { GolferId } from "@swng/domain";
import { ApplicationError } from "../errors.js";
import type { GolferStore } from "../ports/golferStore.js";

// The claimed-golferId rule — ONE implementation shared by startRound (the host's own golferId
// AND every entry in `players`), joinRound (Task 5b's original home for this rule), and
// addParticipant, so the three arms below can't drift across the three surfaces that let a
// caller supply an EXISTING golferId instead of minting a fresh one.
//
// Deliberately narrow: this function only judges a SUPPLIED id. It NEVER mints — "no
// golferId supplied" is each call site's OWN branch (`command.golferId !== undefined ? ... :
// golferId(deps.ids.newId())`), never routed through here, so the "absent golferId mints a
// fresh id" behavior is byte-identical to what every call site already did before this
// extraction existed.
export interface GolferIdentityContext {
  // The CALLING account's verified Cognito sub, when the surface has one to offer — enables
  // the "as-self" arm below. StartRound/JoinRound may carry one (a signed-in caller acting on
  // their own behalf); AddParticipant's participant-token auth never does (a round-scoped
  // token proves "you're in this round," never "you're this Cognito user"), so its calls
  // always pass sub: undefined, which disables that arm for that surface — a claimed golfer
  // can only be seated through it if it's unclaimed.
  readonly sub?: string;
}

// A crew is a grouping/competition ONLY (owner ruling, spec §11a, 2026-07-13) — the old
// co-membership consent arm (seating a claimed fellow crew member on someone else's say-so) is
// DELETED outright. A claimed golfer may only ever be seated by proving it's themselves
// (as-self); every other claimed-non-self supply, crew-mate or stranger alike, is rejected.
//   1. as-self        — bound sub === caller's own sub (no extra store call beyond `existing`)
//   2. unclaimed-reuse — no bound sub at all (no extra store call beyond `existing`)
//   3. reject         — golfer-claimed, ALWAYS, for every other case
export const resolveSuppliedGolfer =
  (deps: { golferStore: GolferStore }) =>
  async (suppliedGolferId: GolferId, ctx: GolferIdentityContext): Promise<GolferId> => {
    const existing = await deps.golferStore.get(suppliedGolferId);

    // 1. As-self: the caller's OWN verified sub matches the bound sub — proves identity.
    //    (An unclaimed target has `existing?.sub` undefined and can never match a real
    //    ctx.sub, so ordering this ahead of unclaimed-reuse is purely which cheap check runs
    //    first — both decide from the one `existing` read and are mutually exclusive.)
    if (ctx.sub !== undefined && existing?.sub === ctx.sub) return suppliedGolferId;

    // 2. Unclaimed-reuse: absence of a bound sub means unclaimed (golferStore.ts's port doc:
    //    rows are lazy) — only a row WITH a sub blocks reuse. Same T5b behavior this rule was
    //    extracted from.
    if (existing?.sub === undefined) return suppliedGolferId;

    // 3. Otherwise the target is claimed by someone else — rejected, no exceptions. There is
    //    no consent path left: a shared crew, if any, is irrelevant to this decision.
    throw new ApplicationError("golfer-claimed", `golfer ${suppliedGolferId} is claimed`);
  };
