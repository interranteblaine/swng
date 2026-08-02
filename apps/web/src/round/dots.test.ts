import { describe, expect, it } from "vitest";
import { fixtureLinks, fixtureLinks18, gameId, golferId } from "@swng/domain";
import type { GameConfig, RosterEntry } from "@swng/domain";
import { gameDots, strokesSummary, totalDots } from "./dots";

// fixtureLinks (packages/domain/src/scoring/golden/fixtureCourse.ts) carries one 9-hole tee
// set, "white" — every participant below plays it, so gameDots' per-hole allocation always
// sums back to whatever raw stroke value the formula below hands dotsByHole (allocateStrokes'
// own documented invariant), which is what makes totalDots(...) an exact, not approximate,
// check against the domain primitives.
const CARD = fixtureLinks;
const TEE = "white";

const ANN = golferId("ann");
const BO = golferId("bo");
const CAL = golferId("cal");
const DEE = golferId("dee");

// A roster seat: the strokes the group typed (spec 2026-07-30 §2), which is the only input
// gameDots reads.
const participant = (id: ReturnType<typeof golferId>, name: string, strokes: number): RosterEntry => ({ golferId: id, name, tee: TEE, strokes });

describe("gameDots", () => {
  // Ann on 3, Bo on 0. A MEDAL kind gives each their own number; a MATCH kind gives the
  // difference — and with Bo already on 0 the two coincide here, so one expectation covers all
  // four (spec 2026-07-30 §3; the two arms are pinned APART in the domain's allocation.test.ts,
  // which is where the hole placement that distinguishes them lives).
  const annAndBo: readonly RosterEntry[] = [participant(ANN, "Ann", 3), participant(BO, "Bo", 0)];
  const twoPlayerGames: readonly GameConfig[] = [
    { kind: "stableford", id: gameId("g"), players: [ANN, BO] },
    { kind: "skins", id: gameId("g"), scoring: "net", players: [ANN, BO] },
    { kind: "stroke-play", id: gameId("g"), scoring: "net", players: [ANN, BO] },
    { kind: "singles-match", id: gameId("g"), a: ANN, b: BO },
  ];

  it("every kind allocates the roster's own numbers when the lowest is already zero", () => {
    for (const config of twoPlayerGames) {
      const dots = gameDots(config, annAndBo, CARD, "all");
      expect(totalDots(dots.get(ANN)!)).toBe(3);
      expect(totalDots(dots.get(BO)!)).toBe(0);
    }
  });

  it("the same field on an eighteen-hole card gets the same COUNT — the card only changes where the dots land", () => {
    for (const config of twoPlayerGames) {
      const dots = gameDots(config, annAndBo, fixtureLinks18, "all");
      expect(totalDots(dots.get(ANN)!)).toBe(3);
      expect(totalDots(dots.get(BO)!)).toBe(0);
    }
  });

  it("a gross game allocates nothing at all — on either kind that offers the choice", () => {
    expect(gameDots({ kind: "stroke-play", id: gameId("g"), scoring: "gross", players: [ANN, BO] }, annAndBo, CARD, "all").size).toBe(0);
    expect(gameDots({ kind: "skins", id: gameId("g"), scoring: "gross", players: [ANN, BO] }, annAndBo, CARD, "all").size).toBe(0);
  });

  it("singles-match: the relief flips when b is the higher number", () => {
    const participants = [participant(ANN, "Ann", 0), participant(BO, "Bo", 3)];
    const config: GameConfig = { kind: "singles-match", id: gameId("g"), a: ANN, b: BO };

    const dots = gameDots(config, participants, CARD, "all");

    expect(totalDots(dots.get(ANN)!)).toBe(0);
    expect(totalDots(dots.get(BO)!)).toBe(3);
  });

  it("fourball-match: all four off the lowest of the four", () => {
    const participants = [participant(ANN, "Ann", 4), participant(BO, "Bo", 2), participant(CAL, "Cal", 6), participant(DEE, "Dee", 1)];
    const config: GameConfig = { kind: "fourball-match", id: gameId("g"), a: [ANN, BO], b: [CAL, DEE] };

    const dots = gameDots(config, participants, CARD, "all");

    // Differences from Dee's 1: 3/1/5/0.
    expect(totalDots(dots.get(ANN)!)).toBe(3);
    expect(totalDots(dots.get(BO)!)).toBe(1);
    expect(totalDots(dots.get(CAL)!)).toBe(5);
    expect(totalDots(dots.get(DEE)!)).toBe(0); // Dee is the lowest of the four — she gives, never gets
  });

  it("a MEDAL game keeps the card's own numbers even when the game's lowest is above zero", () => {
    // The behaviour the prior model got wrong: a stableford between Bo (4) and Cal (14) once
    // re-anchored on Bo, showing Cal 10 dots where the card showed 14 (spec 2026-07-30 §3).
    const participants = [participant(ANN, "Ann", 10), participant(BO, "Bo", 4), participant(CAL, "Cal", 14), participant(DEE, "Dee", 2)];
    const config: GameConfig = { kind: "stableford", id: gameId("g"), players: [BO, CAL] };

    const dots = gameDots(config, participants, CARD, "all");

    expect(totalDots(dots.get(BO)!)).toBe(4);
    expect(totalDots(dots.get(CAL)!)).toBe(14);
    expect(dots.has(DEE)).toBe(false);
  });

  // The round's own hole selection (spec 2026-08-02 §3c/Task 7 amendment): gameDots' per-hole map
  // must resolve THROUGH the round's selection, not always the whole tee set — a live trap for
  // any future per-hole consumer if it silently stayed pinned to "all".
  it("resolves the round's OWN hole selection — a back-nine round allocates only onto holes 10-18", () => {
    const participants = [participant(ANN, "Ann", 0), participant(BO, "Bo", 3)];
    const config: GameConfig = { kind: "stableford", id: gameId("g"), players: [ANN, BO] };

    const dots = gameDots(config, participants, fixtureLinks18, "back");

    const perHole = dots.get(BO)!;
    expect([...perHole.keys()].every((hole) => hole > 9)).toBe(true);
    expect(totalDots(perHole)).toBe(3); // allocateStrokes' own invariant: the sum always equals the input, whatever the hole list
  });
});

// AddGameForm.test.tsx's "strokes preview" describe block covers the ordinary receives/omit
// case (through a render); these edge cases — the all-scratch line and a gross game's absent
// one — are pinned directly against the same fixture card here instead.
describe("strokesSummary", () => {
  it("omits the members with no strokes and names the rest, in gameMembers order", () => {
    const participants = [participant(ANN, "Ann", 0), participant(BO, "Bo", 2)];
    const config: GameConfig = { kind: "skins", id: gameId("g"), scoring: "net", players: [ANN, BO] };

    expect(strokesSummary(config, participants, CARD, "all")).toBe("Bo 2 dots");
  });

  it("reads 'everyone in this game plays level' when every member's total is zero", () => {
    const participants = [participant(ANN, "Ann", 0), participant(BO, "Bo", 0)];
    const config: GameConfig = { kind: "skins", id: gameId("g"), scoring: "net", players: [ANN, BO] };

    expect(strokesSummary(config, participants, CARD, "all")).toBe("No strokes — everyone in this game plays level.");
  });

  // In a MATCH an all-zero allocation means the members are EQUAL, at whatever level — two
  // golfers both on 12 receive nothing from each other and are not scratch. The line says the
  // true thing in both cases; "everyone plays off 0" (its old wording) would be false here.
  it("says the same thing for two EQUAL non-zero players in a match — nobody is off 0 here", () => {
    const participants = [participant(ANN, "Ann", 12), participant(BO, "Bo", 12)];
    const config: GameConfig = { kind: "singles-match", id: gameId("g"), a: ANN, b: BO };

    expect(strokesSummary(config, participants, CARD, "all")).toBe("No strokes — everyone in this game plays level.");
  });

  it("renders nothing at all for a gross game — it has no strokes by definition, not zero of them", () => {
    const participants = [participant(ANN, "Ann", 3), participant(BO, "Bo", 0)];
    const gross: GameConfig = { kind: "skins", id: gameId("g"), scoring: "gross", players: [ANN, BO] };

    expect(strokesSummary(gross, participants, CARD, "all")).toBeUndefined();
  });

  // The task-3+3b review's own proof, executed rather than just asserted in prose: strokesSummary
  // renders only totalDots(...) per member, and allocateStrokes' allocation always sums exactly to
  // its input for ANY hole list — so the rendered line is provably invariant under the round's
  // hole selection, even though gameDots' underlying per-hole map (pinned above) genuinely moves.
  it("renders the identical line under every hole selection — the total is invariant even though the per-hole map moves", () => {
    const participants = [participant(ANN, "Ann", 0), participant(BO, "Bo", 3)];
    const config: GameConfig = { kind: "skins", id: gameId("g"), scoring: "net", players: [ANN, BO] };

    const all = strokesSummary(config, participants, fixtureLinks18, "all");
    const front = strokesSummary(config, participants, fixtureLinks18, "front");
    const back = strokesSummary(config, participants, fixtureLinks18, "back");

    expect(all).toBe("Bo 3 dots");
    expect(front).toBe(all);
    expect(back).toBe(all);
  });
});
