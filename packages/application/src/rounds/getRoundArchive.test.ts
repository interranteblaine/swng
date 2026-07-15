import { describe, expect, it } from "vitest";
import { crewId, fixtureLinks, golferId, roundId } from "@swng/domain";
import type { Crew, RoundArchive } from "@swng/domain";
import { createInMemoryCrewStore, createInMemoryGolferStore, createInMemorySnapshotStore, putAndBindGolfer } from "../testing/fakes.js";
import { getRoundArchive } from "./getRoundArchive.js";

const ROUND_ID = roundId("round-1");
const ANN_ID = golferId("ann");
const BO_ID = golferId("bo");
const CREW_ID = crewId("crew-1");

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

  // The stranger-403 pin (task-9 crew arm): a non-participant who shares NO counting crew with
  // this round is still rejected — a signed-in golfer who was never in it and whose crews (none
  // here) count nothing.
  it("403s not-a-viewer for a signed-in golfer who is NOT a participant and shares no counting crew — a stranger", async () => {
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

  // The crew-view arm (task-9): a non-participant who belongs to a crew that COUNTS this round
  // may view it — authority flows from the crew's counted set (countsRound), reached via the
  // caller's crews (listByGolfer), never from a back-reference on the round.
  it("returns the event log for a non-participant who is a member of a crew that counts this round", async () => {
    const ctx = setup();
    const events = buildArchive().events;
    ctx.snapshots.record(buildArchive({ events }));
    await putAndBindGolfer(ctx.golferStore, BO_ID, "sub-bo", "Bo");
    // Bo isn't in the round (Ann is the only participant) but is a crew member, and the crew
    // counts this round into a season.
    const crew: Crew = { id: CREW_ID, name: "Sunday Skins", members: [{ golferId: BO_ID, name: "Bo", role: "organizer" }] };
    await ctx.crewStore.put(crew, undefined);
    await ctx.crewStore.putSeason(CREW_ID, { seasonId: "s1", name: "2026", status: "open", createdAtMs: 1_000 });
    await ctx.crewStore.addCountedRound(CREW_ID, "s1", { roundId: ROUND_ID, finalizedAtMs: 2_000, appendedBy: BO_ID, appendedAtMs: 3_000 });

    await expect(ctx.archive({ sub: "sub-bo" }, ROUND_ID)).resolves.toEqual({ events });
  });
});
