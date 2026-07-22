import type { CrewId } from "@swng/domain";
import type { CreateSeasonRequest, CreateSeasonResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { Clock } from "../ports/clock.js";
import type { CrewSeason, CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import { requireCrewMember } from "./membership.js";
import { seasonStartMs } from "./seasonStart.js";

// POST /crews/{crewId}/seasons (architecture-realignment Task 9): a season is a named, open
// thing ANY member creates — the organizer carries no extra authority in v1 (crew.ts's own
// doc), so requireCrewMember (not an organizer-only gate) is the whole authorization.
//
// The season name is validated HERE, inline, to the SAME trimmed 1-60 bound validateCrewName
// (domain/crew) holds a crew name to — but a season is application-layer store data, not a
// domain entity, so this validator lives beside its one call site rather than in domain
// (task-9 binding resolution). seasonId is server-minted (ids.newId() → an opaque UUID, never
// accepted from the wire — CrewStore's own caller contract), status is always "open" (there is
// no create-closed path; closeSeason.ts/reopenSeason.ts are the organizer's own putSeason
// upserts that flip it later).
const MAX_SEASON_NAME_LENGTH = 60;

export const createSeason =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; ids: IdGenerator; clock: Clock }) =>
  async (claims: AccountClaims, id: CrewId, command: CreateSeasonRequest): Promise<CreateSeasonResponse> => {
    await requireCrewMember(deps, claims, id);

    if (command.name.trim().length === 0 || command.name.length > MAX_SEASON_NAME_LENGTH) {
      throw new ApplicationError("invalid-season-name", `season name must be 1-${MAX_SEASON_NAME_LENGTH} characters: "${command.name}"`);
    }

    // Read BEFORE building the season — seasonStartMs (crew-scoreboard spec §2) needs this
    // crew's existing seasons to find the latest closedAtMs the new window tiles onto. ONE
    // clock.now() read serves both createdAtMs and the start rule's "now" — a season created
    // and its own window-start computation happen at the same instant.
    const seasons = await deps.crewStore.listSeasons(id);
    const now = deps.clock.now();
    const season: CrewSeason = { seasonId: deps.ids.newId(), name: command.name, status: "open", createdAtMs: now, startsAtMs: seasonStartMs(seasons, now) };
    await deps.crewStore.putSeason(id, season);

    // CrewSeason IS the wire CrewSeasonView shape field-for-field — no separate mapping.
    return { season };
  };
