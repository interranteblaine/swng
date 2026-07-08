import { describe, expect, it } from "vitest";
import { gameId, golferId } from "../ids.js";
import { playGoldenRound } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";

// The milestone's headline claim: ONE event log carries TWO games with DIFFERENT
// handicapping over the same strokes, and one correcting event recomputes both.
const A = golferId("ann");
const B = golferId("bo");
const C = golferId("cal");
const players3 = [
  { golferId: A, name: "Ann", tee: "white", courseHandicap: 8 },
  { golferId: B, name: "Bo", tee: "white", courseHandicap: 2 },
  { golferId: C, name: "Cal", tee: "white", courseHandicap: 12 },
];
const skins = { kind: "skins", id: gameId("k9"), players: [A, B, C] } as const;
const stableford = { kind: "stableford", id: gameId("s9"), players: [A, B, C] } as const;
// The skins golden card. Skins reads it at full handicap (Cal 12 dots: all nine +
// h2/h4/h7); stableford reads the SAME cells at 95% (Cal 11 dots: all nine + h2/h7).
const cards = {
  [A]: [5, 5, 4, 6, 5, 4, 5, 6, "picked-up"],
  [B]: [4, 5, 3, 6, 4, 4, 4, 5, 4],
  [C]: [6, 7, 4, 8, 6, 5, 6, 7, 6],
} as const;

describe("one log, many games", () => {
  it("skins (full handicap) and stableford (95%) score the same cells differently", () => {
    // Stableford — Ann: pts 2,2,1,2,2,2,2,2,0(PU) = 15; Bo: 2,2,2,1,2,1,3,2,2 = 17;
    // Cal nets 5,5,3,7,5,4,4,6,5 → pts 1,1,2,0,1,1,2,1,1 = 10 (h4 loses its skins dot at 95%).
    const [skinsState, stablefordState] = playGoldenRound(fixtureLinks, players3, [skins, stableford], cards);
    expect(skinsState).toMatchObject({
      kind: "skins", complete: true, carrying: 0, carriedOut: 0,
      lines: [
        { golferId: A, skins: 6 },
        { golferId: B, skins: 3 },
        { golferId: C, skins: 0 },
      ],
    });
    expect(stablefordState).toMatchObject({
      kind: "stableford", complete: true,
      lines: [
        { golferId: A, thru: 9, points: 15 },
        { golferId: B, thru: 9, points: 17 },
        { golferId: C, thru: 9, points: 10 },
      ],
    });
  });

  it("one later-hlc correction to a single cell recomputes both games", () => {
    // Ann's h9 pickup was wrong — she holed out in 4 gross (net 3). Skins: the h8
    // carry's pot of 2 goes to Ann instead of Bo → Ann 8, Bo 1. Stableford: Ann's
    // h9 scores 3 pts → 18. Bo's cells never changed, so Bo stays 17 in stableford.
    const [skinsState, stablefordState] = playGoldenRound(fixtureLinks, players3, [skins, stableford], cards, [
      { golfer: A, hole: 9, score: 4 },
    ]);
    expect(skinsState).toMatchObject({
      kind: "skins", complete: true, carrying: 0, carriedOut: 0,
      lines: [
        { golferId: A, skins: 8 },
        { golferId: B, skins: 1 },
        { golferId: C, skins: 0 },
      ],
    });
    expect(stablefordState).toMatchObject({
      kind: "stableford", complete: true,
      lines: [
        { golferId: A, thru: 9, points: 18 },
        { golferId: B, thru: 9, points: 17 },
        { golferId: C, thru: 9, points: 10 },
      ],
    });
  });
});
