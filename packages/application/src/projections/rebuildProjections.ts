import type { GolferId, RoundArchive } from "@swng/domain";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import { finalizedAtMsOf, projectArchive } from "./projectArchive.js";

// A source of every finalized archive to replay — the real adapter (M7 Task 3/4) scans the
// rounds table for ARCHIVE items; kept as this narrow, inline-shaped interface (rather than
// a full port) since rebuildProjections is its only consumer.
export interface ArchiveSource {
  listArchives(): AsyncIterable<RoundArchive>;
}

// Same projector, second trigger (M7 plan: "no forked math") — wipes every golfer TOUCHED
// by the archive set FIRST (a stale history line or index snapshot from data that no longer
// belongs must never survive alongside the replay), THEN replays projectArchive over every
// archive in finalizedAt order, so the replay reproduces the exact same incremental history
// the live stream trigger built up one finalize at a time.
//
// ACCEPTED RACE (wipe-replay window): `archives` above is collected from a full-table Scan
// (createDynamoArchiveSource) that necessarily takes some time to finish; the wipe loop only
// runs once that enumeration is done. A round that finalizes — and lands its own live
// projectArchive call via the stream trigger — AFTER the Scan has already passed (or started)
// but BEFORE the wipe step touches that same golfer will have its freshly-written history
// line/index wiped and then never restored, because that archive was never captured in
// `archives` (the Scan predates it). The golfer's projection is then missing that round's
// contribution until the NEXT rebuild re-scans and picks it up — a later, unrelated finalize
// for a different round does not repair it (projectArchive only appends off of what
// listHistory already returns). Operator note: don't run this rebuild while rounds are
// actively finalizing; if one might have raced it, just re-run rebuild once more.
export const rebuildProjections =
  (deps: { archiveSource: ArchiveSource; projectionStore: ProjectionStore; clock: Clock; logger: Logger }) =>
  async (): Promise<{ rounds: number; golfers: number }> => {
    const archives: RoundArchive[] = [];
    const touchedGolfers = new Set<GolferId>();
    for await (const archive of deps.archiveSource.listArchives()) {
      archives.push(archive);
      for (const participant of archive.participants) touchedGolfers.add(participant.golferId);
    }

    for (const golferId of touchedGolfers) {
      await deps.projectionStore.wipeGolfer(golferId);
    }

    const ordered = [...archives].sort((a, b) => finalizedAtMsOf(a) - finalizedAtMsOf(b));
    const project = projectArchive({ projectionStore: deps.projectionStore, clock: deps.clock, logger: deps.logger });
    for (const archive of ordered) {
      await project(archive);
    }

    deps.logger.info("projections-rebuilt", { rounds: ordered.length, golfers: touchedGolfers.size });
    return { rounds: ordered.length, golfers: touchedGolfers.size };
  };
