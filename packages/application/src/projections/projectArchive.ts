import type { RoundArchive } from "@swng/domain";
import { archiveGolferLine, combineNineHoleDifferentials, computeIndexDetail } from "@swng/domain";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { ProjectionStore } from "../ports/projectionStore.js";

// The one place archive.events is searched for round-finalized — both projectArchive
// (below) and rebuildProjections' own sort key (rebuildProjections.ts) go through this, so
// "what does finalizedAt mean" is never answered twice. settleRound only ever produces a
// `final` archive via that event landing (domain's round/state.ts LIFECYCLE_STATUS), so its
// absence here means the archive itself is corrupt — never silently skipped.
export const finalizedAtMsOf = (archive: RoundArchive): number => {
  const finalizedEvent = archive.events.find((event) => event.kind === "round-finalized");
  if (!finalizedEvent) {
    throw new Error(`finalizedAtMsOf: archive for round ${archive.roundId} has no round-finalized event — a settled archive without one is corrupt`);
  }
  return finalizedEvent.hlc.wallMs;
};

// THE one projector implementation (M7 plan): both the DynamoDB stream trigger (Task 4) and
// rebuildProjections (below) call this exact function — never two independent
// implementations of "what a finalized round does to a golfer's record."
//
// differentialsUsed is Rule 5.2a's `use` count — how many differentials were actually
// AVERAGED, not how many were in the window (e.g. 3 available → uses the lowest 1). Sourced
// straight from domain's computeIndexDetail (whs.ts), which owns the one small-sample table
// — never re-derived here (conventions §4: scoring math exists exactly once, in domain).
//
// ACCEPTED RACE (per-shard, not per-golfer, serialization): DynamoDB Streams only guarantee
// ordering per shard, and shards partition by the STREAM'S own key (the round, here) — not by
// golfer. Two rounds that finalize at nearly the same moment and share a participant can land
// on different shards and invoke this function concurrently for that golfer. Each call's
// putHistoryLine (below) is independent and safe, but the immediately-following listHistory +
// computeIndexDetail can race: one call's listHistory can run before the OTHER call's
// putHistoryLine has landed, so the index it computes and stores is momentarily short one
// differential. Self-heals the next time this golfer's projection is touched — either their
// next finalize (a fresh listHistory sees everything written so far) or a rebuildProjections
// pass (which replays every archive in finalizedAt order, deterministically, from scratch).
export const projectArchive =
  (deps: { projectionStore: ProjectionStore; clock: Clock; logger: Logger }) =>
  async (archive: RoundArchive): Promise<void> => {
    const finalizedAtMs = finalizedAtMsOf(archive);

    for (const participant of archive.participants) {
      const line = archiveGolferLine(archive, participant.golferId);
      await deps.projectionStore.putHistoryLine(participant.golferId, { ...line, finalizedAtMs });

      const history = await deps.projectionStore.listHistory(participant.golferId);
      const complete = history.filter((entry) => entry.differential !== undefined);
      const combined = combineNineHoleDifferentials(complete.map((entry) => ({ differential: entry.differential!, holes: entry.holes })));
      const detail = computeIndexDetail(combined);
      // Bootstrap not met yet (computeIndexDetail returns undefined below 3 differentials) —
      // skip, never clear a prior snapshot (there isn't one to clear: differentials only grow
      // within one incremental build, and a rebuild replay hits this same skip at the same
      // relative position it did the first time).
      if (detail === undefined) continue;

      await deps.projectionStore.putIndex(participant.golferId, { value: detail.value, computedAtMs: deps.clock.now(), differentialsUsed: detail.differentialsUsed });
    }

    deps.logger.info("archive-projected", { roundId: archive.roundId, participants: archive.participants.length });
  };
