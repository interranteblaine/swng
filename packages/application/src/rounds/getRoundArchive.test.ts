import { describe, expect, it } from "vitest";
import { fixtureLinks, golferId, roundId } from "@swng/domain";
import type { RoundArchive } from "@swng/domain";
import { createInMemoryCrewStore, createInMemoryGolferStore, createInMemorySnapshotStore, putAndBindGolfer } from "../testing/fakes.js";
import { getRoundArchive } from "./getRoundArchive.js";

const ROUND_ID = roundId("round-1");
const ANN_ID = golferId("ann");
const BO_ID = golferId("bo");

// A minimal-but-real RoundArchive — the exact `events` array is never inspected by
// getRoundArchive beyond passing it straight through, so a placeholder log (never validated
// at this layer) is enough; `card`/`participants` are the fields the authorization check and
// a real ArchivedRoundPage fold actually read.
const buildArchive = (overrides?: Partial<RoundArchive>): RoundArchive => ({
  roundId: ROUND_ID,
  card: fixtureLinks,
  participants: [{ golferId: ANN_ID, name: "Ann", tee: "white", courseHandicap: 8 }],
  games: [],
  cells: {},
  events: [],
  results: [],
  terminatedGameIds: [],
  handicapping: [],
  ...overrides,
});

const setup = () => {
  const snapshots = createInMemorySnapshotStore();
  const golferStore = createInMemoryGolferStore();
  const crewStore = createInMemoryCrewStore();
  return { snapshots, golferStore, crewStore, archive: getRoundArchive({ snapshots, golferStore, crewStore }) };
};

describe("getRoundArchive", () => {
  it("404s round-not-found when no snapshot exists for the round at all", async () => {
    const ctx = setup();
    await expect(ctx.archive({ sub: "sub-ann" }, ROUND_ID)).rejects.toMatchObject({ code: "round-not-found" });
  });

  it("returns the archive's own event log, verbatim, for a caller whose account golfer is a participant", async () => {
    const ctx = setup();
    const events = buildArchive().events; // the placeholder log this archive was built with
    ctx.snapshots.record(buildArchive({ events }));
    await putAndBindGolfer(ctx.golferStore, ANN_ID, "sub-ann", "Ann");

    const result = await ctx.archive({ sub: "sub-ann" }, ROUND_ID);
    expect(result).toEqual({ events });
  });

  // The stranger-403 pin (task-6-brief.md's binding resolution): Task 9's crew-membership arm
  // is explicitly deferred, so until it lands every non-participant is rejected the same way —
  // a signed-in golfer who was simply never in this round.
  it("403s not-a-viewer for a signed-in golfer whose account golfer is NOT a participant — a stranger", async () => {
    const ctx = setup();
    ctx.snapshots.record(buildArchive());
    await putAndBindGolfer(ctx.golferStore, BO_ID, "sub-bo", "Bo");

    await expect(ctx.archive({ sub: "sub-bo" }, ROUND_ID)).rejects.toMatchObject({ code: "not-a-viewer" });
  });

  it("403s not-a-viewer for a signed-in caller who has no account golfer row at all", async () => {
    const ctx = setup();
    ctx.snapshots.record(buildArchive());

    await expect(ctx.archive({ sub: "sub-never-seen" }, ROUND_ID)).rejects.toMatchObject({ code: "not-a-viewer" });
  });
});
