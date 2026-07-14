import type { RoundArchive } from "@swng/domain";
import { archiveGolferLine, combineNineHoleDifferentials, computeIndexDetail } from "@swng/domain";
import type { Clock } from "../ports/clock.js";
import type { GolferStore } from "../ports/golferStore.js";
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

// createdAt (accounts-only identity spec §5, the "course + date" designation): the round-created
// event's own wall time. round-created is the genesis of every archive's log, so its absence means
// the archive is corrupt — mirrors finalizedAtMsOf's own stance, never a silent 0.
export const createdAtMsOf = (archive: RoundArchive): number => {
  const createdEvent = archive.events.find((event) => event.kind === "round-created");
  if (!createdEvent) {
    throw new Error(`createdAtMsOf: archive for round ${archive.roundId} has no round-created event — a settled archive without one is corrupt`);
  }
  return createdEvent.hlc.wallMs;
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
  (deps: { projectionStore: ProjectionStore; golferStore: GolferStore; clock: Clock; logger: Logger }) =>
  async (archive: RoundArchive): Promise<void> => {
    const finalizedAtMs = finalizedAtMsOf(archive);
    const createdAtMs = createdAtMsOf(archive);

    // Accounts-only identity (spec §7): only ACCOUNT golfers are projected. One batch read of the
    // finalized roster's golfer records decides which participants are account-bound (carry a
    // sub) — a ghost id from old data, or any participant with no golfer row at all, is skipped
    // entirely below (never projected, never throwing). getMany omits absent ids and promises no
    // order (its own port doc), so this builds a Set of the account-bound golferIds to test
    // membership against per participant, rather than relying on the returned order.
    const golferRecords = await deps.golferStore.getMany(archive.participants.map((participant) => participant.golferId));
    const accountBound = new Set(golferRecords.filter((record) => record.sub !== undefined).map((record) => record.golfer.id));

    for (const participant of archive.participants) {
      // Sub-less (a ghost) or no golfer row at all: not an account, so nothing about this round
      // enters their record — no history line, no index recompute, and no presence clear (the
      // presence they may carry from an old pre-accounts join self-expires on its 36h TTL).
      if (!accountBound.has(participant.golferId)) continue;

      const line = archiveGolferLine(archive, participant.golferId);
      await deps.projectionStore.putLine(participant.golferId, { ...line, finalizedAtMs, createdAtMs });

      // Presence cleanup (spec §5, Task 13): an account participant's LIVE pointer, written at
      // seat-time by startRound/joinRound (rounds/presence.ts) — cleared here, the primary removal
      // path, TTL being only a backstop for a round that never finalizes. Only account golfers
      // reach this loop (the sub-less skip above), which is exactly who a pointer was written for
      // now that only account golfers are ever seated. Same at-least-once
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
