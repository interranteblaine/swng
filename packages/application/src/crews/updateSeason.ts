import type { CrewId } from "@swng/domain";
import { seasonWindowOf } from "@swng/domain";
import type { CreateSeasonResponse, UpdateSeasonRequest } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewSeason, CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import { requireCrewMember } from "./membership.js";

// PUT /crews/{crewId}/seasons/{seasonId} (spec 2026-07-22 "the season is the record" §2): the
// organizer's own verb — editing the end date IS the whole lifecycle now (there is no separate
// close/reopen: to end a running season, set `endsAt` to today; to extend or reopen one, push
// `endsAt` back out). Guard order mirrors the old closeSeason's exactly, MINUS the closed-check
// — requireCrewMember (not-a-member) → caller is THIS crew's organizer (not-organizer) → the
// season exists (season-not-found) — there is no closed state to gate on, so a season is always
// editable.
const MAX_SEASON_NAME_LENGTH = 60;

export const updateSeason =
  (deps: { crewStore: CrewStore; golferStore: GolferStore }) =>
  async (claims: AccountClaims, id: CrewId, seasonId: string, command: UpdateSeasonRequest): Promise<CreateSeasonResponse> => {
    const { crew } = await requireCrewMember(deps, claims, id);
    const account = await deps.golferStore.getBySub(claims.sub);
    const callerGolferId = account!.golfer.id;

    const caller = crew.members.find((member) => member.golferId === callerGolferId);
    if (caller?.role !== "organizer") throw new ApplicationError("not-organizer");

    const season = await deps.crewStore.getSeason(id, seasonId);
    if (!season) throw new ApplicationError("season-not-found");

    // Absent fields leave the stored value — plain replacement, no null semantics. The
    // CANDIDATE (not just the incoming fields) is what gets validated below, so updating only
    // `startsAt` past the stored `endsAt`, or to a shape-valid-but-unreal date, is caught —
    // never a value that's individually fine but jointly invalid.
    const candidate: CrewSeason = {
      ...season,
      name: command.name ?? season.name,
      startsAt: command.startsAt ?? season.startsAt,
      endsAt: command.endsAt ?? season.endsAt,
    };

    if (candidate.name.trim().length === 0 || candidate.name.length > MAX_SEASON_NAME_LENGTH) {
      throw new ApplicationError("invalid-season-name", `season name must be 1-${MAX_SEASON_NAME_LENGTH} characters: "${candidate.name}"`);
    }

    // The SAME date guard createSeason.ts runs (review I5): a plain ordinal string compare
    // catches an inverted window, and seasonWindowOf's own throw (a shape-valid-but-unreal date
    // like "2026-02-30") is caught and remapped here, never left to surface as a 500 on a later
    // read.
    if (candidate.startsAt > candidate.endsAt) {
      throw new ApplicationError("invalid-season-window", `startsAt "${candidate.startsAt}" is after endsAt "${candidate.endsAt}"`);
    }
    try {
      seasonWindowOf(candidate);
    } catch {
      throw new ApplicationError("invalid-season-window", `"${candidate.startsAt}"..."${candidate.endsAt}" is not a real calendar window`);
    }

    await deps.crewStore.putSeason(id, candidate);

    // CrewSeason IS the wire CrewSeasonView shape field-for-field (createSeason.ts's own
    // comment) — reuses CreateSeasonResponse's `{ season }` shape rather than a parallel type
    // (the mintParticipantToken/JoinRoundResponse reuse precedent).
    return { season: candidate };
  };
