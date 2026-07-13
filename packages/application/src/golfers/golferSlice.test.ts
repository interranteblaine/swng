import { describe, expect, it } from "vitest";
import { roundId } from "@swng/domain";
import type { GolferStore } from "../ports/golferStore.js";
import { createInMemoryGolferStore, createInMemoryProjectionStore, createSequentialIds } from "../testing/fakes.js";
import { getMyGolfer } from "./getMyGolfer.js";
import { getMyLiveRounds } from "./getMyLiveRounds.js";
import { getMyRecord } from "./getMyRecord.js";
import { getMyRounds } from "./getMyRounds.js";
import { updateMyGolfer } from "./updateMyGolfer.js";

// claimGolfer's own tests moved to claimGolfer.test.ts (M9 hardening): once claiming needed
// proof of context (a round/crew join code naming the target golferId), every claim test
// needed a journal/roundStore/crewStore-backed setup this file's simpler golferStore-only
// setup doesn't have — a second, purpose-built setup() was cleaner than bolting round/crew
// machinery onto every test in this file, most of which never touch claiming at all.
const setup = (golferStore: GolferStore = createInMemoryGolferStore()) => {
  const idGenerator = createSequentialIds("g");
  const projectionStore = createInMemoryProjectionStore();
  return {
    golferStore,
    projectionStore,
    getMe: getMyGolfer({ golferStore }),
    updateMe: updateMyGolfer({ golferStore, idGenerator }),
    record: getMyRecord({ golferStore, projectionStore }),
    myRounds: getMyRounds({ golferStore, projectionStore }),
    myLiveRounds: getMyLiveRounds({ golferStore, projectionStore }),
  };
};

// GET /me plan amendment (controller-decided): the plan's original "get-or-create" deadlocked
// claiming — the auto-created golfer binds the sub before any later claimGolfer call, so
// every claim would hit "sub already bound elsewhere". getMyGolfer.ts is now read-only;
// updateMyGolfer (PUT /me) is the one create path.
describe("getMyGolfer — never creates", () => {
  it("a fresh sub gets golfer: null, twice, without ever creating a row", async () => {
    const ctx = setup();
    const first = await ctx.getMe({ sub: "sub-1", email: "ann@example.com" });
    expect(first.golfer).toBeNull();

    const second = await ctx.getMe({ sub: "sub-1", email: "ann@example.com" });
    expect(second.golfer).toBeNull();

    expect(await ctx.golferStore.getBySub("sub-1")).toBeUndefined();
  });

  it("PUT /me then GET /me returns the same golferId", async () => {
    const ctx = setup();
    const created = await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});

    const found = await ctx.getMe({ sub: "sub-1" });

    expect(found.golfer?.golferId).toBe(created.golfer.golferId);
  });
});

describe("updateMyGolfer", () => {
  it("patches only the provided fields, leaving the rest as-is", async () => {
    const ctx = setup();
    await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});

    const updated = await ctx.updateMe({ sub: "sub-1" }, { declared: 14.2 });
    expect(updated.golfer.name).toBe("ann"); // untouched
    expect(updated.golfer.declared).toBe(14.2);

    const renamed = await ctx.updateMe({ sub: "sub-1" }, { name: "Annika" });
    expect(renamed.golfer.name).toBe("Annika");
    expect(renamed.golfer.declared).toBe(14.2); // untouched by the second patch
  });

  it("get-or-creates on the first PUT /me — the only create path now GET /me never creates", async () => {
    const ctx = setup();
    const updated = await ctx.updateMe({ sub: "sub-1", email: "bo@example.com" }, { declared: 9.1 });
    expect(updated.golfer.declared).toBe(9.1);
  });

  it("falls back to a bare default name when the JWT carries no email", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    expect(golfer.name).toBe("Golfer");
  });

  it("carries declared and official on the wire as independent fields — no derived effective/computed (the server has no persisted computed index to derive from; the web composes effectiveIndex itself from GET /me + GET /me/record)", async () => {
    const ctx = setup();
    await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    const declaredOnly = await ctx.updateMe({ sub: "sub-1" }, { declared: 14.2 });
    expect(declaredOnly.golfer.declared).toBe(14.2);
    expect(declaredOnly.golfer).not.toHaveProperty("effective");
    expect(declaredOnly.golfer).not.toHaveProperty("computed");

    const withOfficial = await ctx.updateMe({ sub: "sub-1" }, { official: 8.1 });
    expect(withOfficial.golfer.official).toBe(8.1);
    expect(withOfficial.golfer.declared).toBe(14.2); // still on record, unaffected by the official patch
    expect(withOfficial.golfer).not.toHaveProperty("effective");
  });
});

describe("getMyRecord", () => {
  it("returns an empty record for a sub with no golfer at all — no throw, no create", async () => {
    const ctx = setup();
    const record = await ctx.record({ sub: "sub-1" });
    expect(record).toEqual({ history: [] });
  });

  it("bootstrap not met: history present, index absent below 3 differentials", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      ags: 90,
      differential: 9.0,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
    });

    const record = await ctx.record({ sub: "sub-1" });
    expect(record.index).toBeUndefined();
    expect(record.history).toHaveLength(1);
  });

  it("assembles index + history newest-first once the projection store has them", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      ags: 90,
      differential: 9.0,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
    });
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r2"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      ags: 95,
      differential: 14.0,
      distribution: { eagles: 0, birdies: 0, pars: 5, bogeys: 13, doublePlus: 0 },
      finalizedAtMs: 2_000,
    });
    await ctx.projectionStore.putIndex(golfer.golferId, { value: 7.2, computedAtMs: 9_000, differentialsUsed: 2 });

    const record = await ctx.record({ sub: "sub-1" });
    expect(record.index).toEqual({ value: 7.2, computedAtMs: 9_000, differentialsUsed: 2 });
    expect(record.history.map((line) => line.roundId)).toEqual(["r2", "r1"]); // newest first
  });
});

// GET /me/rounds (projection-realignment Task 6): "list my rounds" — same golferStore/
// projectionStore setup as getMyRecord above, since myRounds shares its exact
// get-or-nothing + sortLines-then-reverse discipline (getMyRounds.ts's own doc comment).
describe("getMyRounds", () => {
  it("returns an empty list for a sub with no golfer row at all — no throw, no create", async () => {
    const ctx = setup();
    expect(await ctx.myRounds({ sub: "sub-1" })).toEqual({ rounds: [] });
  });

  it("lists every finalized round newest-first, each line carrying finalizedAt (the wire name for the store's finalizedAtMs)", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      ags: 90,
      differential: 9.0,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
    });
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r2"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      ags: 95,
      differential: 14.0,
      distribution: { eagles: 0, birdies: 0, pars: 5, bogeys: 13, doublePlus: 0 },
      finalizedAtMs: 2_000,
    });

    const result = await ctx.myRounds({ sub: "sub-1" });
    expect(result.rounds.map((line) => line.roundId)).toEqual(["r2", "r1"]); // newest first
    expect(result.rounds.map((line) => line.finalizedAt)).toEqual([2_000, 1_000]);
    // Never the store's own internal field name leaking onto the wire.
    expect(result.rounds.every((line) => !("finalizedAtMs" in line))).toBe(true);
  });

  // Same ordering the sibling getMyRecord assertion above pins — the two responses must never
  // silently disagree on "what order is my history in" (both go through sortLines).
  it("orders identically to GET /me/record's own history for the same golfer", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      ags: 90,
      differential: 9.0,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
    });
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r2"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      ags: 95,
      differential: 14.0,
      distribution: { eagles: 0, birdies: 0, pars: 5, bogeys: 13, doublePlus: 0 },
      finalizedAtMs: 2_000,
    });

    const record = await ctx.record({ sub: "sub-1" });
    const rounds = await ctx.myRounds({ sub: "sub-1" });
    expect(rounds.rounds.map((line) => line.roundId)).toEqual(record.history.map((line) => line.roundId));
  });
});

// GET /me/rounds/live (projection-realignment Task 13): "your rounds, right now" — presence,
// not finalized history (getMyRounds above). Same get-or-nothing discipline; the store is
// exercised directly via putLive (not through startRound/joinRound — those are covered in
// rounds/roundSlice.test.ts's own presence suite) since this file's setup has no round
// journal at all.
describe("getMyLiveRounds", () => {
  it("returns an empty list for a sub with no golfer row at all — no throw, no create", async () => {
    const ctx = setup();
    expect(await ctx.myLiveRounds({ sub: "sub-1" })).toEqual({ rounds: [] });
  });

  it("returns an empty list for a real golfer with no live rounds", async () => {
    const ctx = setup();
    await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    expect(await ctx.myLiveRounds({ sub: "sub-1" })).toEqual({ rounds: [] });
  });

  it("lists live rounds newest-joined first, each carrying courseName + joinedAt (the wire name for joinedAtMs)", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    await ctx.projectionStore.putLive(golfer.golferId, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 1_000, expiresAtSec: 9_999_999_999 });
    await ctx.projectionStore.putLive(golfer.golferId, { roundId: roundId("r2"), courseName: "Pebble Municipal", joinedAtMs: 2_000, expiresAtSec: 9_999_999_999 });

    const result = await ctx.myLiveRounds({ sub: "sub-1" });
    expect(result.rounds).toEqual([
      { roundId: roundId("r2"), courseName: "Pebble Municipal", joinedAt: 2_000 },
      { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAt: 1_000 },
    ]);
    // Never the store's own internal field name leaking onto the wire.
    expect(result.rounds.every((entry) => !("joinedAtMs" in entry))).toBe(true);
  });
});
