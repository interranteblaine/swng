import type { RoundId } from "@swng/domain";
import type { GetRoundArchiveResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { SnapshotStore } from "../ports/snapshotStore.js";

// GET /rounds/{roundId}/archive (projection-realignment Task 6; relaxed to any signed-in
// golfer by navigation spec §6b): the snapshot IS the atom (SnapshotStore's own port doc) —
// this is the one read that hands a finalized round's own event log to a golfer, for the
// web's ArchivedRoundPage to fold via the SAME domain `reduceRound` every other read path
// (WatchPage, RoundPage) already uses. No journal here: a `final` round never appends again
// short of a reopen (out of this task's scope), so the settled snapshot is the whole story.
//
// Any signed-in golfer may view any finalized archive (spec §6b, binding): a finalized
// scorecard is the same class of fact the golfer page's own read (getGolfer.ts, spec §6a)
// already makes visible on every participant's record — one legible rule beats a visibility
// calculus. The former participant-or-crew-counts authorization (and its golferStore/
// crewStore deps) is gone; the dispatcher's "golfer" auth tier (routes.ts) is the whole
// authorization story now — this use case only checks that a snapshot exists. `claims` stays
// in the signature (routes.ts's UseCases.getRoundArchive still passes ctx.account) even
// though it's now unused here — the capability model still gates LIVE reads (participant/
// spectator tokens) and all writes; only this settled-archive read relaxed.
export const getRoundArchive =
  (deps: { snapshots: SnapshotStore }) =>
  async (claims: AccountClaims, roundIdValue: RoundId): Promise<GetRoundArchiveResponse> => {
    const archive = await deps.snapshots.get(roundIdValue);
    if (!archive) throw new ApplicationError("round-not-found");
    return { events: archive.events };
  };
