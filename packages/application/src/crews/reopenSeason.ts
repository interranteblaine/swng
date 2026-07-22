import type { CrewId } from "@swng/domain";
import type { ReopenSeasonResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewSeason, CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import { requireCrewMember } from "./membership.js";

// POST /crews/{crewId}/seasons/{seasonId}/reopen (close-season spec §1.3; window bounds added
// by the crew-scoreboard spec §2): the mirror of closeSeason.ts — reopening is first-class, not
// an apology (a system you can correct is more trustworthy than one you can't, the
// declared-index ruling). Reopening DELETES `closedAtMs` (not just flips `status`) — the
// window is open again, so a round played after the original close ENTERS the season; that is
// the honest reading (spec §2), never guarded. Un-awards nothing durable: titles are computed
// on read from `status` (getCrewRecords), so they simply stop appearing — nothing is stored
// about a title, ever. Same guard order as closeSeason.ts: requireCrewMember (not-a-member) →
// organizer (not-organizer) → season exists (season-not-found) → it IS closed
// (season-not-closed — the explicit-conflict twin of season-already-closed).
export const reopenSeason =
  (deps: { crewStore: CrewStore; golferStore: GolferStore }) =>
  async (claims: AccountClaims, id: CrewId, seasonId: string): Promise<ReopenSeasonResponse> => {
    const { crew } = await requireCrewMember(deps, claims, id);
    const account = await deps.golferStore.getBySub(claims.sub);
    const callerGolferId = account!.golfer.id;

    const caller = crew.members.find((member) => member.golferId === callerGolferId);
    if (caller?.role !== "organizer") throw new ApplicationError("not-organizer");

    const season = await deps.crewStore.getSeason(id, seasonId);
    if (!season) throw new ApplicationError("season-not-found");
    if (season.status !== "closed") throw new ApplicationError("season-not-closed");

    // Built field-by-field (never spread `season` then set closedAtMs: undefined) so the
    // resulting object has NO closedAtMs property at all — putSeason's own whole-item-put
    // contract means an absent field here really leaves storage, making reopen lossless.
    const reopened: CrewSeason = {
      seasonId: season.seasonId,
      name: season.name,
      status: "open",
      createdAtMs: season.createdAtMs,
      startsAtMs: season.startsAtMs,
    };
    await deps.crewStore.putSeason(id, reopened);

    return { season: reopened };
  };
