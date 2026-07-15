import type { Crew, CrewId, Golfer } from "@swng/domain";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";

// CreateCrew's own arm (M8 plan): the caller needs an account golfer to seat as the crew's
// first member (the organizer). No auto-create here — unlike GET /me / PUT /me's own
// ensureGolfer path, a crew mutation is never the right place to lazily mint someone's OWN
// profile; the web PUTs /me first, so a real golfer already exists by the time this runs.
export const requireAccountGolfer = async (deps: { golferStore: GolferStore }, claims: AccountClaims): Promise<Golfer> => {
  const found = await deps.golferStore.getBySub(claims.sub);
  if (!found) throw new ApplicationError("golfer-required");
  return found.golfer;
};

// GetCrew/AddCrewMember/getSeasonStandings's shared authorization gate — the caller's account
// golfer must already be on the crew's roster. A sub with no golfer at all can't be a member by
// construction (only a real GolferId ever lands in crew.members), so "no account golfer" and "a
// real golfer who isn't on THIS crew" collapse into the one not-a-member 403 the wire exposes.
export const requireCrewMember = async (
  deps: { golferStore: GolferStore; crewStore: CrewStore },
  claims: AccountClaims,
  crewId: CrewId,
): Promise<{ crew: Crew; revision: number }> => {
  const found = await deps.crewStore.get(crewId);
  if (!found) throw new ApplicationError("unknown-crew");

  const account = await deps.golferStore.getBySub(claims.sub);
  if (!account || !found.crew.members.some((member) => member.golferId === account.golfer.id)) {
    throw new ApplicationError("not-a-member");
  }

  return found;
};
