import { describe, expect, it } from "vitest";
import { golferId, placeholderName, roundId } from "@swng/domain";
import { createInMemoryGolferStore, createInMemoryProjectionStore, putAndBindGolfer } from "../testing/fakes.js";
import { getGolfer } from "./getGolfer.js";
import { recordOf } from "./recordOf.js";

// Navigation spec §6a: GET /golfers/{golferId} — the golfer page's read. Any signed-in
// golfer may view any golfer, so unlike getMyRecord this use case takes no claims at all —
// just the target golferId (mirrors getMyRecord's own test harness, minus the sub/claims
// plumbing this route never needs).
const setup = () => {
  const golferStore = createInMemoryGolferStore();
  const projectionStore = createInMemoryProjectionStore();
  return { golferStore, projectionStore, golfer: getGolfer({ golferStore, projectionStore }) };
};

describe("getGolfer", () => {
  it("returns {name, indexSource, metrics, history} for a stored golfer, with metrics/history exactly recordOf(lines)'s own output", async () => {
    const ctx = setup();
    const annId = golferId("ann");
    await putAndBindGolfer(ctx.golferStore, annId, "sub-ann", "Ann");
    const line = {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18 as const,
      par: 72,
      courseHandicap: 8,
      ags: 90,
      differential: 9.0,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
    };
    await ctx.projectionStore.putLine(annId, line);

    const response = await ctx.golfer({ golferId: annId });

    const expected = recordOf([line]);
    expect(response).toEqual({ name: "Ann", indexSource: { kind: "swng" }, metrics: expected.metrics, history: expected.history });
  });

  it("404s golfer-not-found for a golferId with no row at all", async () => {
    const ctx = setup();
    await expect(ctx.golfer({ golferId: golferId("no-such-golfer") })).rejects.toMatchObject({ code: "golfer-not-found" });
  });

  it("serves a placeholder-named golfer's stored placeholder name as-is (no claim/rename machinery here)", async () => {
    const ctx = setup();
    const boId = golferId("bo");
    // Mints exactly like ensureGolfer's own get-or-create: name = f(sub), no rows in the
    // projection store — the "no history yet" case a fresh account is always in.
    await ctx.golferStore.put({ id: boId, name: placeholderName("sub-bo"), handicap: { indexSource: { kind: "swng" } }, namePlaceholder: true }, undefined);
    await ctx.golferStore.bindSub(boId, "sub-bo");

    const response = await ctx.golfer({ golferId: boId });

    expect(response.name).toBe(placeholderName("sub-bo"));
    expect(response.history).toEqual([]);
  });
});
