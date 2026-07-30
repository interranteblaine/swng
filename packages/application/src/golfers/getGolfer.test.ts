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
  it("returns {name, metrics, history} for a stored golfer, with metrics/history exactly recordOf(lines)'s own output", async () => {
    const ctx = setup();
    const annId = golferId("ann");
    await putAndBindGolfer(ctx.golferStore, annId, "sub-ann", "Ann");
    const line = {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18 as const,
      par: 72,
      strokes: 8,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
      createdAtMs: 900,
    };
    await ctx.projectionStore.putLine(annId, line);

    const response = await ctx.golfer({ golferId: annId });

    const expected = recordOf([line]);
    expect(response).toEqual({ name: "Ann", metrics: expected.metrics, history: expected.history });
    // finalizedAt/createdAt (index-chart-polish spec §1.6, the chart's date anchors): asserted
    // directly against the fixture's own stored values, not just agreement-with-recordOf (which
    // would pass even if both sides silently stripped the same fields).
    expect(response.history[0]!.finalizedAt).toBe(1_000);
    expect(response.history[0]!.createdAt).toBe(900);
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
    await ctx.golferStore.put({ id: boId, name: placeholderName("sub-bo"), namePlaceholder: true }, undefined);
    await ctx.golferStore.bindSub(boId, "sub-bo");

    const response = await ctx.golfer({ golferId: boId });

    expect(response.name).toBe(placeholderName("sub-bo"));
    expect(response.history).toEqual([]);
  });
});
