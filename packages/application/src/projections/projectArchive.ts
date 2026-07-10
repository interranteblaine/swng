import type { RoundArchive } from "@swng/domain";
import { archiveGolferLine, combineNineHoleDifferentials, computeIndex } from "@swng/domain";
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
// differentialsUsed is the count of 18-hole-equivalent differentials actually considered by
// computeIndex (bounded to its own last-20 window, mirrored here) — NOT the WHS "number of
// scores averaged" figure (computeIndex's internal small-sample-table `use`, which the
// domain function doesn't expose and application has no business re-deriving — that would
// duplicate WHS scoring math outside domain, conventions §4). Flagged for whoever wires the
// ProfilePage record view (M7 Task 6/8): if the UI wants the stricter WHS figure, it needs a
// domain-side export, not a parallel table in application.
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
      const value = computeIndex(combined);
      // Bootstrap not met yet (computeIndex returns undefined below 3 differentials) — skip,
      // never clear a prior snapshot (there isn't one to clear: differentials only grow
      // within one incremental build, and a rebuild replay hits this same skip at the same
      // relative position it did the first time).
      if (value === undefined) continue;

      const window = combined.slice(-20); // mirrors computeIndex's own windowing (whs.ts)
      await deps.projectionStore.putIndex(participant.golferId, { value, computedAtMs: deps.clock.now(), differentialsUsed: window.length });
    }

    deps.logger.info("archive-projected", { roundId: archive.roundId, participants: archive.participants.length });
  };
