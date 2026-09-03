import { describe, expect, it } from "vitest";
import { courseId, deviceId, fixtureLinks, golferId, golferMetrics, opId, placeholderName, roundId } from "@swng/domain";
import type { GolferStore } from "../ports/golferStore.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import { createCapturingMetrics, createInMemoryGolferStore, createInMemoryJournal, createInMemoryProjectionStore, createSequentialIds } from "../testing/fakes.js";
import { getMyCourseRecord } from "./getMyCourseRecord.js";
import { getMyGolfer } from "./getMyGolfer.js";
import { getMyLiveRounds } from "./getMyLiveRounds.js";
import { getMyRecord } from "./getMyRecord.js";
import { getMyRounds } from "./getMyRounds.js";
import { updateMyGolfer } from "./updateMyGolfer.js";

// A scored 18 on a par-72 card: every hole a stroke count, so `hasCompleteScore` holds and the
// line feeds the average (spec 2026-07-29 §2d). gross = 18 x perHole, so vs-par = gross - 72.
// playedAtMs (spec 2026-08-01 §4a) mirrors finalizedAtMs here — no test in this file needs the
// two to diverge (that distinction is projectionSlice.test.ts's own "stamps the line's
// playedAtMs" pin), so the same ascending sequence every caller already passes for
// finalizedAtMs orders correctly under sortLines' new playedAtMs key too.
const scoredLine = (id: string, finalizedAtMs: number, perHole: number) => ({
  roundId: roundId(id),
  courseName: "Casa Verde GC",
  tee: "white",
  holes: 18 as const,
  par: 72,
  strokes: 8,
  score: 18 * perHole,
  distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  holeResults: Array.from({ length: 18 }, (_, i) => ({ hole: i + 1, par: 4, result: { kind: "strokes" as const, strokes: perHole } })),
  finalizedAtMs,
  playedAtMs: finalizedAtMs,
});

// Accounts-only identity (spec §1): there are no ghosts and nothing to claim, so this file's
// golfer surface is get-or-create (GET /me / PUT /me via ensureGolfer) plus the record/rounds
// reads — no claim machinery at all. A simple golferStore-backed setup covers all of it.
const setup = (golferStore: GolferStore = createInMemoryGolferStore()) => {
  const idGenerator = createSequentialIds("g");
  const projectionStore = createInMemoryProjectionStore();
  const journal = createInMemoryJournal();
  return {
    golferStore,
    projectionStore,
    journal,
    getMe: getMyGolfer({ golferStore, idGenerator }),
    updateMe: updateMyGolfer({ golferStore, idGenerator }),
    record: getMyRecord({ golferStore, projectionStore }),
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

// Reachability pin (fix: thread metrics to ensureGolfer): getMyGolfer forwards its whole `deps`
// (including an optional `metrics`) straight to ensureGolfer, so a metrics sink threaded in here
// must reach ensureGolfer's own mint branch — proving the wiring actually connects an outer use
// case to the Signups emit, not just that ensureGolfer.test.ts's own direct construction does.
describe("getMyGolfer — metrics threading reaches ensureGolfer", () => {
  it("emits Signups on a genuine first-touch create, and does NOT re-emit on a second GET for the same sub", async () => {
    const golferStore = createInMemoryGolferStore();
    const idGenerator = createSequentialIds("g");
    const metrics = createCapturingMetrics();
    const getMe = getMyGolfer({ golferStore, idGenerator, metrics });

    await getMe({ sub: "sub-new" });
    expect(metrics.calls).toEqual(["Signups"]);

    await getMe({ sub: "sub-new" });
    expect(metrics.calls).toEqual(["Signups"]); // still one — the existing golfer is found, no re-emit
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

  it("a PUT /me that leaves the name untouched (a home-course-only edit) PRESERVES the flag", async () => {
    const ctx = setup();
    await ctx.getMe({ sub: "sub-1" }); // mint with the flag

    const patched = await ctx.updateMe({ sub: "sub-1" }, { homeCourseId: courseId("course-1") });
    expect(patched.golfer.namePlaceholder).toBe(true);
    expect(patched.golfer.homeCourseId).toBe(courseId("course-1"));
  });
});

describe("updateMyGolfer", () => {
  it("patches only the provided fields, leaving the rest as-is", async () => {
    const ctx = setup();
    // First PUT (empty patch) get-or-creates via ensureGolfer: the create name is the sub-derived
    // placeholder (Cognito is a pure authenticator — never the email localpart), flag preserved by
    // the home-course-only patch.
    await ctx.updateMe({ sub: "sub-1" }, {});

    const updated = await ctx.updateMe({ sub: "sub-1" }, { homeCourseId: courseId("course-1") });
    expect(updated.golfer.name).toBe(placeholderName("sub-1")); // untouched — still the placeholder, never "ann"
    expect(updated.golfer.homeCourseId).toBe(courseId("course-1"));

    const renamed = await ctx.updateMe({ sub: "sub-1" }, { name: "Annika" });
    expect(renamed.golfer.name).toBe("Annika");
    expect(renamed.golfer.homeCourseId).toBe(courseId("course-1")); // untouched by the second patch
  });

  it("get-or-creates on the first PUT /me — one shared ensureGolfer path (GET /me get-or-creates too)", async () => {
    const ctx = setup();
    const updated = await ctx.updateMe({ sub: "sub-1" }, { homeCourseId: courseId("course-1") });
    expect(updated.golfer.homeCourseId).toBe(courseId("course-1"));
  });

  it("creates with the sub-derived placeholder name, NEVER the email localpart (Cognito is a pure authenticator)", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    expect(golfer.name).toBe(placeholderName("sub-1"));
    expect(golfer.name).not.toBe("ann");
    expect(golfer.namePlaceholder).toBe(true);
  });

  // The golfer record holds NO number and no source to pick (spec 2026-07-29 §5): the whole
  // index-source model — and every field the models before it left behind — is gone from the wire.
  // What a golfer shoots is `metrics.average` on the record response; what they play off is the
  // strokes the group typed onto that round's roster.
  it("carries no number of any kind on the wire — name and home course are the whole profile", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, { name: "Annika", homeCourseId: courseId("course-1") });
    expect(golfer).toEqual({ golferId: golfer.golferId, name: "Annika", homeCourseId: courseId("course-1") });
    for (const retired of ["indexSource", "handicap", "declared", "effective", "computed", "official"]) {
      expect(golfer).not.toHaveProperty(retired);
    }
  });
});

describe("getMyRecord", () => {
  it("returns an empty record (no average, zeroed typicalEighteen, empty averageHistory, empty history) for a sub with no golfer at all — no throw, no create", async () => {
    const ctx = setup();
    const record = await ctx.record({ sub: "sub-1" });
    expect(record).toEqual({
      metrics: { typicalEighteen: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 }, averageHistory: [], bests: {}, milestones: [] },
      history: [],
    });
  });

  it("a history line with no score leaves the average ABSENT, not zero — no number is invented (spec §2d)", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    // No holeResults at all: the round happened, but the card carries no score.
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r1"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      par: 72,
      strokes: 8,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
      playedAtMs: 1_000,
    });

    const record = await ctx.record({ sub: "sub-1" });
    expect(record.metrics.average).toBeUndefined();
    expect(record.metrics.averageHistory).toEqual([]);
    expect(record.history).toHaveLength(1); // it still appears in the history
  });

  // courseId (course-cards spec §4, the analytics join key): carried when the stored line has
  // it, omitted for a pre-scrap line without it — absent means ABSENT, never an explicit
  // undefined key (toWireLine's conditional-spread idiom, same as `score`).
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
      strokes: 8,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 2_000,
      playedAtMs: 2_000,
      createdAtMs: 1_900,
    });
    // A pre-scrap line: no courseId, no createdAtMs at all (frozen before cards carried a source).
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r0"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      par: 72,
      strokes: 8,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
      playedAtMs: 1_000,
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

  // The pre-prod hardening headline pin (D4a), carried forward to the average: every derived
  // number is computed HERE, at read time, from the SAME lines this response already carries —
  // never a stored snapshot (no putIndex/putAverage call exists to consult). The oracle is
  // golferMetrics over the same lines, so a second implementation on the way to the wire would
  // fail rather than quietly disagree.
  it("computes the average at read time from the history lines — no stored snapshot is consulted", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    const seeded = [scoredLine("r1", 1_000, 5), scoredLine("r2", 2_000, 6), scoredLine("r3", 3_000, 5)];
    for (const line of seeded) await ctx.projectionStore.putLine(golfer.golferId, line);

    const response = await ctx.record({ sub: "sub-1" });

    // 90 (+18), 108 (+36), 90 (+18) -> mean 72/3 = 24.
    expect(response.metrics.average).toBe(24);
    expect(response.metrics.average).toBe(golferMetrics(seeded).average);
    expect(response.history.map((line) => line.roundId)).toEqual(["r3", "r2", "r1"]); // newest first
  });

  // ProjectionStore.listLines is UNORDERED by contract (ports/projectionStore.ts) — the stable
  // ROUND# sk carries no time to sort by. This proves getMyRecord itself imposes the
  // (finalizedAtMs, roundId) order BEFORE the fold, via a fake store whose listLines returns lines
  // in the OPPOSITE order from how they were logically produced. Order is load-bearing twice over:
  // the average's own rolling window is the LAST ten scored rounds, and averageHistory is one
  // point per round oldest -> newest. The fixture is built so an unsorted fold lands on a DIFFERENT
  // number, not merely a reordering of the same one: 12 rounds, the two OLDEST at +36 and the ten
  // newest at +18. Sorted, the window is the ten +18s -> 18. Fed the reversed array, slice(-10)
  // would take r10..r1 — dragging both +36s in -> (36x2 + 18x8)/10 = 21.6 -> 22.
  it("sorts lines by finalizedAtMs before folding — an out-of-order store never mis-windows the last ten", async () => {
    const chronological = [
      scoredLine("r01", 1_000, 6),
      scoredLine("r02", 2_000, 6),
      ...Array.from({ length: 10 }, (_, i) => scoredLine(`r${String(i + 3).padStart(2, "0")}`, 3_000 + i, 5)),
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
    await golferStore.put({ id: golferId("ann"), name: "Ann" }, undefined);
    await golferStore.bindSub(golferId("ann"), "sub-ann");
    const record = getMyRecord({ golferStore, projectionStore: outOfOrderStore });

    const response = await record({ sub: "sub-ann" });

    expect(response.metrics.average).toBe(18);
    expect(response.metrics.average).not.toBe(22); // the unsorted answer, named so a regression is unmistakable
    // averageHistory is oldest -> newest regardless of the store's order: the first point is r01's
    // own +36, the last is the headline.
    expect(response.metrics.averageHistory[0]).toEqual({ roundId: roundId("r01"), average: 36 });
    expect(response.metrics.averageHistory.at(-1)?.average).toBe(18);
  });

  // typicalEighteen + averageHistory are the SAME golferMetrics fold as `average` above, just two
  // more members: this proves the wire's copies agree byte-for-byte with calling golferMetrics
  // directly over the same (sorted) lines, for a mixed scored/unscored fixture — so no member can
  // acquire a second implementation on its way to the wire.
  it("typicalEighteen + averageHistory on the wire equal golferMetrics(sorted)", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    const stored = [
      { ...scoredLine("r1", 1_000, 6), distribution: { eagles: 0, birdies: 1, pars: 10, bogeys: 5, doublePlus: 2 } },
      { ...scoredLine("r2", 2_000, 5), distribution: { eagles: 0, birdies: 1, pars: 10, bogeys: 5, doublePlus: 2 } },
      { ...scoredLine("r3", 3_000, 5), distribution: { eagles: 1, birdies: 2, pars: 9, bogeys: 4, doublePlus: 2 } },
      // A round with no score at all — in the history, out of the average and its chart.
      {
        roundId: roundId("r4"),
        courseName: "Casa Verde GC",
        tee: "white",
        holes: 18 as const,
        par: 72,
        strokes: 8,
        distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
        finalizedAtMs: 4_000,
        playedAtMs: 4_000,
      },
    ];
    for (const l of stored) await ctx.projectionStore.putLine(golfer.golferId, l);

    const record = await ctx.record({ sub: "sub-1" });

    // The oracle: golferMetrics over the SAME lines, sorted oldest -> newest — the identical fold
    // getMyRecord itself runs (its own sortLines contract).
    const sortedOldestFirst = [...stored].sort((a, b) => a.finalizedAtMs - b.finalizedAtMs);
    const expected = golferMetrics(sortedOldestFirst);
    expect(record.metrics.typicalEighteen).toEqual(expected.typicalEighteen);
    expect(record.metrics.averageHistory).toEqual(expected.averageHistory);
    // Three scored rounds -> three points; the unscored r4 is not a data point.
    expect(record.metrics.averageHistory.map((point) => point.roundId)).toEqual(["r1", "r2", "r3"]);
    expect(record.history).toHaveLength(4);
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
    // hasCompleteScore (analytics.ts) requires 18 strokes-kind holeResults summing to `gross` —
    // the par-4-every-hole shape with the "over" strokes loaded onto the first N holes is
    // arbitrary but sums correctly; courseRecord's best/scoringAverage only consume the sum +
    // line par.
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
      strokes: 8,
      score: gross,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      holeResults: holeResultsFor(gross),
      finalizedAtMs: ms,
      playedAtMs: ms,
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
      best18: { roundId: roundId("r2"), gross: 84, toPar: 12 },
      scoringAverage18: 87.0,
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
      strokes: 8,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
      playedAtMs: 1_000,
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
      strokes: 8,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
      playedAtMs: 1_000,
    });
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r2"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      par: 72,
      strokes: 8,
      distribution: { eagles: 0, birdies: 0, pars: 5, bogeys: 13, doublePlus: 0 },
      finalizedAtMs: 2_000,
      playedAtMs: 2_000,
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
      strokes: 8,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 2_000,
      playedAtMs: 2_000,
      createdAtMs: 1_500,
    });
    // A legacy line: no createdAtMs at all (an older projection write).
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r0"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      par: 72,
      strokes: 8,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
      playedAtMs: 1_000,
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
      strokes: 8,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 2_000,
      playedAtMs: 2_000,
    });
    // A pre-scrap line: no courseId at all (frozen before cards carried a source).
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r0"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      par: 72,
      strokes: 8,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
      playedAtMs: 1_000,
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
      strokes: 8,
      distribution: { eagles: 0, birdies: 0, pars: 9, bogeys: 9, doublePlus: 0 },
      finalizedAtMs: 1_000,
      playedAtMs: 1_000,
    });
    await ctx.projectionStore.putLine(golfer.golferId, {
      roundId: roundId("r2"),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      par: 72,
      strokes: 8,
      distribution: { eagles: 0, birdies: 0, pars: 5, bogeys: 13, doublePlus: 0 },
      finalizedAtMs: 2_000,
      playedAtMs: 2_000,
    });

    const record = await ctx.record({ sub: "sub-1" });
    const rounds = await ctx.myRounds({ sub: "sub-1" });
    expect(rounds.rounds.map((line) => line.roundId)).toEqual(record.history.map((line) => line.roundId));
  });
});

// GET /me/rounds/live (projection-realignment Task 13): "your rounds, right now" — presence,
// not finalized history (getMyRounds above). The store's own presence half is exercised
// directly via putLive (not through startRound/joinRound — those are covered in
// rounds/roundSlice.test.ts's own presence suite); playedAt (spec 2026-08-01 §4b) is REQUIRED
// on the wire now, so any test whose entries should actually render needs a real round genesis
// on `ctx.journal` too — journal.read returning [] for a roundId with no round in it is exactly
// how the "stale pointer" case below is built.
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

  it("lists live rounds newest-joined first, each carrying courseName + joinedAt (the wire name for joinedAtMs) and playedAt (the round's own log, via playedAtMsOf)", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    await ctx.journal.append(roundId("r1"), [
      { kind: "round-created", roundId: roundId("r1"), card: fixtureLinks, playedAtMs: 500, opId: opId("g1"), hlc: { wallMs: 500, counter: 0, deviceId: deviceId("test") }, authorId: golferId("author") },
    ]);
    await ctx.journal.append(roundId("r2"), [
      { kind: "round-created", roundId: roundId("r2"), card: fixtureLinks, playedAtMs: 1_500, opId: opId("g2"), hlc: { wallMs: 1_500, counter: 0, deviceId: deviceId("test") }, authorId: golferId("author") },
    ]);
    await ctx.projectionStore.putLive(golfer.golferId, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 1_000 });
    await ctx.projectionStore.putLive(golfer.golferId, { roundId: roundId("r2"), courseName: "Pebble Municipal", joinedAtMs: 2_000 });

    const result = await ctx.myLiveRounds({ sub: "sub-1" });
    expect(result.rounds).toEqual([
      { roundId: roundId("r2"), courseName: "Pebble Municipal", joinedAt: 2_000, playedAt: 1_500 },
      { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAt: 1_000, playedAt: 500 },
    ]);
    // Never the store's own internal field name leaking onto the wire.
    expect(result.rounds.every((entry) => !("joinedAtMs" in entry))).toBe(true);
  });

  // playedAt (spec 2026-08-01 §4b): derived at read time from the round's own log (domain's
  // playedAtMsOf), a round-level fact — carried when the round exists. REQUIRED on the wire
  // (unlike the old best-effort createdAt), so a stale presence pointer (the 36h TTL backstop
  // outliving a round that vanished) drops that ENTRY entirely rather than serving one with a
  // missing required field.
  it("carries playedAt derived from the round's own log, dropping the entry entirely for a stale pointer with no round behind it", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    // A real live round's genesis on the journal (playedAtMs 7_777).
    await ctx.journal.append(roundId("r1"), [
      { kind: "round-created", roundId: roundId("r1"), card: fixtureLinks, playedAtMs: 7_777, opId: opId("g1"), hlc: { wallMs: 7_777, counter: 0, deviceId: deviceId("test") }, authorId: golferId("author") },
    ]);
    await ctx.projectionStore.putLive(golfer.golferId, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 1_000 });
    // A stale presence pointer whose round never existed / has vanished — journal.read returns
    // [] for it, so playedAt can never resolve.
    await ctx.projectionStore.putLive(golfer.golferId, { roundId: roundId("r2"), courseName: "Ghost Course", joinedAtMs: 2_000 });

    const result = await ctx.myLiveRounds({ sub: "sub-1" });
    expect(result.rounds).toEqual([{ roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAt: 1_000, playedAt: 7_777 }]);
  });

  // Fix wave (task-3 review, Important 1): every OTHER fixture in this block sets playedAtMs equal
  // to the genesis event's own hlc.wallMs, which makes "read the played date" and "read the
  // genesis clock" the same function — a getMyLiveRounds.ts reverted to
  // `events.find((e) => e.kind === "round-created")?.hlc.wallMs` would still satisfy every
  // assertion above. This fixture deliberately diverges the two (playedAtMs 9_000 vs. hlc.wallMs
  // 500) so only the real rule, playedAtMsOf, can produce the expected value.
  it("resolves playedAt from the round's own playedAtMs, not the genesis event's hlc.wallMs", async () => {
    const ctx = setup();
    const { golfer } = await ctx.updateMe({ sub: "sub-1" }, {});
    await ctx.journal.append(roundId("r1"), [
      { kind: "round-created", roundId: roundId("r1"), card: fixtureLinks, playedAtMs: 9_000, opId: opId("g1"), hlc: { wallMs: 500, counter: 0, deviceId: deviceId("test") }, authorId: golferId("author") },
    ]);
    await ctx.projectionStore.putLive(golfer.golferId, { roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAtMs: 1_000 });

    const result = await ctx.myLiveRounds({ sub: "sub-1" });
    expect(result.rounds).toEqual([{ roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAt: 1_000, playedAt: 9_000 }]);
  });
});
