import { describe, expect, it } from "vitest";
import { gameId, golferId } from "../ids.js";
import { playGoldenRound } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";

const A = golferId("ann");
const B = golferId("bo");
const players = [
  { golferId: A, name: "Ann", tee: "white", courseHandicap: 8 },
  { golferId: B, name: "Bo", tee: "white", courseHandicap: 2 },
];
const game = { kind: "stableford", id: gameId("s1"), players: [A, B] } as const;

describe("stableford — golden cards", () => {
  it("standard points with a pickup scoring zero: Ann 10, Bo 17", () => {
    // Strokes are the difference from the lowest in the field (spec §2b): Bo at 2 is the lowest, so
    // he plays off scratch — 0 dots, net === gross — and Ann's 8 − 2 = 6, halved on a nine-hole
    // card, gives her 3 dots on SI 1..3 (holes 2, 4, 7).
    // Ann: nets 5,5,3,PU,5,4,4,6,5 → pts 1,1,2,0,1,1,2,1,1 = 10
    // Bo: nets 4,4,3,5,5,3,4,5,4 → pts 2,2,2,2,1,2,2,2,2 = 17
    const [state] = playGoldenRound(fixtureLinks, players, [game], {
      [A]: [5, 6, 3, "picked-up", 5, 4, 5, 6, 5],
      [B]: [4, 4, 3, 5, 5, 3, 4, 5, 4],
    });
    // Bo's higher points total (17 > 10) leads outright.
    expect(state).toMatchObject({
      kind: "stableford", complete: true,
      lines: [
        { golferId: A, thru: 9, points: 10 },
        { golferId: B, thru: 9, points: 17 },
      ],
      leaders: [B],
    });
  });

  it("mid-round points run over decided holes only", () => {
    const [state] = playGoldenRound(fixtureLinks, players, [game], { [A]: [5, 6], [B]: [4] });
    // Ann: h1 net 5 (h1 is SI 5 — no dot) → 1 pt; h2 net 5 (one dot) → 1 pt. Bo: h1 net 4 → 2 pts.
    // The two are level on points at DIFFERENT thru counts, which states the leader rule plainly:
    // leaders come from points alone, never from how far anyone has played.
    expect(state).toMatchObject({
      complete: false,
      lines: [{ golferId: A, thru: 2, points: 2 }, { golferId: B, thru: 1, points: 2 }],
      leaders: [A, B],
    });
  });

  it("a tie for the lead lists every tied golferId", () => {
    // Same course handicap (so identical dots) and identical scores guarantee a tie without
    // hand-computing net/points arithmetic for two different handicaps.
    const D = golferId("dee");
    const E = golferId("eve");
    const equalHandicapPlayers = [
      { golferId: D, name: "Dee", tee: "white", courseHandicap: 5 },
      { golferId: E, name: "Eve", tee: "white", courseHandicap: 5 },
    ];
    const tieGame = { kind: "stableford", id: gameId("s4"), players: [D, E] } as const;
    const [state] = playGoldenRound(fixtureLinks, equalHandicapPlayers, [tieGame], {
      [D]: [5, 6, 3, "picked-up", 5, 4, 5, 6, 5],
      [E]: [5, 6, 3, "picked-up", 5, 4, 5, 6, 5],
    });
    expect(state).toMatchObject({ kind: "stableford", complete: true, leaders: [D, E] });
  });

  it("counts decided holes anywhere on the card, not just a dense prefix: a mid-card gap still totals across it", () => {
    // Medal-family engines (unlike match play's sequential decided-prefix) resolve a
    // hole wherever its cell exists — scoreStableford's loop `continue`s past a
    // missing cell instead of breaking, so a gap doesn't stop later holes counting.
    const soloGame = { kind: "stableford", id: gameId("s2"), players: [A] } as const;
    // Ann is the only player in THIS game, so she is her own field's anchor and receives nothing
    // (spec §2b: strokes cannot be allocated when only one person's level is known — correct, not
    // degenerate). She plays h1 and h3 but leaves h2 with no cell at all.
    // h1: par4, no dot -> net 5, pts max(0, 2+4-5) = 1
    // h2: no cell recorded — not counted in thru or points
    // h3: par3, no dot -> net 3, pts 2+3-3 = 2
    // thru = 2 (both decided holes, despite the gap at h2); points = 1+2 = 3
    const [state] = playGoldenRound(fixtureLinks, players, [soloGame], { [A]: [5, null, 3] });
    expect(state).toMatchObject({
      kind: "stableford", complete: false,
      lines: [{ golferId: A, thru: 2, points: 3 }],
    });
  });

  it("a difference wide enough to lap the card gives two dots on the hardest holes", () => {
    const C = golferId("cal");
    const wideGame = { kind: "stableford", id: gameId("s3"), players: [B, C] } as const;
    // Cal at 26 against Bo's 2 is a difference of 24, halved on a nine-hole card = 12 strokes over
    // 9 holes: base floor(12/9) = 1 dot on every hole, plus extra 12%9 = 3 on SI<=3 (h2 SI1,
    // h7 SI2, h4 SI3), which get 2. Bo, the field's lowest, plays off scratch.
    // Card (pars [4,4,3,5,4,3,4,5,4]), Cal's gross [6,7,4,8,6,5,6,7,6]:
    // h1 par4 dot1 gross6 net5 pts 2+4-5=1
    // h2 par4 dot2 gross7 net5 pts 2+4-5=1
    // h3 par3 dot1 gross4 net3 pts 2+3-3=2
    // h4 par5 dot2 gross8 net6 pts 2+5-6=1   <- the lapped second dot this test pins
    // h5 par4 dot1 gross6 net5 pts 2+4-5=1
    // h6 par3 dot1 gross5 net4 pts 2+3-4=1
    // h7 par4 dot2 gross6 net4 pts 2+4-4=2
    // h8 par5 dot1 gross7 net6 pts 2+5-6=1
    // h9 par4 dot1 gross6 net5 pts 2+4-5=1
    // total points = 1+1+2+1+1+1+2+1+1 = 11 (one dot fewer on h4 would net 7 there and score
    // max(0, 2+5-7) = 0, so the lapped dot is worth exactly the point this pins).
    const rosterWithCal = [...players, { golferId: C, name: "Cal", tee: "white", courseHandicap: 26 }];
    const [state] = playGoldenRound(fixtureLinks, rosterWithCal, [wideGame], {
      [B]: [4, 4, 3, 5, 5, 3, 4, 5, 4],
      [C]: [6, 7, 4, 8, 6, 5, 6, 7, 6],
    });
    expect(state).toMatchObject({
      kind: "stableford", complete: true,
      lines: [{ golferId: B, thru: 9, points: 17 }, { golferId: C, thru: 9, points: 11 }],
    });
  });
});
