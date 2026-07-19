import { describe, expect, it } from "vitest";
import { defaultAllowance, fixtureLinks, gameId, golferId, playingHandicap } from "@swng/domain";
import type { GameConfig, Participant } from "@swng/domain";
import { gameDots, gamePlayers, strokesSummary, totalDots } from "./dots";

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

const participant = (id: ReturnType<typeof golferId>, name: string, courseHandicap: number): Participant => ({ golferId: id, name, tee: TEE, courseHandicap });

describe("gamePlayers", () => {
  it("reads players/sides per kind, in the config's own order", () => {
    const strokePlay: GameConfig = { kind: "stroke-play", id: gameId("g"), scoring: "net", players: [ANN, BO] };
    const singles: GameConfig = { kind: "singles-match", id: gameId("g"), a: ANN, b: BO };
    const fourball: GameConfig = { kind: "fourball-match", id: gameId("g"), a: [ANN, BO], b: [CAL, DEE] };

    expect(gamePlayers(strokePlay)).toEqual([ANN, BO]);
    expect(gamePlayers(singles)).toEqual([ANN, BO]);
    expect(gamePlayers(fourball)).toEqual([ANN, BO, CAL, DEE]);
  });
});

describe("gameDots", () => {
  it("stableford: every player at playingHandicap(courseHandicap, allowance)", () => {
    const participants = [participant(ANN, "Ann", 8)];
    const config: GameConfig = { kind: "stableford", id: gameId("g"), players: [ANN] };

    const dots = gameDots(config, participants, CARD);

    const expectedAnn = playingHandicap(8, defaultAllowance("stableford"));
    expect(totalDots(dots.get(ANN)!)).toBe(expectedAnn);
  });

  it("skins: full allowance (100%), same shape as stableford", () => {
    const participants = [participant(ANN, "Ann", 10)];
    const config: GameConfig = { kind: "skins", id: gameId("g"), players: [ANN] };

    const dots = gameDots(config, participants, CARD);

    expect(totalDots(dots.get(ANN)!)).toBe(playingHandicap(10, defaultAllowance("skins")));
  });

  it("stroke-play net: playingHandicap(courseHandicap, allowance); gross: no dots at all", () => {
    const participants = [participant(ANN, "Ann", 12)];
    const net: GameConfig = { kind: "stroke-play", id: gameId("g"), scoring: "net", players: [ANN] };
    const gross: GameConfig = { kind: "stroke-play", id: gameId("g"), scoring: "gross", players: [ANN] };

    expect(totalDots(gameDots(net, participants, CARD).get(ANN)!)).toBe(playingHandicap(12, defaultAllowance("stroke-play")));
    expect(gameDots(gross, participants, CARD).size).toBe(0);
  });

  it("singles-match: only the higher-handicap player gets dots, equal to the difference", () => {
    const participants = [participant(ANN, "Ann", 10), participant(BO, "Bo", 4)];
    const config: GameConfig = { kind: "singles-match", id: gameId("g"), a: ANN, b: BO };

    const dots = gameDots(config, participants, CARD);

    expect(totalDots(dots.get(ANN)!)).toBe(playingHandicap(6, defaultAllowance("singles-match")));
    expect(totalDots(dots.get(BO)!)).toBe(0);
  });

  it("singles-match: the relief flips when b is the higher handicap", () => {
    const participants = [participant(ANN, "Ann", 4), participant(BO, "Bo", 10)];
    const config: GameConfig = { kind: "singles-match", id: gameId("g"), a: ANN, b: BO };

    const dots = gameDots(config, participants, CARD);

    expect(totalDots(dots.get(ANN)!)).toBe(0);
    expect(totalDots(dots.get(BO)!)).toBe(playingHandicap(6, defaultAllowance("singles-match")));
  });

  it("fourball-match: every player relative to the lowest playing handicap among the four", () => {
    const participants = [participant(ANN, "Ann", 10), participant(BO, "Bo", 6), participant(CAL, "Cal", 14), participant(DEE, "Dee", 2)];
    const config: GameConfig = { kind: "fourball-match", id: gameId("g"), a: [ANN, BO], b: [CAL, DEE] };
    const allowance = defaultAllowance("fourball-match");

    const dots = gameDots(config, participants, CARD);

    const playingHcps = { ann: playingHandicap(10, allowance), bo: playingHandicap(6, allowance), cal: playingHandicap(14, allowance), dee: playingHandicap(2, allowance) };
    const low = Math.min(...Object.values(playingHcps));
    expect(totalDots(dots.get(ANN)!)).toBe(playingHcps.ann - low);
    expect(totalDots(dots.get(BO)!)).toBe(playingHcps.bo - low);
    expect(totalDots(dots.get(CAL)!)).toBe(playingHcps.cal - low);
    expect(totalDots(dots.get(DEE)!)).toBe(0); // Dee is the low playing handicap — plays scratch
  });

  it("honors an explicit allowance override instead of the per-kind default", () => {
    const participants = [participant(ANN, "Ann", 20)];
    const config: GameConfig = { kind: "stableford", id: gameId("g"), players: [ANN], allowance: 0.5 };

    const dots = gameDots(config, participants, CARD);

    expect(totalDots(dots.get(ANN)!)).toBe(playingHandicap(20, 0.5));
    expect(totalDots(dots.get(ANN)!)).not.toBe(playingHandicap(20, defaultAllowance("stableford")));
  });
});

// AddGameForm.test.tsx's "strokes preview" describe block covers the ordinary receives/omit
// case (through a render); these two edge cases — a plus-handicap "gives" and the all-scratch
// empty line — have no live UI trigger yet (no give-back fixture is wired into the form's own
// participants), so they're pinned directly against the same fixture card here instead.
describe("strokesSummary", () => {
  it("reads a plus handicap as 'gives N', a normal handicap as 'N dots', in gameMembers order", () => {
    // Skins is full-handicap (allowance 1): Ann's course handicap -1 gives one stroke back.
    const participants = [participant(ANN, "Ann", -1), participant(BO, "Bo", 3)];
    const config: GameConfig = { kind: "skins", id: gameId("g"), players: [ANN, BO] };

    expect(strokesSummary(config, participants, CARD)).toBe("Ann gives 1 · Bo 3 dots");
  });

  it("reads 'No strokes — everyone plays scratch.' when every member's total is zero", () => {
    const participants = [participant(ANN, "Ann", 0), participant(BO, "Bo", 0)];
    const config: GameConfig = { kind: "skins", id: gameId("g"), players: [ANN, BO] };

    expect(strokesSummary(config, participants, CARD)).toBe("No strokes — everyone plays scratch.");
  });
});
