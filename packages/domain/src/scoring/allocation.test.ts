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
import { courseHandicapAllocation, gameStrokeAllocation, handicappingFor, totalDots } from "./allocation.js";
import type { GameConfig } from "./game.js";

// The M5 field deck: course handicaps 8/2/15/5 (ann/bo/cal/dee) give relative dots 6/0/13/3 off
// Bo's low 2 — the SAME dots in BOTH games, because there is one rule and both fields are all four
// players. Hand-derived in the deck itself and pinned by fieldDeck18.test.ts against the
// match/skins engines — reused here as the orchestration oracle for gameStrokeAllocation.
const { players, fourball, skins } = fieldDeck18;
// Cast to a fixed-length tuple: fieldDeck18.players is a plain array as far as TS is
// concerned, so a bare destructure would otherwise type each element `GolferId |
// undefined` under noUncheckedIndexedAccess even though the deck's shape guarantees
// exactly these four.
const [ann, bo, cal, dee] = players.map((p) => p.golferId) as unknown as readonly [GolferId, GolferId, GolferId, GolferId];
const whiteTeeSet = findTeeSet(fixtureLinks18, "white");

// A roster entry for the field-scoping tests below. Keeps `courseHandicap` for now — Task 3
// replaces it with a StrokeBasis, at which point this builder states a basis instead.
const p = (id: string, courseHandicap: number): Participant => ({ golferId: id as GolferId, name: id, tee: "white", courseHandicap });

describe("gameStrokeAllocation", () => {
  const roster = [p("ann", 0), p("bo", 20), p("cy", 25), p("dee", 40)];

  it("allocates off the lowest in that game's OWN field, not the round's", () => {
    const allocation = gameStrokeAllocation(
      { kind: "stroke-play", id: gameId("g1"), scoring: "net", players: [golferId("bo"), golferId("cy")] },
      roster,
      fixtureLinks18,
    );
    expect(totalDots(allocation.get(golferId("bo"))!)).toBe(0);
    expect(totalDots(allocation.get(golferId("cy"))!)).toBe(5);
  });

  it("allocates nothing for a gross game", () => {
    const allocation = gameStrokeAllocation(
      { kind: "skins", id: gameId("g2"), scoring: "gross", players: [golferId("bo"), golferId("cy")] },
      roster,
      fixtureLinks18,
    );
    expect(allocation.size).toBe(0);
  });

  it("fourball: dots relative to the lowest in the field (Bo) — 6/0/13/3 by SI", () => {
    const allocation = gameStrokeAllocation(fourball, players, fixtureLinks18);
    const expectedRelative: Readonly<Record<string, number>> = { [ann]: 6, [bo]: 0, [cal]: 13, [dee]: 3 };
    for (const [id, relative] of Object.entries(expectedRelative)) {
      expect(allocation.get(golferId(id))).toEqual(dotsByHole(relative, whiteTeeSet));
    }
  });

  it("skins: the SAME allocation as the fourball — one rule, one field, no per-kind convention", () => {
    const allocation = gameStrokeAllocation(skins, players, fixtureLinks18);
    const expectedRelative: Readonly<Record<string, number>> = { [ann]: 6, [bo]: 0, [cal]: 13, [dee]: 3 };
    for (const [id, relative] of Object.entries(expectedRelative)) {
      expect(allocation.get(golferId(id))).toEqual(dotsByHole(relative, whiteTeeSet));
    }
  });

  it("a >=19 relative allocation wraps past a full lap: SI 1 gets 2 dots", () => {
    // ch 22 against a low of 0 is a difference of 22 — over 18 holes that's 1 dot everywhere
    // plus 4 extra on SI 1-4 (holes 2, 10, 7, 13).
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
    expect(allocation.get(high)).toEqual(dotsByHole(22, whiteTeeSet));
    // Hole 2 carries strokeIndex 1 on fixtureWhite18 — the >=19 wrap must land a
    // second dot there, not just one.
    expect(allocation.get(high)?.get(2)).toBe(2);
  });

  it("gross stroke-play allocates nothing: the whole allocation is empty", () => {
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

describe("courseHandicapAllocation", () => {
  // The standard card's own dots: each player's FULL course handicap allocated by stroke
  // index — no game. Unlike gameStrokeAllocation (relative to a game's own field), this is just
  // dotsByHole(participant.courseHandicap, theirTeeSet) per player.
  it("a CH-8 player gets 8 dots on their tee's 8 hardest SI holes", () => {
    const golfer = golferId("ch8");
    const participants: readonly Participant[] = [{ golferId: golfer, name: "Eight", tee: "white", courseHandicap: 8 }];
    const allocation = courseHandicapAllocation(participants, fixtureLinks18);
    expect(allocation.get(golfer)).toEqual(dotsByHole(8, whiteTeeSet));
    expect(totalDots(allocation.get(golfer)!)).toBe(8);
  });

  it("a CH-0 player gets a zero allocation on every hole (dotsByHole(0, ...)'s own shape)", () => {
    const golfer = golferId("ch0");
    const participants: readonly Participant[] = [{ golferId: golfer, name: "Zero", tee: "white", courseHandicap: 0 }];
    const allocation = courseHandicapAllocation(participants, fixtureLinks18);
    expect(allocation.get(golfer)).toEqual(dotsByHole(0, whiteTeeSet));
    expect(totalDots(allocation.get(golfer)!)).toBe(0);
  });

  it("a plus player (CH -2) gives strokes back on the 2 easiest SI holes — negative dots, dotsByHole's own convention", () => {
    const golfer = golferId("plus2");
    const participants: readonly Participant[] = [{ golferId: golfer, name: "Plus", tee: "white", courseHandicap: -2 }];
    const allocation = courseHandicapAllocation(participants, fixtureLinks18);
    expect(allocation.get(golfer)).toEqual(dotsByHole(-2, whiteTeeSet));
    expect(totalDots(allocation.get(golfer)!)).toBe(-2);
  });

  it("allocates independently per participant, each against their own tee and course handicap", () => {
    const a = golferId("multi-a");
    const b = golferId("multi-b");
    const participants: readonly Participant[] = [
      { golferId: a, name: "A", tee: "white", courseHandicap: 8 },
      { golferId: b, name: "B", tee: "white", courseHandicap: -2 },
    ];
    const allocation = courseHandicapAllocation(participants, fixtureLinks18);
    expect(allocation.get(a)).toEqual(dotsByHole(8, whiteTeeSet));
    expect(allocation.get(b)).toEqual(dotsByHole(-2, whiteTeeSet));
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
  it("agrees with gameStrokeAllocation's own per-golfer allocation on the fourball fixture (6/0/13/3)", () => {
    const allocation = gameStrokeAllocation(fourball, players, fixtureLinks18);
    const expectedRelative: Readonly<Record<string, number>> = { [ann]: 6, [bo]: 0, [cal]: 13, [dee]: 3 };
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
  const skinsGame = { kind: "skins", id: gameId("k9"), scoring: "net", players: [A, B, C] } as const;
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
