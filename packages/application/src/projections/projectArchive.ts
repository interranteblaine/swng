import type { GolferId, RoundArchive } from "@swng/domain";
import { archiveGolferLine } from "@swng/domain";
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
export const projectArchive =
  (deps: { projectionStore: ProjectionStore; golferStore: GolferStore; logger: Logger }) =>
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
      // enters their record — no history line. Presence IS still cleared for them (below,
      // unconditionally over the ever-seated roster) — identity housekeeping, not projection
      // policy. The handicap index is NOT computed here at all: it is derived at read time in
      // golfers/getMyRecord.ts (pre-prod hardening D4a), so the projector is a pure per-round
      // idempotent upsert with no read-modify-write left to race.
      if (!accountBound.has(participant.golferId)) continue;

      const line = archiveGolferLine(archive, participant.golferId);
      await deps.projectionStore.putLine(participant.golferId, { ...line, finalizedAtMs, createdAtMs });
    }

    // Presence-cleanup is identity housekeeping, not projection policy: every golfer who ever
    // SEATED this round got a LIVE# pointer at join (rounds/presence.ts), including seats the
    // settled archive omits (a departed participant with nothing to settle) and pre-wall ghosts.
    // So the clear runs over the ever-seated roster from the events — never archive.participants —
    // and unconditionally: deleteLive on a pointer that was never written (or already deleted by
    // a replayed delivery) is a no-op, and it needs no golfer-record read. Papercut 11.
    const everSeated = new Set<GolferId>();
    for (const event of archive.events) {
      if (event.kind === "participant-joined") everSeated.add(event.participant.golferId);
    }
    for (const golferId of everSeated) {
      await deps.projectionStore.deleteLive(golferId, archive.roundId);
    }

    // The crew arm is GONE (architecture-realignment Task 9, spec §4/§9): crew standings are
    // computed on read over the snapshots table (crews/getSeasonStandings), never a projection —
    // so a finalized round no longer touches any crew keyspace here. The projector is a
    // golfer-record-only fold now.
    deps.logger.info("archive-projected", { roundId: archive.roundId, participants: archive.participants.length });
  };
