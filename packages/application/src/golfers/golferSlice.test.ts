import { describe, expect, it } from "vitest";
import { golferId, roundId } from "@swng/domain";
import type { GolferStore } from "../ports/golferStore.js";
import { createInMemoryGolferStore, createInMemoryProjectionStore, createSequentialIds } from "../testing/fakes.js";
import { claimGolfer } from "./claimGolfer.js";
import { getMyGolfer } from "./getMyGolfer.js";
import { getMyRecord } from "./getMyRecord.js";
import { updateMyGolfer } from "./updateMyGolfer.js";

const setup = (golferStore: GolferStore = createInMemoryGolferStore()) => {
  const idGenerator = createSequentialIds("g");
  const projectionStore = createInMemoryProjectionStore();
  return {
    golferStore,
    projectionStore,
    getMe: getMyGolfer({ golferStore }),
    updateMe: updateMyGolfer({ golferStore, idGenerator }),
    claim: claimGolfer({ golferStore }),
    record: getMyRecord({ golferStore, projectionStore }),
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

  it("official wins effective-index precedence over both computed and declared, matching domain's effectiveIndex", async () => {
    const ctx = setup();
    await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {});
    const declaredOnly = await ctx.updateMe({ sub: "sub-1" }, { declared: 14.2 });
    expect(declaredOnly.golfer.effective).toEqual({ value: 14.2, source: "declared" });

    const withOfficial = await ctx.updateMe({ sub: "sub-1" }, { official: 8.1 });
    expect(withOfficial.golfer.effective).toEqual({ value: 8.1, source: "official" });
    expect(withOfficial.golfer.declared).toBe(14.2); // still on record, just outranked
  });
});

describe("claimGolfer — happy path", () => {
  it("binds an unbound sub (no prior GET/PUT /me) to an unclaimed ghost golferId, seeding a name from the claims", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-1");

    const claimed = await ctx.claim({ sub: "sub-1", email: "cal@example.com" }, { golferId: ghost });
    expect(claimed.golfer.golferId).toBe(ghost);
    expect(claimed.golfer.name).toBe("cal");

    const bound = await ctx.golferStore.getBySub("sub-1");
    expect(bound?.golfer.id).toBe(ghost);
  });
});

describe("claimGolfer — collision arm 1: golfer already claimed", () => {
  it("a second claimant on the same golferId is rejected", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-1");
    await ctx.claim({ sub: "sub-a" }, { golferId: ghost });

    await expect(ctx.claim({ sub: "sub-b" }, { golferId: ghost })).rejects.toMatchObject({ code: "golfer-already-claimed" });

    // The first claimant's binding survives the failed second attempt untouched.
    const bound = await ctx.golferStore.get(ghost);
    expect(bound?.sub).toBe("sub-a");
  });
});

describe("claimGolfer — collision arm 2: sub already bound to another golfer", () => {
  it("a sub already bound via a prior PUT /me is rejected BEFORE the target golferId is ever touched", async () => {
    const ctx = setup();
    const alreadyMine = (await ctx.updateMe({ sub: "sub-1", email: "ann@example.com" }, {})).golfer.golferId;
    const otherGhost = golferId("ghost-2");

    await expect(ctx.claim({ sub: "sub-1" }, { golferId: otherGhost })).rejects.toMatchObject({ code: "golfer-already-claimed" });

    // The precheck short-circuited before ever calling golferStore.claim — the target
    // golferId was never created, and sub-1's own binding is unchanged.
    expect(await ctx.golferStore.get(otherGhost)).toBeUndefined();
    const stillMine = await ctx.golferStore.getBySub("sub-1");
    expect(stillMine?.golfer.id).toBe(alreadyMine);
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
    await ctx.projectionStore.putHistoryLine(golfer.golferId, {
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
    await ctx.projectionStore.putHistoryLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      ags: 90,
      differential: 9.0,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
    });
    await ctx.projectionStore.putHistoryLine(golfer.golferId, {
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
