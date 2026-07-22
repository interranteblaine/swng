import type { CrewId } from "@swng/domain";
import type { CloseSeasonResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { Clock } from "../ports/clock.js";
import type { CrewSeason, CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import { requireCrewMember } from "./membership.js";

// POST /crews/{crewId}/seasons/{seasonId}/close (close-season spec §1; window bounds added by
// the crew-scoreboard spec §2): the organizer's own verb — CrewSeason.status was already
// load-bearing (appendCountedRound/removeCountedRound's own season-closed 409; getCrewRecords'
// own on-read title fold awards a CLOSED season's Stableford leader), but nothing could SET it
// until this use case. Closing now ALSO stamps `closedAtMs` — the window's end (the SAME put
// that flips `status`), so a round played after this instant falls outside the season unless
// it's later reopened. Guard idiom mirrors removeCrewMember.ts/transferOrganizer.ts exactly (do
// not invent a new membership loader): requireCrewMember (not-a-member) → caller is THIS crew's
// organizer (not-organizer) → the season exists (season-not-found, the SAME code
// appendCountedRound already throws for a missing season) → it isn't already closed
// (season-already-closed — a stale client learns the truth, never a silent no-op, the
// tee-set-revised/card-superseded precedent).
export const closeSeason =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; clock: Clock }) =>
  async (claims: AccountClaims, id: CrewId, seasonId: string): Promise<CloseSeasonResponse> => {
    const { crew } = await requireCrewMember(deps, claims, id);
    const account = await deps.golferStore.getBySub(claims.sub);
    const callerGolferId = account!.golfer.id;

    const caller = crew.members.find((member) => member.golferId === callerGolferId);
    if (caller?.role !== "organizer") throw new ApplicationError("not-organizer");

    const season = await deps.crewStore.getSeason(id, seasonId);
    if (!season) throw new ApplicationError("season-not-found");
    if (season.status === "closed") throw new ApplicationError("season-already-closed");

    const closed: CrewSeason = { ...season, status: "closed", closedAtMs: deps.clock.now() };
    await deps.crewStore.putSeason(id, closed);

    // CrewSeason IS the wire CrewSeasonView shape field-for-field (createSeason.ts's own
    // comment) — no separate season->view mapping to reuse or invent.
    return { season: closed };
  };
