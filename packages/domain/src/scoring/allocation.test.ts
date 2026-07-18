import { describe, expect, it } from "vitest";
import { findTeeSet } from "../course/card.js";
import type { CourseCard, TeeSet } from "../course/card.js";
import { gameId, golferId } from "../ids.js";
import type { GolferId } from "../ids.js";
import { settleRound } from "../round/archive.js";
import { reduceRound } from "../round/state.js";
import type { Participant } from "../round/participant.js";
import { dotsByHole } from "./strokes.js";
import { fieldDeck18 } from "./golden/fieldDeck18.js";
import { fixtureLinks, fixtureLinks18, fixtureWhite } from "./golden/fixtureCourse.js";
import { playGoldenRoundLog } from "./golden/deck.js";
import type { FixtureScores } from "./golden/deck.js";
import { gameStrokeAllocation, handicappingFor, totalDots } from "./allocation.js";
import type { GameConfig } from "./game.js";

// The M5 field deck: fourball 90%-allowance playing handicaps 7/2/14/5 give relative
// dots 5/0/12/3 (ann/bo/cal/dee, relative to Bo's 2); skins plays full handicap, so its
// dots are the playing handicaps themselves (8/2/15/5). Hand-verified in the
// implementation plan and already pinned by fieldDeck18.test.ts against the match/skins
// engines — reused here as the orchestration oracle for gameStrokeAllocation.
const { players, fourball, skins } = fieldDeck18;
// Cast to a fixed-length tuple: fieldDeck18.players is a plain array as far as TS is
// concerned, so a bare destructure would otherwise type each element `GolferId |
// undefined` under noUncheckedIndexedAccess even though the deck's shape guarantees
// exactly these four.
const [ann, bo, cal, dee] = players.map((p) => p.golferId) as unknown as readonly [GolferId, GolferId, GolferId, GolferId];
const whiteTeeSet = findTeeSet(fixtureLinks18, "white");

describe("gameStrokeAllocation", () => {
  it("fourball: dots relative to the lowest playing handicap (Bo) — 5/0/12/3 by SI", () => {
    const allocation = gameStrokeAllocation(fourball, players, fixtureLinks18);
    const expectedRelative: Readonly<Record<string, number>> = { [ann]: 5, [bo]: 0, [cal]: 12, [dee]: 3 };
    for (const [id, relative] of Object.entries(expectedRelative)) {
      expect(allocation.get(golferId(id))).toEqual(dotsByHole(relative, whiteTeeSet));
    }
  });

  it("skins: dots follow each player's own full playing handicap — 8/2/15/5", () => {
    const allocation = gameStrokeAllocation(skins, players, fixtureLinks18);
    const expectedPlayingHandicap: Readonly<Record<string, number>> = { [ann]: 8, [bo]: 2, [cal]: 15, [dee]: 5 };
    for (const [id, ch] of Object.entries(expectedPlayingHandicap)) {
      expect(allocation.get(golferId(id))).toEqual(dotsByHole(ch, whiteTeeSet));
    }
  });

  it("a >=19 relative allocation wraps past a full lap: SI 1 gets 2 dots", () => {
    // 90% allowance: ch 0 -> playing handicap 0; ch 22 -> roundHalfUp(19.8) = 20.
    // Relative diff 20 over 18 holes = 1 dot everywhere + 2 extra on SI 1-2 (hole 2, hole 10).
    const low = golferId("low");
    const high = golferId("high");
    const other = golferId("other-a");
    const other2 = golferId("other-b");
    const fourParticipants: readonly Participant[] = [
      { golferId: low, name: "Low", tee: "white", courseHandicap: 0 },
      { golferId: high, name: "High", tee: "white", courseHandicap: 22 },
      { golferId: other, name: "OtherA", tee: "white", courseHandicap: 5 },
      { golferId: other2, name: "OtherB", tee: "white", courseHandicap: 5 },
    ];
    const wideFourball: Extract<GameConfig, { kind: "fourball-match" }> = {
      kind: "fourball-match",
      id: gameId("wide"),
      a: [low, high],
      b: [other, other2],
    };
    const allocation = gameStrokeAllocation(wideFourball, fourParticipants, fixtureLinks18);
    expect(allocation.get(low)).toEqual(dotsByHole(0, whiteTeeSet));
    expect(allocation.get(high)).toEqual(dotsByHole(20, whiteTeeSet));
    // Hole 2 carries strokeIndex 1 on fixtureWhite18 — the >=19 wrap must land a
    // second dot there, not just one.
    expect(allocation.get(high)?.get(2)).toBe(2);
  });

  it("gross stroke-play carries no allowance: the whole allocation is empty", () => {
    const grossStrokePlay: Extract<GameConfig, { kind: "stroke-play" }> = {
      kind: "stroke-play",
      id: gameId("gross"),
      scoring: "gross",
      players: [ann, bo, cal, dee],
    };
    const allocation = gameStrokeAllocation(grossStrokePlay, players, fixtureLinks18);
    expect(allocation).toEqual(new Map());
  });
});

describe("totalDots", () => {
  it("sums a per-hole allocation to the total strokes it was built from", () => {
    const perHole = dotsByHole(11, whiteTeeSet); // 18 holes: 11 wraps to 1 everywhere + extra on SI 1-11 — sums back to 11
    expect(totalDots(perHole)).toBe(11);
  });
  it("sums to zero for an empty allocation (e.g. gross stroke-play)", () => {
    expect(totalDots(new Map())).toBe(0);
  });
  it("sums a plus-handicap (negative) allocation back to the negative total", () => {
    const perHole = dotsByHole(-4, whiteTeeSet);
    expect(totalDots(perHole)).toBe(-4);
  });
  it("agrees with gameStrokeAllocation's own per-golfer allocation on the fourball fixture (5/0/12/3)", () => {
    const allocation = gameStrokeAllocation(fourball, players, fixtureLinks18);
    const expectedRelative: Readonly<Record<string, number>> = { [ann]: 5, [bo]: 0, [cal]: 12, [dee]: 3 };
    for (const [id, relative] of Object.entries(expectedRelative)) {
      expect(totalDots(allocation.get(golferId(id))!)).toBe(relative);
    }
  });
});

describe("handicappingFor — agreement with settleRound's own consumption", () => {
  const A = golferId("ann");
  const B = golferId("bo");
  const C = golferId("cal");
  const players3 = [
    { golferId: A, name: "Ann", tee: "white", courseHandicap: 8 },
    { golferId: B, name: "Bo", tee: "white", courseHandicap: 2 },
    { golferId: C, name: "Cal", tee: "white", courseHandicap: 12 },
  ];
  const skinsGame = { kind: "skins", id: gameId("k9"), players: [A, B, C] } as const;
  const stableford = { kind: "stableford", id: gameId("s9"), players: [A, B, C] } as const;
  const cards = {
    [A]: [5, 5, 4, 6, 5, 4, 5, 6, "picked-up"],
    [B]: [4, 5, 3, 6, 4, 4, 4, 5, 4],
    [C]: [6, 7, 4, 8, 6, 5, 6, 7, 6],
  } as const;
  const corrections = [{ golfer: A, hole: 9, score: 4 }] as const;
  const finalLog = playGoldenRoundLog(fixtureLinks, players3, [skinsGame, stableford], cards, corrections);

  it("calling the exported helper directly reproduces settleRound's own handicapping rows exactly", () => {
    const archive = settleRound(finalLog);
    const state = reduceRound(finalLog);

    for (const participant of state.participants) {
      const direct = handicappingFor(participant, state.card, state.cells);
      const fromArchive = archive.handicapping.find((row) => row.golferId === participant.golferId);
      expect(direct).toEqual(fromArchive);
    }
  });
});

// Unrated-courses spec (Task 2): a round played on an unrated tee still scores an AGS —
// it just carries no differential. handicappingFor must return kind "unrated" (never
// "complete" and never let scoreDifferential's tee-unrated throw escape uncaught).
describe("handicappingFor — unrated tee", () => {
  const golfer = golferId("uno");
  const participant: Participant = { golferId: golfer, name: "Uno", tee: "white", courseHandicap: 8 };
  // Same holes as the rated fixture (par/strokeIndex only — AGS never reads rating/slope),
  // just without rating/slope, so the two cards' AGS for identical scores can be compared.
  const unratedWhite: TeeSet = { name: "white", holes: fixtureWhite.holes };
  const unratedLinks: CourseCard = { courseName: "Unrated Links", teeSets: [unratedWhite] };
  const fullScores: FixtureScores = { [golfer]: [5, 5, 4, 6, 5, 4, 5, 6, 5] };

  it("all holes decided: kind unrated, AGS equal to the rated computation's AGS (rating/slope-independent)", () => {
    const log = playGoldenRoundLog(fixtureLinks, [participant], [], fullScores, [], false);
    const state = reduceRound(log);

    const rated = handicappingFor(participant, fixtureLinks, state.cells);
    if (rated.kind !== "complete") throw new Error(`expected the rated tee to be complete, got ${rated.kind}`);

    const unrated = handicappingFor(participant, unratedLinks, state.cells);
    expect(unrated).toEqual({ golferId: golfer, kind: "unrated", ags: rated.ags });
  });

  it("still incomplete when a hole is undecided on an unrated tee", () => {
    const partialScores: FixtureScores = { [golfer]: [5, 5, 4, 6, 5, 4, 5, 6, null] };
    const log = playGoldenRoundLog(fixtureLinks, [participant], [], partialScores, [], false);
    const state = reduceRound(log);

    const result = handicappingFor(participant, unratedLinks, state.cells);
    expect(result).toEqual({ golferId: golfer, kind: "incomplete" });
  });
});
