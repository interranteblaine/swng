import { describe, expect, it } from "vitest";
import { gameId, golferId } from "../ids.js";
import type { Participant } from "../round/participant.js";
import { playGoldenRound } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";

// The milestone's headline claim: ONE event log carries TWO games scoring the same strokes by
// different rules — pots against points — and one correcting event recomputes both. (The two
// games used to differ by handicap ALLOWANCE too; every kind now applies the one rule to its own
// field, so a shared field means a shared allocation and the difference is purely in the scoring.)
const A = golferId("ann");
const B = golferId("bo");
const C = golferId("cal");
const players3: readonly Participant[] = [
  { golferId: A, name: "Ann", tee: "white", basis: { kind: "normally-shoots", overPar: 8 } },
  { golferId: B, name: "Bo", tee: "white", basis: { kind: "normally-shoots", overPar: 2 } },
  { golferId: C, name: "Cal", tee: "white", basis: { kind: "normally-shoots", overPar: 12 } },
];
const skins = { kind: "skins", id: gameId("k9"), scoring: "net", players: [A, B, C] } as const;
const stableford = { kind: "stableford", id: gameId("s9"), players: [A, B, C] } as const;
// The skins golden card. Both games share the field, so both read the same dots: differences from
// Bo's 2, halved on a nine-hole card — Ann 3 (h2/h7/h4), Bo 0, Cal 5 (h2/h7/h4/h8/h1).
const cards = {
  [A]: [5, 5, 4, 6, 5, 4, 5, 6, "picked-up"],
  [B]: [4, 5, 3, 6, 4, 4, 4, 5, 4],
  [C]: [6, 7, 4, 8, 6, 5, 6, 7, 6],
} as const;

describe("one log, many games", () => {
  it("skins and stableford score the same cells by different rules — pots against points", () => {
    // Nets — Ann 5,4,4,5,5,4,4,6,PU; Bo 4,5,3,6,4,4,4,5,4; Cal 5,6,4,7,6,5,5,6,6.
    // Skins: Bo h1, Ann h2, Bo h3, Ann h4, Bo h5, carries on h6–h7, Bo takes the 3 on h8, Bo h9.
    // Stableford — Ann: pts 1,2,1,2,1,1,2,1,0(PU) = 11; Bo: 2,1,2,1,2,1,2,2,2 = 15;
    // Cal: 1,0,1,0,0,0,1,1,0 = 4.
    const [skinsState, stablefordState] = playGoldenRound(fixtureLinks, players3, [skins, stableford], cards);
    expect(skinsState).toMatchObject({
      kind: "skins", complete: true, carrying: 0, carriedOut: 0,
      lines: [
        { golferId: A, skins: 2 },
        { golferId: B, skins: 7 },
        { golferId: C, skins: 0 },
      ],
    });
    expect(stablefordState).toMatchObject({
      kind: "stableford", complete: true,
      lines: [
        { golferId: A, thru: 9, points: 11 },
        { golferId: B, thru: 9, points: 15 },
        { golferId: C, thru: 9, points: 4 },
      ],
    });
  });

  it("one later-hlc correction to a single cell recomputes both games", () => {
    // Ann's h9 pickup was wrong — she holed out in 4 gross (net 4: h9 is SI 6, so she has no dot
    // there). Skins: h9 becomes a tie between Ann and Bo, so Bo's outright h9 win becomes a
    // strand — Bo 6 and 1 carried out. Stableford: Ann's h9 scores 2 pts → 13. Bo's and Cal's
    // cells never changed, so their points stand.
    const [skinsState, stablefordState] = playGoldenRound(fixtureLinks, players3, [skins, stableford], cards, [
      { golfer: A, hole: 9, score: 4 },
    ]);
    expect(skinsState).toMatchObject({
      kind: "skins", complete: true, carrying: 0, carriedOut: 1,
      lines: [
        { golferId: A, skins: 2 },
        { golferId: B, skins: 6 },
        { golferId: C, skins: 0 },
      ],
    });
    expect(stablefordState).toMatchObject({
      kind: "stableford", complete: true,
      lines: [
        { golferId: A, thru: 9, points: 13 },
        { golferId: B, thru: 9, points: 15 },
        { golferId: C, thru: 9, points: 4 },
      ],
    });
  });
});
