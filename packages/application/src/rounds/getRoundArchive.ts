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

    // TODO(Task 9): a crew-membership arm slots in here — a caller who isn't a participant
    // but shares a crew with this round (archive.crewId, deps.crewStore.get/listByGolfer)
    // should also be allowed to view it. Deliberately deferred (task-6-brief.md's binding
    // resolution): until Task 9 lands, every non-participant — including a stranger with no
    // account golfer row at all — is rejected below.
    throw new ApplicationError("not-a-viewer");
  };
