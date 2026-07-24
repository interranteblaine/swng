import { describe, expect, it } from "vitest";
import { combineNineHoleDifferentials, computeIndexDetail, courseId, deviceId, fixtureLinks, golferId, golferMetrics, opId, placeholderName, postedDifferential, roundId, swngIndex } from "@swng/domain";
import type { GolferStore } from "../ports/golferStore.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import { createFrozenClock, createInMemoryGolferStore, createInMemoryJournal, createInMemoryProjectionStore, createSequentialIds } from "../testing/fakes.js";
import { getMyCourseRecord } from "./getMyCourseRecord.js";
import { getMyGolfer } from "./getMyGolfer.js";
import { getMyLiveRounds } from "./getMyLiveRounds.js";
import { getMyRecord } from "./getMyRecord.js";
import { getMyRounds } from "./getMyRounds.js";
import { updateMyGolfer } from "./updateMyGolfer.js";

// getMyRecord's read-time index fold (pre-prod hardening D4a) needs a frozen clock so
// computedAtMs is a known, assertable value rather than a live Date.now() read.
const FROZEN_NOW = 9_999;

// Accounts-only identity (spec §1): there are no ghosts and nothing to claim, so this file's
// golfer surface is get-or-create (GET /me / PUT /me via ensureGolfer) plus the record/rounds
// reads — no claim machinery at all. A simple golferStore-backed setup covers all of it.
const setup = (golferStore: GolferStore = createInMemoryGolferStore()) => {
  const idGenerator = createSequentialIds("g");
  const projectionStore = createInMemoryProjectionStore();
  const journal = createInMemoryJournal();
  const clock = createFrozenClock(FROZEN_NOW);
  return {
    golferStore,
    projectionStore,
    journal,
    getMe: getMyGolfer({ golferStore, idGenerator }),
    updateMe: updateMyGolfer({ golferStore, idGenerator }),
    record: getMyRecord({ golferStore, projectionStore, clock }),
    courseRecord: getMyCourseRecord({ golferStore, projectionStore }),
    myRounds: getMyRounds({ golferStore, projectionStore }),
    myLiveRounds: getMyLiveRounds({ golferStore, projectionStore, journal }),
  };
};

// GET /me get-or-creates (accounts-only identity spec §2, controller ruling — DELIBERATELY reverses
// the M7 "GET /me never creates" rule this block used to pin). That rule existed only to protect
// claimable ghosts (an auto-create bound the sub before a later claim could run); the spec kills
// ghosts, so the first authenticated GET /me now mints the caller's golfer.
describe("getMyGolfer — get-or-creates", () => {
  it("a fresh sub MINTS a golfer named f(sub) with namePlaceholder: true, and a second GET returns the SAME golfer", async () => {
    const ctx = setup();
    const first = await ctx.getMe({ sub: "sub-1" });
    expect(first.golfer).not.toBeNull();
    expect(first.golfer?.name).toBe(placeholderName("sub-1"));
    expect(first.golfer?.namePlaceholder).toBe(true);
    // Cognito is a pure authenticator — the name is f(sub), never the email localpart.
    expect(first.golfer?.name).not.toBe("ann");

    const second = await ctx.getMe({ sub: "sub-1" });
    expect(second.golfer?.golferId).toBe(first.golfer?.golferId);
    // Exactly one row, bound to the sub — the second GET read it, never minted a second.
    expect((await ctx.golferStore.getBySub("sub-1"))?.golfer.id).toBe(first.golfer?.golferId);
  });

  it("PUT /me then GET /me returns the same golferId", async () => {
    const ctx = setup();
    const created = await ctx.updateMe({ sub: "sub-1" }, {});

    const found = await ctx.getMe({ sub: "sub-1" });

    expect(found.golfer?.golferId).toBe(created.golfer.golferId);
  });
});

// The placeholder is the invariant's backstop, not the UX (accounts-only identity spec §2): a real
// name via PUT /me drops the flag; a PUT that never touches the name preserves it.
describe("namePlaceholder lifecycle", () => {
  it("a real-name PUT /me DROPS the flag (absent = false, never rewritten to false), and it stays dropped on re-read", async () => {
    const ctx = setup();
    const minted = await ctx.getMe({ sub: "sub-1" });
    expect(minted.golfer?.namePlaceholder).toBe(true);

    const renamed = await ctx.updateMe({ sub: "sub-1" }, { name: "Annika" });
    expect(renamed.golfer.name).toBe("Annika");
    expect(renamed.golfer).not.toHaveProperty("namePlaceholder");

    const reread = await ctx.getMe({ sub: "sub-1" });
    expect(reread.golfer).not.toHaveProperty("namePlaceholder");
  });

  it("a PUT /me that leaves the name untouched (an index-source-only edit) PRESERVES the flag", async () => {
    const ctx = setup();
    await ctx.getMe({ sub: "sub-1" }); // mint with the flag

    const patched = await ctx.updateMe({ sub: "sub-1" }, { indexSource: { kind: "declared", value: 12.0 } });
    expect(patched.golfer.namePlaceholder).toBe(true);
    expect(patched.golfer.indexSource).toEqual({ kind: "declared", value: 12.0 });
  });
});

describe("updateMyGolfer", () => {
  it("patches only the provided fields, leaving the rest as-is", async () => {
    const ctx = setup();
    // First PUT (empty patch) get-or-creates via ensureGolfer: the create name is the sub-derived
    // placeholder (Cognito is a pure authenticator — never the email localpart), flag preserved by
    // the declared-only patch.
    await ctx.updateMe({ sub: "sub-1" }, {});

    const updated = await ctx.updateMe({ sub: "sub-1" }, { indexSource: { kind: "declared", value: 14.2 } });
    expect(updated.golfer.name).toBe(placeholderName("sub-1")); // untouched — still the placeholder, never "ann"
    expect(updated.golfer.indexSource).toEqual({ kind: "declared", value: 14.2 });

    const renamed = await ctx.updateMe({ sub: "sub-1" }, { name: "Annika" });
    expect(renamed.golfer.name).toBe("Annika");
    expect(renamed.golfer.indexSource).toEqual({ kind: "declared", value: 14.2 }); // untouched by the second patch
  });

  it("get-or-creates on the first PUT /me — one shared ensureGolfer path (GET /me get-or-creates too)", async () => {
    const ctx = setup();
    const updated = await ctx.updateMe({ sub: "sub-1" }, { indexSource: { kind: "declared", value: 9.1 } });
    expect(updated.golfer.indexSource).toEqual({ kind: "declared", value: 9.1 });
  });

  it("creates with the sub-derived placeholder name, NEVER the email localpart (Cognito is a pure authenticator), on the default swng source", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    expect(golfer.name).toBe(placeholderName("sub-1"));
    expect(golfer.name).not.toBe("ann");
    expect(golfer.namePlaceholder).toBe(true);
    // A fresh mint is on the default source (index-source model spec §3).
    expect(golfer.indexSource).toEqual({ kind: "swng" });
  });

  it("carries indexSource on the wire as the sole handicap field — no declared/computed/effective/official (index-source model spec §3); adopting a computed source stores the SOURCE, not a value", async () => {
    const ctx = setup();
    await ctx.updateMe({ sub: "sub-1" }, {});
    const declaredOnly = await ctx.updateMe({ sub: "sub-1" }, { indexSource: { kind: "declared", value: 14.2 } });
    expect(declaredOnly.golfer.indexSource).toEqual({ kind: "declared", value: 14.2 });
    expect(declaredOnly.golfer).not.toHaveProperty("declared");
    expect(declaredOnly.golfer).not.toHaveProperty("effective");
    expect(declaredOnly.golfer).not.toHaveProperty("computed");
    expect(declaredOnly.golfer).not.toHaveProperty("official");

    // Adopting WHS stores the SOURCE — no computed number is copied into the profile (spec §2, the
    // whole point): the wire carries `{ kind: "whs" }`, never a cached value.
    const onWhs = await ctx.updateMe({ sub: "sub-1" }, { indexSource: { kind: "whs" } });
    expect(onWhs.golfer.indexSource).toEqual({ kind: "whs" });
    expect(onWhs.golfer).not.toHaveProperty("declared");
  });
});

describe("getMyRecord", () => {
  it("returns an empty record (no computed indexes, zeroed typicalEighteen, empty indexHistory, empty history) for a sub with no golfer at all — no throw, no create", async () => {
    const ctx = setup();
    const record = await ctx.record({ sub: "sub-1" });
    expect(record).toEqual({
      metrics: { typicalEighteen: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 }, indexHistory: [], bests: {}, milestones: [] },
      history: [],
    });
  });

  it("bootstrap not met: history present, whsIndex absent below 3 differentials", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      par: 72,
      courseHandicap: 8,
      ags: 90,
      differential: 9.0,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
    });

    const record = await ctx.record({ sub: "sub-1" });
    expect(record.metrics.whsIndex).toBeUndefined();
    expect(record.history).toHaveLength(1);
  });

  // unrated-courses spec §6: a wholly-unrated history (every line has an ags but no differential —
  // no rating/slope to post one) yields a swngIndex (the neutral ags−par estimate) but no
  // whsIndex (Rule 5.2a needs rated differentials, which unrated rounds never carry).
  it("a wholly-unrated history yields metrics.swngIndex but no metrics.whsIndex", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    const unrated = [
      { roundId: roundId("r1"), ags: 96, finalizedAtMs: 1_000 },
      { roundId: roundId("r2"), ags: 101, finalizedAtMs: 2_000 },
      { roundId: roundId("r3"), ags: 94, finalizedAtMs: 3_000 },
    ];
    for (const line of unrated) {
      await ctx.projectionStore.putLine(golfer.golferId, {
        roundId: line.roundId,
        courseName: "Nine Pines (unrated)",
        tee: "no-card",
        holes: 18,
        par: 72,
        courseHandicap: 20,
        ags: line.ags, // no differential — an unrated tee posts none
        distribution: { eagles: 0, birdies: 0, pars: 4, bogeys: 10, doublePlus: 4 },
        finalizedAtMs: line.finalizedAtMs,
      });
    }

    const record = await ctx.record({ sub: "sub-1" });
    expect(record.metrics.whsIndex).toBeUndefined();
    expect(record.metrics.swngIndex).toBeDefined();
    const expected = swngIndex(unrated.map((l) => ({ ags: l.ags, par: 72, holes: 18 as const })))!;
    expect(record.metrics.swngIndex).toEqual({ value: expected.value, differentialsUsed: expected.differentialsUsed });
    expect(record.history).toHaveLength(3);
  });

  // courseId (course-cards spec §4, the analytics join key): carried when the stored line has
  // it, omitted for a pre-scrap line without it — absent means ABSENT, never an explicit
  // undefined key (toWireLine's conditional-spread idiom, same as ags/differential).
  // finalizedAt/createdAt (index-chart-polish spec §1.6, the chart's date anchors): finalizedAt
  // always equals the stored finalizedAtMs; createdAt carries only when the line has createdAtMs.
  it("carries courseId/finalizedAt/createdAt on a history line when the stored line has them, omitting courseId/createdAt for a line without", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      courseId: courseId("course-1"),
      tee: "white",
      holes: 18,
      par: 72,
      courseHandicap: 8,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 2_000,
      createdAtMs: 1_900,
    });
    // A pre-scrap line: no courseId, no createdAtMs at all (frozen before cards carried a source).
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r0"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      par: 72,
      courseHandicap: 8,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
    });

    const record = await ctx.record({ sub: "sub-1" });
    expect(record.history.map((line) => line.roundId)).toEqual(["r1", "r0"]); // newest first
    expect(record.history[0]!.courseId).toBe(courseId("course-1"));
    expect(record.history[1]).not.toHaveProperty("courseId");
    expect(record.history[0]!.finalizedAt).toBe(2_000);
    expect(record.history[0]!.createdAt).toBe(1_900);
    expect(record.history[1]!.finalizedAt).toBe(1_000);
    expect(record.history[1]).not.toHaveProperty("createdAt");
  });

  // Below the 3-differential bootstrap (Rule 5.2a's own minimum), the whsIndex is ABSENT, not
  // zero — computeIndexDetail itself returns undefined under 3 (whs.ts), and getMyRecord
  // must pass that absence straight through, never coercing it into a 0 the wire schema
  // could mistake for a real (if unlikely) index value.
  it("below the 3-differential bootstrap the whsIndex is ABSENT, not zero", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      par: 72,
      courseHandicap: 8,
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
      par: 72,
      courseHandicap: 8,
      ags: 95,
      differential: 14.0,
      distribution: { eagles: 0, birdies: 0, pars: 5, bogeys: 13, doublePlus: 0 },
      finalizedAtMs: 2_000,
    });

    const record = await ctx.record({ sub: "sub-1" });
    expect(record.metrics.whsIndex).toBeUndefined();
    expect(record.history).toHaveLength(2);
  });

  // The pre-prod hardening headline pin (D4a): the index is computed HERE, at read time, from
  // the SAME lines this response already carries — never a stored snapshot (no putIndex call
  // anywhere in this test). The oracle is the identical domain fold projectArchive used to run
  // (sortLines -> combineNineHoleDifferentials -> computeIndexDetail), proving getMyRecord's
  // wire index agrees with it byte-for-byte, with computedAtMs pinned to this setup's frozen
  // clock rather than a live wall-clock read.
  it("computes the index at read time from the history lines — no stored snapshot is consulted", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    const seededCompleteLines = [
      { roundId: roundId("r1"), ags: 90, differential: 9.0, finalizedAtMs: 1_000 },
      { roundId: roundId("r2"), ags: 95, differential: 14.0, finalizedAtMs: 2_000 },
      { roundId: roundId("r3"), ags: 92, differential: 11.0, finalizedAtMs: 3_000 },
    ];
    for (const line of seededCompleteLines) {
      await ctx.projectionStore.putLine(golfer.golferId, {
        roundId: line.roundId,
        courseName: "Casa Verde GC",
        tee: "white",
        holes: 18,
        par: 72,
        courseHandicap: 8,
        ags: line.ags,
        differential: line.differential,
        distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
        finalizedAtMs: line.finalizedAtMs,
      });
    }

    const response = await ctx.record({ sub: "sub-1" });

    const expected = computeIndexDetail(combineNineHoleDifferentials(seededCompleteLines.map((l) => ({ differential: l.differential, holes: 18 }))))!;
    expect(response.metrics.whsIndex).toEqual({ value: expected.value, computedAtMs: FROZEN_NOW, differentialsUsed: expected.differentialsUsed });
    expect(response.history.map((line) => line.roundId)).toEqual(["r3", "r2", "r1"]); // newest first
  });

  // ProjectionStore.listLines is UNORDERED by contract (ports/projectionStore.ts) — the stable
  // ROUND# sk carries no time to sort by. This proves getMyRecord itself imposes the
  // (finalizedAtMs, roundId) order BEFORE the index fold (the fold moved here from the
  // projector with D4a — this pin replaces projectArchive's own former version of the same
  // proof), via a fake store whose listLines returns lines in the OPPOSITE order from how they
  // were logically produced. combineNineHoleDifferentials pairs ADJACENT entries positionally
  // (its own doc comment) — feeding it unsorted mispairs everyone, not just reorders the same
  // pairs: 7 nine-hole lines, chronological r1..r7, sorted ascending pairs (r1,r2)=1+2=3,
  // (r3,r4)=3+4=7, (r5,r6)=5+6=11, r7 pending → combined=[3,7,11]. A wrong implementation that
  // skips the sort would fold the REVERSED feed into a DIFFERENT value entirely, not just a
  // reordering of the same one.
  it("sorts lines by finalizedAtMs before folding — an out-of-order store never mispairs 9-hole differentials", async () => {
    const nineHoleLine = (id: string, finalizedAtMs: number, differential: number) => ({
      roundId: roundId(id),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 9 as const,
      par: 36,
      courseHandicap: 5,
      differential,
      distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
      finalizedAtMs,
    });
    const chronological = [
      nineHoleLine("r1", 1_000, 1),
      nineHoleLine("r2", 2_000, 2),
      nineHoleLine("r3", 3_000, 3),
      nineHoleLine("r4", 4_000, 4),
      nineHoleLine("r5", 5_000, 5),
      nineHoleLine("r6", 6_000, 6),
      nineHoleLine("r7", 7_000, 7),
    ];
    const reversed = [...chronological].reverse();
    const outOfOrderStore: ProjectionStore = {
      putLine: async () => {},
      listLines: async () => reversed,
      putLive: async () => {},
      deleteLive: async () => {},
      listLive: async () => [],
    };
    const golferStore = createInMemoryGolferStore();
    await golferStore.put({ id: golferId("ann"), name: "Ann", handicap: { indexSource: { kind: "swng" } } }, undefined);
    await golferStore.bindSub(golferId("ann"), "sub-ann");
    const record = getMyRecord({ golferStore, projectionStore: outOfOrderStore, clock: createFrozenClock(FROZEN_NOW) });

    const response = await record({ sub: "sub-ann" });

    const expected = computeIndexDetail(combineNineHoleDifferentials([3, 7, 11].map((differential) => ({ differential, holes: 18 }))))!;
    expect(response.metrics.whsIndex).toEqual({ value: expected.value, computedAtMs: FROZEN_NOW, differentialsUsed: expected.differentialsUsed });
  });

  // Papercut 17 (task 3, the wire cut) — typicalEighteen + indexHistory are the SAME
  // golferMetrics fold as whsIndex/swngIndex above, just two more members: this proves the
  // wire's typicalEighteen/indexHistory agree byte-for-byte with calling golferMetrics
  // directly over the same (sorted, RAW) lines, for a mixed rated/unrated/incomplete
  // fixture (six rated rounds, one unrated ags-bearing round, one no-ags-at-all incomplete
  // card). It ALSO proves the posted (0.1-rounded) wire differential never leaks into the
  // index fold: r3/r6's raw differentials (3.0, 3.05) are deliberately the two LOWEST rated
  // values in a 6-differential window (use=2), so folding the POSTED values (3.0, 3.1)
  // instead of the raw ones would shift both whsIndex and swngIndex by a full tenth
  // (2.0->2.1, 3.0->3.1) — a real, not merely notional, regression trap for "getMyRecord
  // accidentally computes golferMetrics over toWireLine's rounded output" rather than the
  // raw `sorted` lines.
  it("typicalEighteen + indexHistory on the wire equal golferMetrics(sorted); the headline index is computed from RAW differentials even though the wire differential is posted to 0.1", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    const line = (id: string, ms: number, extra: { ags?: number; differential?: number }) => ({
      roundId: roundId(id),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18 as const,
      par: 72,
      courseHandicap: 8,
      distribution: { eagles: 0, birdies: 1, pars: 10, bogeys: 5, doublePlus: 2 },
      finalizedAtMs: ms,
      ...extra,
    });
    const stored = [
      line("r1", 1_000, { ags: 110, differential: 20.0 }),
      line("r2", 2_000, { ags: 111, differential: 21.0 }),
      line("r3", 3_000, { ags: 75, differential: 3.0 }), // one of the two lowest rated differentials
      { ...line("r4", 4_000, { ags: 97 }), courseName: "Nine Pines (unrated)", tee: "no-card", courseHandicap: 20 }, // unrated — no differential
      line("r5", 5_000, { ags: 112, differential: 22.0 }),
      line("r6", 6_000, { ags: 76, differential: 3.05 }), // the OTHER lowest — raw, non-tenth: pins the wire rounding below
      line("r7", 7_000, { ags: 113, differential: 23.0 }),
      { ...line("r8", 8_000, {}), distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 } }, // incomplete — no ags, no differential
    ];
    for (const l of stored) await ctx.projectionStore.putLine(golfer.golferId, l);

    const record = await ctx.record({ sub: "sub-1" });

    // The oracle: golferMetrics over the SAME (raw) lines, sorted oldest -> newest — the
    // identical fold getMyRecord itself runs (its own sortLines contract).
    const sortedOldestFirst = [...stored].sort((a, b) => a.finalizedAtMs - b.finalizedAtMs);
    const expected = golferMetrics(sortedOldestFirst);
    expect(record.metrics.typicalEighteen).toEqual(expected.typicalEighteen);
    expect(record.metrics.indexHistory).toEqual(expected.indexHistory);

    // The headline still agrees with the RAW-line oracle: best-2-of-6 rated differentials are
    // {3.0, 3.05} (avg 3.025, adjustment -1.0) -> whsIndex 2.0; best-2-of-7 ags-bearing entries
    // are the same pair (adjustment 0) -> swngIndex 3.0. Folding the POSTED pair {3.0, 3.1}
    // instead would land on 2.1 / 3.0->3.1 respectively — a materially different number.
    expect(record.metrics.whsIndex).toEqual({ ...expected.whsIndex, value: 2.0, differentialsUsed: 2, computedAtMs: FROZEN_NOW });
    expect(record.metrics.swngIndex).toEqual({ ...expected.swngIndex, value: 3.0, differentialsUsed: 2 });

    // The wire differential is the POSTED (0.1) value, never the raw float: r6's raw 3.05 posts
    // as 3.1 (postedDifferential's own ".05 rounds up" rule), while r3's raw 3.0 is already a
    // tenth and posts unchanged — yet the headline above used the RAW 3.0/3.05, not 3.0/3.1.
    expect(record.history.find((l) => l.roundId === roundId("r6"))?.differential).toBe(postedDifferential(3.05));
    expect(record.history.find((l) => l.roundId === roundId("r6"))?.differential).toBe(3.1);
    expect(record.history.find((l) => l.roundId === roundId("r3"))?.differential).toBe(3.0);
  });
});

// GET /me/courses/{courseId}/record (analytics spec 2026-07-21 §4): the getMyRecord idiom
// exactly, filtered to one course via domain's courseRecord (courseRecord.test.ts owns the fold's
// own tie-break/gating rules — this file proves the use case's own get-or-nothing wiring + the
// filter actually reaches only the requested course).
describe("getMyCourseRecord", () => {
  it("returns an honest empty record (rounds: 0) for a sub with no golfer row at all — no throw, no create", async () => {
    const ctx = setup();
    const record = await ctx.courseRecord({ sub: "sub-1" }, courseId("course-1"));
    expect(record).toEqual({ courseId: courseId("course-1"), rounds: 0 });
  });

  it("round-trips a two-course line set: filters to just the requested course, ignoring the other course's lines entirely", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    // fullyHoledOut (analytics.ts) requires 18 strokes-kind holeResults summing to `gross` — the
    // par-4-every-hole shape with the "over" strokes loaded onto the first N holes is arbitrary
    // but sums correctly; courseRecord's best/scoringAverage only consume the sum + line par.
    const holeResultsFor = (gross: number) => {
      const over = gross - 72;
      return Array.from({ length: 18 }, (_, i) => ({ hole: i + 1, par: 4, result: { kind: "strokes" as const, strokes: 4 + (i < over ? 1 : 0) } }));
    };
    const line = (id: string, ms: number, course: { id: string; name: string }, gross: number) => ({
      roundId: roundId(id),
      courseName: course.name,
      courseId: courseId(course.id),
      tee: "white",
      holes: 18 as const,
      par: 72,
      courseHandicap: 8,
      ags: gross,
      differential: gross - 72,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      holeResults: holeResultsFor(gross),
      finalizedAtMs: ms,
    });
    const courseA = { id: "course-1", name: "Casa Verde GC" };
    const courseB = { id: "course-2", name: "Pebble Municipal" };
    await ctx.projectionStore.putLine(golfer.golferId, line("r1", 1_000, courseA, 90));
    await ctx.projectionStore.putLine(golfer.golferId, line("r2", 2_000, courseA, 84));
    await ctx.projectionStore.putLine(golfer.golferId, line("r3", 3_000, courseB, 79));

    const record = await ctx.courseRecord({ sub: "sub-1" }, courseId("course-1"));

    // Two lines at course-1 only — course-2's r3 (a lower gross, which would otherwise win
    // "best") never enters the fold.
    expect(record).toEqual({
      courseId: courseId("course-1"),
      rounds: 2,
      best: { roundId: roundId("r2"), gross: 84, toPar: 12 },
      scoringAverage: 87.0,
    });
  });

  it("a sub with a real golfer but zero lines at the requested course returns rounds: 0, not a throw", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Pebble Municipal",
      courseId: courseId("course-2"),
      tee: "white",
      holes: 18,
      par: 72,
      courseHandicap: 8,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
    });

    const record = await ctx.courseRecord({ sub: "sub-1" }, courseId("course-1"));
    expect(record).toEqual({ courseId: courseId("course-1"), rounds: 0 });
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
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      par: 72,
      courseHandicap: 8,
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
      par: 72,
      courseHandicap: 8,
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

  // createdAt (accounts-only identity spec §5, the "course + date" designation): carried when the
  // line has it, omitted for legacy lines written before the field existed (tolerated, no migration).
  it("carries createdAt (the round-created wall time) when the line has it, omitting it for a legacy line", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      par: 72,
      courseHandicap: 8,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 2_000,
      createdAtMs: 1_500,
    });
    // A legacy line: no createdAtMs at all (an older projection write).
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r0"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      par: 72,
      courseHandicap: 8,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
    });

    const result = await ctx.myRounds({ sub: "sub-1" });
    expect(result.rounds.map((line) => line.roundId)).toEqual(["r1", "r0"]); // newest first
    expect(result.rounds[0]!.createdAt).toBe(1_500);
    expect(result.rounds[1]).not.toHaveProperty("createdAt");
  });

  // courseId (course-cards spec §4, the analytics join key): same carried-or-ABSENT discipline
  // as getMyRecord's history above — never an explicit undefined key on the wire.
  it("carries courseId when the stored line has it, omitting it for a pre-scrap line without", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      courseId: courseId("course-1"),
      tee: "white",
      holes: 18,
      par: 72,
      courseHandicap: 8,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 2_000,
    });
    // A pre-scrap line: no courseId at all (frozen before cards carried a source).
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r0"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      par: 72,
      courseHandicap: 8,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
    });

    const result = await ctx.myRounds({ sub: "sub-1" });
    expect(result.rounds.map((line) => line.roundId)).toEqual(["r1", "r0"]); // newest first
    expect(result.rounds[0]!.courseId).toBe(courseId("course-1"));
    expect(result.rounds[1]).not.toHaveProperty("courseId");
  });

  // Same ordering the sibling getMyRecord assertion above pins — the two responses must never
  // silently disagree on "what order is my history in" (both go through sortLines).
  it("orders identically to GET /me/record's own history for the same golfer", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      par: 72,
      courseHandicap: 8,
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
      par: 72,
      courseHandicap: 8,
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
    await ctx.updateMe({ sub: "sub-1" }, {});
    expect(await ctx.myLiveRounds({ sub: "sub-1" })).toEqual({ rounds: [] });
  });

  it("lists live rounds newest-joined first, each carrying courseName + joinedAt (the wire name for joinedAtMs)", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
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

  // createdAt (accounts-only identity spec §5): derived at read time from the round's genesis, a
  // round-level fact — carried when the round exists, omitted for a stale pointer (the 36h TTL
  // backstop outliving a vanished round).
  it("carries createdAt derived from the round's genesis, omitting it for a stale pointer with no round behind it", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    // A real live round's genesis on the journal (wall time 7_777).
    await ctx.journal.append(roundId("r1"), [
      { kind: "round-created", roundId: roundId("r1"), card: fixtureLinks, opId: opId("g1"), hlc: { wallMs: 7_777, counter: 0, deviceId: deviceId("test") }, authorId: golferId("author") },
    ]);
    await ctx.projectionStore.putLive(golfer.golferId, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 1_000, expiresAtSec: 9_999_999_999 });
    // A stale presence pointer whose round never existed / has vanished.
    await ctx.projectionStore.putLive(golfer.golferId, { roundId: roundId("r2"), courseName: "Ghost Course", joinedAtMs: 2_000, expiresAtSec: 9_999_999_999 });

    const result = await ctx.myLiveRounds({ sub: "sub-1" });
    const r1 = result.rounds.find((entry) => entry.roundId === roundId("r1"))!;
    const r2 = result.rounds.find((entry) => entry.roundId === roundId("r2"))!;
    expect(r1.createdAt).toBe(7_777);
    expect(r2).not.toHaveProperty("createdAt");
  });
});
