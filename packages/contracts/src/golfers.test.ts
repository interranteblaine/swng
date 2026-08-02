import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { courseId, golferId, roundId } from "@swng/domain";
import type { GolferRoundLine } from "@swng/domain";
import { ContractError, parse } from "./parse.js";
import {
  getGolferResponseSchema,
  getMeResponseSchema,
  getMyCourseRecordResponseSchema,
  getMyLiveRoundsResponseSchema,
  getMyRecordResponseSchema,
  getMyRoundsResponseSchema,
  golferViewSchema,
  updateMeRequestSchema,
} from "./golfers.js";

// parse(JSON.parse(JSON.stringify(x))) === x — the wire round-trip every schema here has to
// survive unchanged, same pattern as courses.test.ts / round.test.ts.
const roundTrips = <S extends z.ZodType>(schema: S, value: z.infer<S>): void => {
  expect(parse(schema, JSON.parse(JSON.stringify(value)) as unknown)).toEqual(value);
};

describe("golferViewSchema (via getMeResponseSchema)", () => {
  it("round-trips a bare golfer (no home course)", () => {
    roundTrips(getMeResponseSchema, { golfer: { golferId: golferId("g1"), name: "Ann" } });
  });

  it("round-trips a fully-populated golfer — name and home course are the WHOLE profile (spec 2026-07-29 §5)", () => {
    roundTrips(getMeResponseSchema, {
      golfer: {
        golferId: golferId("g1"),
        name: "Ann",
        homeCourseId: courseId("course-1"),
      },
    });
  });

  // GET /me get-or-creates now (accounts-only identity spec §2), but the wire type stays nullable —
  // the null case still round-trips.
  it("round-trips an unbound sub: golfer null", () => {
    roundTrips(getMeResponseSchema, { golfer: null });
  });

  // accounts-only identity spec §2: namePlaceholder rides the view, emitted only when true.
  it("round-trips a golfer carrying namePlaceholder: true", () => {
    roundTrips(getMeResponseSchema, { golfer: { golferId: golferId("g1"), name: "Golfer 4821", namePlaceholder: true } });
  });
});

// The index-source union (swng/whs/declared) is DELETED with the index itself (spec §7). What
// survives is the negative: a golfer view carries no number and no source, and a client still
// sending one is rejected rather than silently accepted (`.strict()` on the request, below).
describe("golferViewSchema — no index of any kind", () => {
  it("round-trips a view with no source and drops nothing", () => {
    const view = { golferId: golferId("g1"), name: "Ann" };
    expect(parse(golferViewSchema, view)).toEqual(view);
  });

  it("strips a legacy indexSource rather than carrying it through (non-strict response schema)", () => {
    expect(parse(golferViewSchema, { golferId: golferId("g1"), name: "Ann", indexSource: { kind: "swng" } })).toEqual({
      golferId: golferId("g1"),
      name: "Ann",
    });
  });
});

describe("updateMeRequestSchema", () => {
  it("round-trips a partial patch (only homeCourseId set)", () => {
    roundTrips(updateMeRequestSchema, { homeCourseId: courseId("course-1") });
  });

  // The profile has no number to set (spec §5): an old bundle still PUTting an index source gets a
  // clean 400 off `.strict()`, never a silent no-op.
  it("rejects a legacy indexSource patch", () => {
    expect(() => parse(updateMeRequestSchema, { indexSource: { kind: "whs" } })).toThrow(ContractError);
  });

  it("round-trips an empty patch", () => {
    roundTrips(updateMeRequestSchema, {});
  });

  it("rejects an extra field (.strict()) — e.g. a client proposing golferId", () => {
    expect(() => parse(updateMeRequestSchema, { name: "Ann", golferId: "sneaky" })).toThrow(ContractError);
  });

  it("rejects an empty name", () => {
    expect(() => parse(updateMeRequestSchema, { name: "" })).toThrow(ContractError);
  });

  // task-1 (pre-prod hardening, wire-ingress length bound).
  it("rejects an over-long name", () => {
    expect(() => parse(updateMeRequestSchema, { name: "x".repeat(61) })).toThrow(ContractError);
  });

  it("accepts a name at the boundary (60 chars)", () => {
    expect(() => parse(updateMeRequestSchema, { name: "x".repeat(60) })).not.toThrow();
  });
});

describe("getMyRecordResponseSchema", () => {
  const completeLine: GolferRoundLine = {
    roundId: roundId("r1"),
    courseName: "Casa Verde GC",
    tee: "white",
    holes: 18,
    par: 72,
    strokes: 8,
    score: 90,
    distribution: { eagles: 0, birdies: 1, pars: 10, bogeys: 6, doublePlus: 1 },
  };

  // No `score`: a card with a pickup carries no score, so there is no number to serve.
  const incompleteLine: GolferRoundLine = {
    roundId: roundId("r2"),
    courseName: "Casa Verde GC",
    tee: "white",
    holes: 9,
    par: 36,
    strokes: 5,
    distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  };

  // Both required (spec §5): a zeroed typicalEighteen + empty averageHistory, unless a fixture
  // asserts otherwise below.
  const zeroTypicalEighteen = { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 };

  // Both required (analytics spec §3): {} / [] unless a fixture asserts otherwise below.
  const zeroBestsMilestones = { bests: {}, milestones: [] };

  it("round-trips a full record: the average, a typicalEighteen shape, an averageHistory, a best18, an achieved milestone, and mixed scored/unscored history lines", () => {
    roundTrips(getMyRecordResponseSchema, {
      metrics: {
        average: 26,
        typicalEighteen: { eagles: 0, birdies: 3, pars: 20, bogeys: 12, doublePlus: 2 },
        averageHistory: [{ roundId: roundId("r1"), average: 26 }],
        bests: { best18: { roundId: roundId("r1"), gross: 82, toPar: 10 } },
        milestones: [{ kind: "broke-90", roundId: roundId("r1") }],
      },
      history: [
        { ...completeLine, playedAt: 1_000 },
        { ...incompleteLine, playedAt: 2_000 },
      ],
    });
  });

  // Spread is the crew board's own column, over the SEASON window (spec §6, controller ruling): it
  // must never appear on a golfer record response, where it would be a differently-windowed number
  // under the same name. The non-strict response schema drops a legacy one rather than carrying it.
  it("strips a spread rather than serving it", () => {
    const metrics = { average: 26, typicalEighteen: zeroTypicalEighteen, averageHistory: [], ...zeroBestsMilestones };
    expect(parse(getMyRecordResponseSchema, { metrics: { ...metrics, spread: 4.2 }, history: [] })).toEqual({ metrics, history: [] });
  });

  // An UNDER-par average is a plain negative on the wire — there is one sign convention now
  // (spec §4), and no plus-handicap encoding to confuse it with.
  it("round-trips a negative average (a golfer who shoots under par)", () => {
    roundTrips(getMyRecordResponseSchema, {
      metrics: { average: -2, typicalEighteen: zeroTypicalEighteen, averageHistory: [{ roundId: roundId("r1"), average: -2 }], ...zeroBestsMilestones },
      history: [{ ...completeLine, playedAt: 1_000 }],
    });
  });

  it("round-trips a record with no scored round at all: no average/spread, zeroed typicalEighteen, empty averageHistory, history present", () => {
    roundTrips(getMyRecordResponseSchema, {
      metrics: { typicalEighteen: zeroTypicalEighteen, averageHistory: [], ...zeroBestsMilestones },
      history: [{ ...incompleteLine, playedAt: 1_000 }],
    });
  });

  it("round-trips an entirely empty record", () => {
    roundTrips(getMyRecordResponseSchema, { metrics: { typicalEighteen: zeroTypicalEighteen, averageHistory: [], ...zeroBestsMilestones }, history: [] });
  });

  // course-cards spec §4: courseId (the analytics join key) is OPTIONAL on a history line —
  // pre-scrap lines carry none, tolerated as absent.
  it("round-trips a history line carrying courseId", () => {
    roundTrips(getMyRecordResponseSchema, {
      metrics: { typicalEighteen: zeroTypicalEighteen, averageHistory: [], ...zeroBestsMilestones },
      history: [{ ...completeLine, courseId: courseId("course-1"), playedAt: 1_000 }],
    });
  });

  it("round-trips a pre-scrap history line with no courseId", () => {
    roundTrips(getMyRecordResponseSchema, {
      metrics: { typicalEighteen: zeroTypicalEighteen, averageHistory: [], ...zeroBestsMilestones },
      history: [{ ...completeLine, playedAt: 1_000 }],
    });
  });

  // index-chart-polish spec §1.6: finalizedAt/createdAt are OPTIONAL on a history line — a new
  // bundle against an old lambda (which never sends them) still parses clean; always present in
  // practice for finalizedAt. playedAt (spec 2026-08-01 §4b) is REQUIRED — always present.
  it("round-trips a history line carrying finalizedAt and createdAt", () => {
    roundTrips(getMyRecordResponseSchema, {
      metrics: { typicalEighteen: zeroTypicalEighteen, averageHistory: [], ...zeroBestsMilestones },
      history: [{ ...completeLine, finalizedAt: 2_000, playedAt: 1_000, createdAt: 1_500 }],
    });
  });

  it("round-trips a history line with no finalizedAt/createdAt (the old-lambda tolerance pin)", () => {
    roundTrips(getMyRecordResponseSchema, {
      metrics: { typicalEighteen: zeroTypicalEighteen, averageHistory: [], ...zeroBestsMilestones },
      history: [{ ...completeLine, playedAt: 1_000 }],
    });
  });

  // playedAt (spec 2026-08-01 §4b) is REQUIRED, unlike finalizedAt/createdAt above — a history
  // line missing it is rejected, not silently accepted.
  it("rejects a history line missing playedAt", () => {
    expect(() =>
      parse(getMyRecordResponseSchema, { metrics: { typicalEighteen: zeroTypicalEighteen, averageHistory: [], ...zeroBestsMilestones }, history: [completeLine] }),
    ).toThrow(ContractError);
  });

  // typicalEighteen, averageHistory, bests, and milestones are all REQUIRED — a metrics object
  // missing any one of them is rejected, not silently defaulted.
  it("rejects a metrics object missing typicalEighteen", () => {
    expect(() => parse(getMyRecordResponseSchema, { metrics: { averageHistory: [], ...zeroBestsMilestones }, history: [] })).toThrow(ContractError);
  });

  it("rejects a metrics object missing averageHistory", () => {
    expect(() => parse(getMyRecordResponseSchema, { metrics: { typicalEighteen: zeroTypicalEighteen, ...zeroBestsMilestones }, history: [] })).toThrow(
      ContractError,
    );
  });

  it("rejects a metrics object missing bests", () => {
    expect(() =>
      parse(getMyRecordResponseSchema, { metrics: { typicalEighteen: zeroTypicalEighteen, averageHistory: [], milestones: [] }, history: [] }),
    ).toThrow(ContractError);
  });

  it("rejects a metrics object missing milestones", () => {
    expect(() =>
      parse(getMyRecordResponseSchema, { metrics: { typicalEighteen: zeroTypicalEighteen, averageHistory: [], bests: {} }, history: [] }),
    ).toThrow(ContractError);
  });
});

// GET /golfers/{golferId} (navigation spec §6a) — the same history-line shape as
// getMyRecordResponseSchema above, including the index-chart-polish spec §1.6 finalizedAt/
// createdAt fields, since both share golferRoundLineFields.
describe("getGolferResponseSchema", () => {
  const zeroTypicalEighteen = { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 };
  const zeroBestsMilestones = { bests: {}, milestones: [] };
  const bareMetrics = { typicalEighteen: zeroTypicalEighteen, averageHistory: [], ...zeroBestsMilestones };
  const completeLine: GolferRoundLine = {
    roundId: roundId("r1"),
    courseName: "Casa Verde GC",
    tee: "white",
    holes: 18,
    par: 72,
    strokes: 8,
    score: 90,
    distribution: { eagles: 0, birdies: 1, pars: 10, bogeys: 6, doublePlus: 1 },
  };

  it("round-trips a bare golfer with no history", () => {
    roundTrips(getGolferResponseSchema, { name: "Ann", metrics: bareMetrics, history: [] });
  });

  it("round-trips a history line carrying finalizedAt and createdAt", () => {
    roundTrips(getGolferResponseSchema, {
      name: "Ann",
      metrics: bareMetrics,
      history: [{ ...completeLine, finalizedAt: 2_000, playedAt: 1_000, createdAt: 1_500 }],
    });
  });

  // The old-lambda tolerance pin (index-chart-polish spec §1.6): a history row without the new
  // fields still parses clean. playedAt (spec 2026-08-01 §4b) is REQUIRED — always present.
  it("round-trips a history line with no finalizedAt/createdAt", () => {
    roundTrips(getGolferResponseSchema, { name: "Ann", metrics: bareMetrics, history: [{ ...completeLine, playedAt: 1_000 }] });
  });

  // Minor 2 (task-3 review): the same required-field pin getMyRecordResponseSchema's own "rejects
  // a history line missing playedAt" test above carries — golferRoundLineFields backs both
  // schemas, so a missing playedAt must be rejected here too, not silently accepted.
  it("rejects a history line missing playedAt", () => {
    expect(() => parse(getGolferResponseSchema, { name: "Ann", metrics: bareMetrics, history: [completeLine] })).toThrow(ContractError);
  });
});

// GET /me/courses/{courseId}/record (analytics spec 2026-07-21 §4).
describe("getMyCourseRecordResponseSchema", () => {
  it("round-trips a bare record — rounds only, no best/scoringAverage/insights yet", () => {
    roundTrips(getMyCourseRecordResponseSchema, { courseId: courseId("course-1"), rounds: 2 });
  });

  it("round-trips a record with best18 + scoringAverage18, gated insights still absent below 5 rounds", () => {
    roundTrips(getMyCourseRecordResponseSchema, {
      courseId: courseId("course-1"),
      rounds: 3,
      best18: { roundId: roundId("r1"), gross: 82, toPar: 10 },
      scoringAverage18: 88.3,
    });
  });

  // round-plays-a-nine spec 2026-08-02, Finding 1: best/scoringAverage split by hole count — both
  // a 9- and an 18-hole number can be present at once, never mixed into one.
  it("round-trips a record with both best9 and best18 present at once", () => {
    roundTrips(getMyCourseRecordResponseSchema, {
      courseId: courseId("course-1"),
      rounds: 4,
      best18: { roundId: roundId("r1"), gross: 82, toPar: 10 },
      best9: { roundId: roundId("r2"), gross: 41, toPar: 5 },
      scoringAverage18: 88.3,
      scoringAverage9: 42.5,
    });
  });

  it("round-trips a fully-populated record: best18, scoringAverage18, and every insights member", () => {
    roundTrips(getMyCourseRecordResponseSchema, {
      courseId: courseId("course-1"),
      rounds: 5,
      best18: { roundId: roundId("r1"), gross: 79, toPar: 7 },
      scoringAverage18: 86.4,
      insights: {
        worstHole: { hole: 7, par: 4, plays: 5, avgOverPar: 1.4, doublePlus: 2 },
        scoringHole: { hole: 2, par: 5, plays: 5, parOrBetter: 4 },
        neverBirdied: [3, 7, 12],
      },
    });
  });

  // insights can be present (rounds >= 5) yet carry none of its own three members, when no hole
  // clears any threshold — an empty object, not an absent one.
  it("round-trips insights present but empty", () => {
    roundTrips(getMyCourseRecordResponseSchema, { courseId: courseId("course-1"), rounds: 5, insights: {} });
  });
});

// accounts-only identity spec §5: createdAt (the "course + date" designation) is OPTIONAL on the
// history list — old projection lines carry none, tolerated as absent. playedAt (spec 2026-08-01
// §4b) is REQUIRED — projectArchive always provides it.
describe("getMyRoundsResponseSchema", () => {
  // Split so the missing-playedAt case below can be built by OMISSION rather than by
  // destructure-and-drop — the same shape every sibling "rejects … missing X" test in this file
  // and crews.test.ts uses (and the destructured form trips no-unused-vars, since the repo's
  // eslint config sets argsIgnorePattern but not varsIgnorePattern).
  const lineWithoutPlayedAt = {
    roundId: roundId("r1"),
    courseName: "Casa Verde GC",
    tee: "white",
    holes: 18 as const,
    par: 72,
    strokes: 8,
    score: 90,
    distribution: { eagles: 0, birdies: 1, pars: 10, bogeys: 6, doublePlus: 1 },
  };
  const line = { ...lineWithoutPlayedAt, playedAt: 1_000 };

  it("round-trips a round line carrying createdAt", () => {
    roundTrips(getMyRoundsResponseSchema, { rounds: [{ ...line, finalizedAt: 2_000, createdAt: 1_500 }] });
  });

  it("round-trips a legacy round line with no createdAt", () => {
    roundTrips(getMyRoundsResponseSchema, { rounds: [{ ...line, finalizedAt: 2_000 }] });
  });

  // course-cards spec §4: courseId is OPTIONAL here too — same carried-or-absent tolerance as
  // getMyRecordResponseSchema's history lines above.
  it("round-trips a round line carrying courseId", () => {
    roundTrips(getMyRoundsResponseSchema, { rounds: [{ ...line, courseId: courseId("course-1"), finalizedAt: 2_000 }] });
  });

  it("round-trips a pre-scrap round line with no courseId", () => {
    roundTrips(getMyRoundsResponseSchema, { rounds: [{ ...line, finalizedAt: 2_000 }] });
  });

  it("rejects a round line missing playedAt", () => {
    expect(() => parse(getMyRoundsResponseSchema, { rounds: [{ ...lineWithoutPlayedAt, finalizedAt: 2_000 }] })).toThrow(ContractError);
  });
});

// playedAt (spec 2026-08-01 §4b) REPLACED the old best-effort createdAt outright: REQUIRED, not
// tolerated absent — a genuinely live round's log always has a genesis, so getMyLiveRounds.ts
// drops any entry whose presence pointer outlived its own round rather than serving a
// fact-free stub (application/src/golfers/getMyLiveRounds.ts).
describe("getMyLiveRoundsResponseSchema", () => {
  it("round-trips a live round carrying playedAt", () => {
    roundTrips(getMyLiveRoundsResponseSchema, { rounds: [{ roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAt: 1_000, playedAt: 900 }] });
  });

  it("rejects a live round entry missing playedAt", () => {
    expect(() =>
      parse(getMyLiveRoundsResponseSchema, { rounds: [{ roundId: roundId("r1"), courseName: "Casa Verde GC", joinedAt: 1_000 }] }),
    ).toThrow(ContractError);
  });
});
