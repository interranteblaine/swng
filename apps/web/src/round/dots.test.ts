import { describe, expect, it } from "vitest";
import { anchorOf, fixtureLinks, fixtureLinks18, gameId, golferId, resolveStrokes } from "@swng/domain";
import type { CourseCard, GameConfig, Participant, RosterEntry } from "@swng/domain";
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

// What a player states about themselves (spec 2026-07-29 §2a) — the only input gameDots reads.
const participant = (id: ReturnType<typeof golferId>, name: string, overPar: number): Participant => ({ golferId: id, name, tee: TEE, basis: { kind: "normally-shoots", overPar } });

// A folded roster. gameDots resolves each GAME's own field and never reads `.strokes`, but a
// fixture that hand-stated one would be a roster reduceRound could not produce — so this derives
// it with the domain's own rule over the WHOLE roster, exactly as the fold does. (A test may
// compute its own oracles straight from @swng/domain; the compute fence covers product code.)
const roster = (entries: readonly Participant[], card: CourseCard = CARD): readonly RosterEntry[] => {
  const bases = entries.map(({ golferId: id, basis }) => ({ golferId: id, basis }));
  const strokes = resolveStrokes(bases, card.teeSets[0]!.holes.length, anchorOf(bases));
  return entries.map((entry) => ({ ...entry, strokes: strokes.get(entry.golferId)! }));
};

describe("gameDots", () => {
  // Ann 10, Bo 4 — a difference of 6, halved on this nine-hole card, so Ann gets 3 dots and Bo,
  // the lowest in the field, plays off scratch. The SAME numbers on every kind: no per-kind
  // convention and no allowance percentage survives to make two games disagree (spec §3).
  const annAndBo = roster([participant(ANN, "Ann", 10), participant(BO, "Bo", 4)]);
  const twoPlayerGames: readonly GameConfig[] = [
    { kind: "stableford", id: gameId("g"), players: [ANN, BO] },
    { kind: "skins", id: gameId("g"), scoring: "net", players: [ANN, BO] },
    { kind: "stroke-play", id: gameId("g"), scoring: "net", players: [ANN, BO] },
    { kind: "singles-match", id: gameId("g"), a: ANN, b: BO },
  ];

  it("every kind takes the difference from the lowest in the field, halved on a nine-hole card", () => {
    for (const config of twoPlayerGames) {
      const dots = gameDots(config, annAndBo, CARD);
      expect(totalDots(dots.get(ANN)!)).toBe(3);
      expect(totalDots(dots.get(BO)!)).toBe(0);
    }
  });

  it("the same field on an eighteen-hole card gets the whole difference, unhalved", () => {
    for (const config of twoPlayerGames) {
      const dots = gameDots(config, roster(annAndBo, fixtureLinks18), fixtureLinks18);
      expect(totalDots(dots.get(ANN)!)).toBe(6);
      expect(totalDots(dots.get(BO)!)).toBe(0);
    }
  });

  it("a gross game allocates nothing at all — on either kind that offers the choice", () => {
    expect(gameDots({ kind: "stroke-play", id: gameId("g"), scoring: "gross", players: [ANN, BO] }, annAndBo, CARD).size).toBe(0);
    expect(gameDots({ kind: "skins", id: gameId("g"), scoring: "gross", players: [ANN, BO] }, annAndBo, CARD).size).toBe(0);
  });

  it("singles-match: the relief flips when b is the higher number", () => {
    const participants = roster([participant(ANN, "Ann", 4), participant(BO, "Bo", 10)]);
    const config: GameConfig = { kind: "singles-match", id: gameId("g"), a: ANN, b: BO };

    const dots = gameDots(config, participants, CARD);

    expect(totalDots(dots.get(ANN)!)).toBe(0);
    expect(totalDots(dots.get(BO)!)).toBe(3);
  });

  it("fourball-match: all four relative to the lowest of the four", () => {
    const participants = roster([participant(ANN, "Ann", 10), participant(BO, "Bo", 6), participant(CAL, "Cal", 14), participant(DEE, "Dee", 2)]);
    const config: GameConfig = { kind: "fourball-match", id: gameId("g"), a: [ANN, BO], b: [CAL, DEE] };

    const dots = gameDots(config, participants, CARD);

    // Differences from Dee's 2 are 8/4/12/0, halved: 4/2/6/0.
    expect(totalDots(dots.get(ANN)!)).toBe(4);
    expect(totalDots(dots.get(BO)!)).toBe(2);
    expect(totalDots(dots.get(CAL)!)).toBe(6);
    expect(totalDots(dots.get(DEE)!)).toBe(0); // Dee is the lowest — plays off scratch, gets no strokes
  });

  it("the field is the GAME's members, not the round's roster", () => {
    // Dee at 2 is the lowest in the ROUND, but she is not in this game, so Bo anchors it: Cal's
    // 14 − 4 = 10 halves to 5 dots, not the 6 he would get off Dee.
    const participants = roster([participant(ANN, "Ann", 10), participant(BO, "Bo", 4), participant(CAL, "Cal", 14), participant(DEE, "Dee", 2)]);
    const config: GameConfig = { kind: "stableford", id: gameId("g"), players: [BO, CAL] };

    const dots = gameDots(config, participants, CARD);

    expect(totalDots(dots.get(BO)!)).toBe(0);
    expect(totalDots(dots.get(CAL)!)).toBe(5);
    expect(dots.has(DEE)).toBe(false);
  });
});

// AddGameForm.test.tsx's "strokes preview" describe block covers the ordinary receives/omit
// case (through a render); these edge cases — the all-scratch line and a gross game's absent
// one — are pinned directly against the same fixture card here instead.
describe("strokesSummary", () => {
  it("omits the members with no strokes and names the rest, in gameMembers order", () => {
    // Ann anchors the field at -1, so she gets nothing and Bo's 3 − (−1) = 4 halves to 2 dots.
    // Nobody can go BELOW the anchor, so `strokeGrant`'s give-back branch is now unreachable
    // through gameDots — Task 5 deletes it along with the whole plus-handicap convention.
    const participants = roster([participant(ANN, "Ann", -1), participant(BO, "Bo", 3)]);
    const config: GameConfig = { kind: "skins", id: gameId("g"), scoring: "net", players: [ANN, BO] };

    expect(strokesSummary(config, participants, CARD)).toBe("Bo 2 dots");
  });

  it("reads 'everyone in this game plays level' when every member's total is zero", () => {
    const participants = roster([participant(ANN, "Ann", 0), participant(BO, "Bo", 0)]);
    const config: GameConfig = { kind: "skins", id: gameId("g"), scoring: "net", players: [ANN, BO] };

    expect(strokesSummary(config, participants, CARD)).toBe("No strokes — everyone in this game plays level.");
  });

  // The case the old copy ("everyone plays off 0") got WRONG, and which an all-zero fixture cannot
  // detect: under the relative rule an all-zero allocation means the members are EQUAL, at whatever
  // level — two golfers who both play to 12 receive nothing from each other and are not scratch.
  it("says the same thing for two EQUAL non-zero players — nobody is off 0 here", () => {
    const participants = roster([participant(ANN, "Ann", 12), participant(BO, "Bo", 12)]);
    const config: GameConfig = { kind: "skins", id: gameId("g"), scoring: "net", players: [ANN, BO] };

    expect(strokesSummary(config, participants, CARD)).toBe("No strokes — everyone in this game plays level.");
  });

  it("renders nothing at all for a gross game — it has no strokes by definition, not zero of them", () => {
    const participants = roster([participant(ANN, "Ann", 10), participant(BO, "Bo", 4)]);
    const gross: GameConfig = { kind: "skins", id: gameId("g"), scoring: "gross", players: [ANN, BO] };

    expect(strokesSummary(gross, participants, CARD)).toBeUndefined();
  });
});
