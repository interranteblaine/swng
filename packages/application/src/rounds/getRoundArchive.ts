import type { RoundId } from "@swng/domain";
import type { GetRoundArchiveResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { SnapshotStore } from "../ports/snapshotStore.js";

// GET /rounds/{roundId}/archive (projection-realignment Task 6): the snapshot IS the atom
// (SnapshotStore's own port doc) — this is the one read that hands a finalized round's own
// event log back to a golfer who was in it, for the web's ArchivedRoundPage to fold via the
// SAME domain `reduceRound` every other read path (WatchPage, RoundPage) already uses. No
// journal here: a `final` round never appends again short of a reopen (out of this task's
// scope), so the settled snapshot is the whole story.
export const getRoundArchive =
  (deps: { snapshots: SnapshotStore; golferStore: GolferStore; crewStore: CrewStore }) =>
  async (claims: AccountClaims, roundIdValue: RoundId): Promise<GetRoundArchiveResponse> => {
    const archive = await deps.snapshots.get(roundIdValue);
    if (!archive) throw new ApplicationError("round-not-found");

    const found = await deps.golferStore.getBySub(claims.sub);
    const isParticipant = found !== undefined && archive.participants.some((participant) => participant.golferId === found.golfer.id);
    if (isParticipant) return { events: archive.events };

    // The crew-view arm (architecture-realignment Task 9, spec §4 "GET /rounds/{roundId}/archive
    // allowed for a participant, or a member of a crew that counts this round"): a signed-in
    // caller who wasn't in the round may still view it iff SOME crew they belong to counts this
    // round in one of its seasons. Round-is-a-sealed-leaf, so the round itself carries no crewId
    // to check — authority flows the other way, from the crew's own counted set (countsRound),
    // reached via the caller's crews (listByGolfer). A caller with no account golfer (found
    // undefined) has no crews to check and falls straight through to the 403 below.
    if (found !== undefined) {
      const crews = await deps.crewStore.listByGolfer(found.golfer.id);
      for (const crew of crews) {
        if (await deps.crewStore.countsRound(crew.crewId, roundIdValue)) return { events: archive.events };
      }
    }

    throw new ApplicationError("not-a-viewer");
  };
