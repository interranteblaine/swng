import type { CrewId, RoundId } from "@swng/domain";
import type { RemoveCountedRoundResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import { requireCrewMember } from "./membership.js";

// DELETE /crews/{crewId}/seasons/{seasonId}/rounds/{roundId} (architecture-realignment Task 9):
// un-count a round. Only the member who APPENDED it may remove it (not-the-appender) — a round
// one member counted isn't another's to drop. Guards, in order:
//   member (not-a-member) → season exists (season-not-found) → season open (season-closed) →
//   the caller appended this entry (not-the-appender).
// An entry that isn't there (never counted, or already removed) is an idempotent no-op success,
// not an error — the same DELETE-is-idempotent shape CrewStore.removeCountedRound itself has.
export const removeCountedRound =
  (deps: { crewStore: CrewStore; golferStore: GolferStore }) =>
  async (claims: AccountClaims, id: CrewId, seasonId: string, roundId: RoundId): Promise<RemoveCountedRoundResponse> => {
    await requireCrewMember(deps, claims, id);
    const account = await deps.golferStore.getBySub(claims.sub);
    const callerGolferId = account!.golfer.id;

    const season = await deps.crewStore.getSeason(id, seasonId);
    if (!season) throw new ApplicationError("season-not-found");
    if (season.status === "closed") throw new ApplicationError("season-closed");

    const entry = (await deps.crewStore.listCountedRounds(id, seasonId)).find((counted) => counted.roundId === roundId);
    // Present-but-someone-else's → 403. Absent → nothing to protect; fall through to the
    // idempotent delete below (a caller can't "remove" a round that was never counted, so there
    // is no appender to check against).
    if (entry && entry.appendedBy !== callerGolferId) throw new ApplicationError("not-the-appender");

    await deps.crewStore.removeCountedRound(id, seasonId, roundId);

    return { roundId };
  };
