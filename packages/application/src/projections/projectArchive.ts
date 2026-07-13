import type { RoundArchive } from "@swng/domain";
import { archiveGolferLine, combineNineHoleDifferentials, computeIndexDetail } from "@swng/domain";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { ProjectionStore } from "../ports/projectionStore.js";

// The one place a golfer's own lines get a canonical order (projection-realignment spec §3):
// ProjectionStore.listLines is UNORDERED by contract (ports/projectionStore.ts) — the stable
// `ROUND#<roundId>` sk carries no time to sort by — so every reader imposes this SAME order
// itself rather than trusting insertion order, or two readers (this fold, getMyRecord's wire
// response) silently disagreeing. Ascending by finalizedAtMs; roundId is a tiebreak for a
// same-millisecond pair (unreachable at real wall-clock resolution, but a deterministic order
// beats an unspecified one at zero cost, and it's the exact order the old time-embedded sk gave
// for free).
export const sortLines = <T extends { readonly finalizedAtMs: number; readonly roundId: string }>(lines: readonly T[]): T[] =>
  [...lines].sort((a, b) => a.finalizedAtMs - b.finalizedAtMs || (a.roundId < b.roundId ? -1 : a.roundId > b.roundId ? 1 : 0));

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
// putLine (below) is independent and safe, but the immediately-following listLines +
// computeIndexDetail can race: one call's listLines can run before the OTHER call's
// putLine has landed, so the index it computes and stores is momentarily short one
// differential. Self-heals the next time this golfer's projection is touched — either their
// next finalize (a fresh listLines sees everything written so far) or a rebuild pass over the
// snapshots table.
export const projectArchive =
  (deps: { projectionStore: ProjectionStore; clock: Clock; logger: Logger }) =>
  async (archive: RoundArchive): Promise<void> => {
    const finalizedAtMs = finalizedAtMsOf(archive);

    for (const participant of archive.participants) {
      const line = archiveGolferLine(archive, participant.golferId);
      await deps.projectionStore.putLine(participant.golferId, { ...line, finalizedAtMs });

      // Presence cleanup (spec §5, Task 13): the finalized archive's own participant list IS
      // the seated roster — the same one startRound/joinRound/addParticipant wrote a LIVE
      // pointer for at seat-time (rounds/presence.ts) — so this is the primary removal path,
      // TTL being only a backstop for a round that never finalizes. Same at-least-once
      // idempotence reasoning as putLine just above: a re-projection of an already-projected
      // archive (rebuildProjections' own replay, or the stream trigger's own at-least-once
      // delivery) calls deleteLive on a pointer that's already gone — a no-op, never an error.
      await deps.projectionStore.deleteLive(participant.golferId, archive.roundId);

      // listLines is UNORDERED (ports/projectionStore.ts) — sortLines imposes the
      // (finalizedAtMs, roundId) order combineNineHoleDifferentials/computeIndexDetail need
      // BEFORE the fold runs, so this fold's result never depends on the store's own,
      // unspecified iteration order (a real DynamoDB Query vs. an in-memory fake's Map could
      // otherwise disagree).
      const lines = sortLines(await deps.projectionStore.listLines(participant.golferId));
      const complete = lines.filter((entry) => entry.differential !== undefined);
      const combined = combineNineHoleDifferentials(complete.map((entry) => ({ differential: entry.differential!, holes: entry.holes })));
      const detail = computeIndexDetail(combined);
      // Bootstrap not met yet (computeIndexDetail returns undefined below 3 differentials) —
      // skip, never clear a prior snapshot (there isn't one to clear: differentials only grow
      // within one incremental build, and a rebuild replay hits this same skip at the same
      // relative position it did the first time).
      if (detail === undefined) continue;

      await deps.projectionStore.putIndex(participant.golferId, { value: detail.value, computedAtMs: deps.clock.now(), differentialsUsed: detail.differentialsUsed });
    }

    // The crew arm is GONE (architecture-realignment Task 9, spec §4/§9): crew standings are
    // computed on read over the snapshots table (crews/getSeasonStandings), never a projection —
    // so a finalized round no longer touches any crew keyspace here. The projector is a
    // golfer-record-only fold now.
    deps.logger.info("archive-projected", { roundId: archive.roundId, participants: archive.participants.length });
  };
