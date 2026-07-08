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
  it("standard points with a pickup scoring zero: Ann 15, Bo 19", () => {
    // Ann (8 dots, all but SI9/h3): nets 4,5,3,PU,4,3,4,5,4 → pts 2,1,2,0,2,2,2,2,2 = 15
    // Bo (dots h2,h7): nets 4,3,3,5,5,3,3,5,4 → pts 2,3,2,2,1,2,3,2,2 = 19
    const [state] = playGoldenRound(fixtureLinks, players, [game], {
      [A]: [5, 6, 3, "picked-up", 5, 4, 5, 6, 5],
      [B]: [4, 4, 3, 5, 5, 3, 4, 5, 4],
    });
    expect(state).toMatchObject({
      kind: "stableford", complete: true,
      lines: [
        { golferId: A, thru: 9, points: 15 },
        { golferId: B, thru: 9, points: 19 },
      ],
    });
  });

  it("mid-round points run over decided holes only", () => {
    const [state] = playGoldenRound(fixtureLinks, players, [game], { [A]: [5, 6], [B]: [4] });
    expect(state).toMatchObject({
      complete: false,
      lines: [{ golferId: A, thru: 2, points: 3 }, { golferId: B, thru: 1, points: 2 }],
    });
  });

  it("counts decided holes anywhere on the card, not just a dense prefix: a mid-card gap still totals across it", () => {
    // Medal-family engines (unlike match play's sequential decided-prefix) resolve a
    // hole wherever its cell exists — scoreStableford's loop `continue`s past a
    // missing cell instead of breaking, so a gap doesn't stop later holes counting.
    const soloGame = { kind: "stableford", id: gameId("s2"), players: [A] } as const;
    // Ann (ch 8, 0.95 default allowance -> playingHcp roundHalfUp(8*0.95)=8, dots on
    // every hole except h3/SI9) plays h1 and h3 but leaves h2 with no cell at all.
    // h1: par4, dot -> net 5-1=4, pts 2+4-4=2
    // h2: no cell recorded — not counted in thru or points
    // h3: par3, SI9, no dot -> net 3-0=3, pts 2+3-3=2
    // thru = 2 (both decided holes, despite the gap at h2); points = 2+2 = 4
    const [state] = playGoldenRound(fixtureLinks, players, [soloGame], { [A]: [5, null, 3] });
    expect(state).toMatchObject({
      kind: "stableford", complete: false,
      lines: [{ golferId: A, thru: 2, points: 4 }],
    });
  });

  it("a non-default allowance override changes the playing handicap and thus the dots: allowance 1 gives Cal (ch 12) an extra dot on h4 that the 0.95 default doesn't", () => {
    const C = golferId("cal");
    const fullAllowanceGame = { kind: "stableford", id: gameId("s3"), players: [C], allowance: 1 } as const;
    // Cal ch12 @ allowance 1.0 -> playingHcp roundHalfUp(12*1)=12. dots = allocateStrokes(12, teeSet):
    // base=floor(12/9)=1 on every hole, extra=12%9=3 on strokeIndex<=3 (h2 SI1, h7 SI2, h4 SI3)
    // -> those three holes get 2 dots, the rest get 1 (12 total dots).
    // (At the 0.95 default used elsewhere in this file/archive.test.ts, playingHcp would
    // instead be roundHalfUp(12*0.95)=11: base 1 everywhere + extra only on h2,h7 = 11 total
    // dots — the second dot on h4 exists ONLY at allowance 1.0.)
    // Card (pars [4,4,3,5,4,3,4,5,4]), gross [6,7,4,8,6,5,6,7,6]:
    // h1 par4 dot1 gross6 net5 pts 2+4-5=1
    // h2 par4 dot2 gross7 net5 pts 2+4-5=1
    // h3 par3 dot1 gross4 net3 pts 2+3-3=2
    // h4 par5 dot2 gross8 net6 pts 2+5-6=1   <- the extra dot this test pins
    // h5 par4 dot1 gross6 net5 pts 2+4-5=1
    // h6 par3 dot1 gross5 net4 pts 2+3-4=1
    // h7 par4 dot2 gross6 net4 pts 2+4-4=2
    // h8 par5 dot1 gross7 net6 pts 2+5-6=1
    // h9 par4 dot1 gross6 net5 pts 2+4-5=1
    // total points = 1+1+2+1+1+1+2+1+1 = 11 (at the 0.95 default, h4 nets 8-1=7 -> pts
    // max(0,2+5-7)=0, one point lower, totaling 10 — the value archive.test.ts's
    // concurrency deck pins for this same Cal card at the default allowance).
    const rosterWithCal = [...players, { golferId: C, name: "Cal", tee: "white", courseHandicap: 12 }];
    const [state] = playGoldenRound(fixtureLinks, rosterWithCal, [fullAllowanceGame], {
      [C]: [6, 7, 4, 8, 6, 5, 6, 7, 6],
    });
    expect(state).toMatchObject({
      kind: "stableford", complete: true,
      lines: [{ golferId: C, thru: 9, points: 11 }],
    });
  });
});
