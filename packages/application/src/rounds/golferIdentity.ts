import type { CrewId, GolferId } from "@swng/domain";
import { ApplicationError } from "../errors.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";

// The claimed-golferId rule (M8 plan) — ONE implementation shared by startRound (the host's
// own golferId AND every entry in `players`), joinRound (Task 5b's original home for this
// rule), and addParticipant, so the four arms below can't drift across the three surfaces
// that let a caller supply an EXISTING golferId instead of minting a fresh one.
//
// Deliberately narrow: this function only judges a SUPPLIED id. It NEVER mints — "no
// golferId supplied" is each call site's OWN branch (`command.golferId !== undefined ? ... :
// golferId(deps.ids.newId())`), never routed through here, so the "absent golferId mints a
// fresh id" behavior is byte-identical to what every call site already did before this
// extraction existed.
export interface GolferIdentityContext {
  // The CALLING account's verified Cognito sub, when the surface has one to offer — enables
  // the "claimed + as-self" arm. StartRound/JoinRound may carry one (a signed-in caller
  // acting on their own behalf); AddParticipant's participant-token auth never does (a
  // round-scoped token proves "you're in this round," never "you're this Cognito user"), so
  // its calls always pass sub: undefined, which simply disables that one arm for that
  // surface — the other three arms are unaffected.
  readonly sub?: string;
  // The round's OWN crewId, when this command targets (or is creating) a crew-tagged round —
  // enables the "standing consent" arm: a claimed golfer who's a member of THIS crew can be
  // seated by any fellow crew member without proving they ARE that golfer. Absent for an
  // untagged round, which disables that arm entirely (standing consent never reaches across
  // rounds with no crew tag).
  readonly crewId?: CrewId;
}

export const resolveSuppliedGolfer =
  (deps: { golferStore: GolferStore; crewStore: CrewStore }) =>
  async (suppliedGolferId: GolferId, ctx: GolferIdentityContext): Promise<GolferId> => {
    const existing = await deps.golferStore.get(suppliedGolferId);

    // Absence of a GOLFER row means unclaimed (golferStore.ts's port doc: rows are lazy) —
    // only a row WITH a sub blocks reuse. Same T5b behavior this rule was extracted from.
    if (existing?.sub === undefined) return suppliedGolferId;

    // As-self: the caller's OWN verified sub matches the bound sub — proves identity, no
    // crew involved.
    if (ctx.sub !== undefined && existing.sub === ctx.sub) return suppliedGolferId;

    // Standing consent: the target golfer is already a member of the crew THIS command
    // targets — the crew vouches for its own roster, so a fellow member can seat them
    // without a Bearer token proving they ARE that golfer.
    if (ctx.crewId !== undefined) {
      const crew = await deps.crewStore.get(ctx.crewId);
      if (crew?.crew.members.some((member) => member.golferId === suppliedGolferId)) return suppliedGolferId;
    }

    throw new ApplicationError("golfer-claimed", `golfer ${suppliedGolferId} is claimed`);
  };
