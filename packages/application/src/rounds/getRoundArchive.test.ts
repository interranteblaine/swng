import { describe, expect, it } from "vitest";
import { fixtureLinks, golferId, roundId } from "@swng/domain";
import type { RoundArchive } from "@swng/domain";
import { createInMemorySnapshotStore } from "../testing/fakes.js";
import { getRoundArchive } from "./getRoundArchive.js";

const ROUND_ID = roundId("round-1");
const ANN_ID = golferId("ann");

// A minimal-but-real RoundArchive — the exact `events` array is never inspected by
// getRoundArchive beyond passing it straight through, so a placeholder log (never validated
// at this layer) is enough; `card`/`participants` are the fields the authorization check and
// a real ArchivedRoundPage fold actually read.
const buildArchive = (overrides?: Partial<RoundArchive>): RoundArchive => ({
  roundId: ROUND_ID,
  card: fixtureLinks,
  participants: [{ golferId: ANN_ID, name: "Ann", tee: "white", strokes: 0 }],
  games: [],
  cells: {},
  events: [],
  results: [],
  terminatedGameIds: [],
  ...overrides,
});

const setup = () => {
  const snapshots = createInMemorySnapshotStore();
  return { snapshots, archive: getRoundArchive({ snapshots }) };
};

describe("getRoundArchive", () => {
  it("404s round-not-found when no snapshot exists for the round at all", async () => {
    const ctx = setup();
    await expect(ctx.archive({ sub: "sub-ann" }, ROUND_ID)).rejects.toMatchObject({ code: "round-not-found" });
  });

  it("returns the archive's own event log, verbatim, for a signed-in caller", async () => {
    const ctx = setup();
    const events = buildArchive().events; // the placeholder log this archive was built with
    ctx.snapshots.record(buildArchive({ events }));

    const result = await ctx.archive({ sub: "sub-ann" }, ROUND_ID);
    expect(result).toEqual({ events });
  });

  // Navigation spec §6b (binding): the archive read relaxes to any signed-in golfer — a
  // stranger who never played this round and shares no counting crew still gets the event
  // log. The old participant-or-crew-counts authorization (and its golferStore/crewStore
  // deps) is gone; only "does a snapshot exist" gates this read now.
  it("any signed-in golfer reads any finalized archive — a stranger who never played it", async () => {
    const ctx = setup();
    const events = buildArchive().events;
    ctx.snapshots.record(buildArchive({ events }));

    await expect(ctx.archive({ sub: "sub-bo" }, ROUND_ID)).resolves.toEqual({ events });
  });
});
