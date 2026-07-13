import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import type { SnapshotStore } from "../ports/snapshotStore.js";
import { projectArchive } from "./projectArchive.js";

// Paged backfill over the snapshots table (projection-realignment spec §9, Task 5) — replaces
// the old buffer-everything/sort/wipe-then-replay rebuild outright, not just its data source.
//
// There is nothing left to wipe. The old rebuild wiped a golfer (and a crew/season) before
// replaying because its keys were time-embedded — a stale sk from data that no longer belonged
// could otherwise survive forever. Task 4 moved every golfer-projection write onto a STABLE key
// (`ROUND#<roundId>`, never a time-embedded one) and made projectArchive fully recompute a
// golfer's whole index from every line already on file, every time it runs — so projecting the
// same archive twice, in ANY order, relative to ANY other archive, converges to identical state
// (projectArchive.ts's own doc comment; this file's own idempotence test). A wipe-first step
// only ever protected against a stale key a corrected replay could strand — there is no such key
// anymore, so there is nothing for a wipe to protect against. (The crew ledger projections that
// once needed their own wipe are gone entirely as of Task 9 — crew standings are computed on
// read now — so there is no crew keyspace left for a rebuild to reconcile either.)
//
// Same reasoning kills the old buffer+sort: the old rebuild collected every archive into memory
// and sorted by finalizedAt BEFORE replaying, because a time-embedded key needed writes to land
// in chronological order to converge correctly. projectArchive doesn't care what order it sees
// archives in — order-independence is its own tested property — so this loop streams straight
// off the snapshots table's own page cursor, one page at a time, and never buffers the table.
//
// A partial run (interrupted, or deliberately capped by `maxSnapshots`) leaves the projection
// store simply MISSING whatever wasn't reached yet — never wrong, never wiped — the same
// "eventually consistent, always converges on the next pass" shape the live stream trigger
// already has for a golfer whose finalize hasn't landed yet. Calling this again with the
// returned cursor (or from scratch, with none) always makes forward progress toward "every
// snapshot has been projected at least once," never backward.
export const rebuildProjections =
  (deps: { snapshots: SnapshotStore; projectionStore: ProjectionStore; clock: Clock; logger: Logger }) =>
  async (input?: { readonly cursor?: string; readonly maxSnapshots?: number }): Promise<{ processed: number; cursor?: string }> => {
    const project = projectArchive({ projectionStore: deps.projectionStore, clock: deps.clock, logger: deps.logger });
    const maxSnapshots = input?.maxSnapshots ?? 500;

    // The loop (Task 5 brief, verbatim). The maxSnapshots check runs BETWEEN pages, not
    // per-item — SnapshotStore.page's own items are never partially consumed, so one call can
    // finish slightly over budget (a page that pushes `processed` past maxSnapshots still runs
    // every item it already fetched) but never leaves a page half-projected.
    let cursor = input?.cursor;
    let processed = 0;
    do {
      const page = await deps.snapshots.page(cursor);
      for (const archive of page.snapshots) {
        await project(archive);
        processed += 1;
      }
      cursor = page.cursor;
    } while (cursor !== undefined && processed < maxSnapshots);

    deps.logger.info("projections-rebuilt", { processed, cursor });
    return { processed, ...(cursor !== undefined ? { cursor } : {}) };
  };
