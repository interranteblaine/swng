import type { CrewId } from "@swng/domain";
import { seasonWindowOf } from "@swng/domain";
import type { CreateSeasonRequest, CreateSeasonResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { Clock } from "../ports/clock.js";
import type { CrewSeason, CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import { requireCrewMember } from "./membership.js";

// POST /crews/{crewId}/seasons (spec 2026-07-22 "the season is the record" §2): a season is a
// named, CHOSEN period ANY member creates — the organizer carries no extra authority in v1
// (crew.ts's own doc), so requireCrewMember (not an organizer-only gate) is the whole
// authorization. Both `startsAt`/`endsAt` are required on the wire (contracts/crews.ts's own
// regex-pinned shape) — there is no derivation, no tiling rule, and no `status`: a season states
// its own dates, and time (not a stored flag) is its only lifecycle.
//
// The season name is validated HERE, inline, to the SAME trimmed 1-60 bound validateCrewName
// (domain/crew) holds a crew name to — but a season is application-layer store data, not a
// domain entity, so this validator lives beside its one call site rather than in domain
// (task-9 binding resolution). seasonId is server-minted (ids.newId() → an opaque UUID, never
// accepted from the wire — CrewStore's own caller contract).
const MAX_SEASON_NAME_LENGTH = 60;

export const createSeason =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; ids: IdGenerator; clock: Clock }) =>
  async (claims: AccountClaims, id: CrewId, command: CreateSeasonRequest): Promise<CreateSeasonResponse> => {
    await requireCrewMember(deps, claims, id);

    if (command.name.trim().length === 0 || command.name.length > MAX_SEASON_NAME_LENGTH) {
      throw new ApplicationError("invalid-season-name", `season name must be 1-${MAX_SEASON_NAME_LENGTH} characters: "${command.name}"`);
    }

    // The date guard (review I5): a plain ordinal string compare catches an inverted window,
    // and running seasonWindowOf catches a shape-valid-but-unreal date (e.g. "2026-02-30")
    // BEFORE it can ever be stored — that call's own throw is a programmer-guard plain Error
    // (domain/crew/seasonWindow.ts's own doc comment), so it's caught and remapped here, never
    // left to surface as an uncaught 500 on a later read.
    if (command.startsAt > command.endsAt) {
      throw new ApplicationError("invalid-season-window", `startsAt "${command.startsAt}" is after endsAt "${command.endsAt}"`);
    }
    try {
      seasonWindowOf(command);
    } catch {
      throw new ApplicationError("invalid-season-window", `"${command.startsAt}"..."${command.endsAt}" is not a real calendar window`);
    }

    const season: CrewSeason = { seasonId: deps.ids.newId(), name: command.name, createdAtMs: deps.clock.now(), startsAt: command.startsAt, endsAt: command.endsAt };
    await deps.crewStore.putSeason(id, season);

    // CrewSeason IS the wire CrewSeasonView shape field-for-field — no separate mapping.
    return { season };
  };
