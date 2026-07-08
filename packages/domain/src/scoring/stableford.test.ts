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
});
