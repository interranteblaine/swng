import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { gameId, golferId } from "../ids.js";
import { playGoldenRound } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";
import type { GameState } from "./game.js";

const A = golferId("ann");
const B = golferId("bo");
const players = [
  { golferId: A, name: "Ann", tee: "white", courseHandicap: 8 },
  { golferId: B, name: "Bo", tee: "white", courseHandicap: 2 },
];

const grossGame = { kind: "stroke-play", id: gameId("g1"), scoring: "gross", players: [A, B] } as const;
const netGame = { kind: "stroke-play", id: gameId("g2"), scoring: "net", players: [A, B] } as const;

describe("stroke play — golden cards", () => {
  it("gross: Ann 39, Bo 41, complete", () => {
    const [state] = playGoldenRound(fixtureLinks, players, [grossGame], {
      [A]: [4, 5, 3, 6, 4, 3, 5, 5, 4],
      [B]: [5, 4, 4, 5, 4, 4, 4, 6, 5],
    });
    expect(state).toMatchObject({
      kind: "stroke-play", complete: true,
      lines: [
        { golferId: A, thru: 9, gross: { total: 39, pickups: 0 } },
        { golferId: B, thru: 9, gross: { total: 41, pickups: 0 } },
      ],
    });
  });

  it("net with dots and a pickup: Ann nets 39 via net double bogey, Bo nets 35", () => {
    // Playing handicaps at 95%: Ann 8 → 8 dots (every hole but SI 9), Bo 2 → dots on SI 1,2.
    // Ann picks up on hole 4 (par 5, 1 dot): counts par+2 = 7 net.
    const [state] = playGoldenRound(fixtureLinks, players, [netGame], {
      [A]: [5, 6, 3, "picked-up", 5, 4, 5, 6, 5],
      [B]: [4, 4, 3, 5, 5, 3, 4, 5, 4],
    });
    expect(state).toMatchObject({
      kind: "stroke-play", complete: true,
      lines: [
        { golferId: A, thru: 9, gross: { total: 39, pickups: 1 }, net: { total: 39, pickups: 0 } },
        { golferId: B, thru: 9, gross: { total: 37, pickups: 0 }, net: { total: 35, pickups: 0 } },
      ],
    });
  });

  it("mid-round: totals run over decided holes only, complete=false", () => {
    const [state] = playGoldenRound(fixtureLinks, players, [grossGame], {
      [A]: [4, 5, 3],
      [B]: [5, 4],
    });
    const lines = (state as GameState & { kind: "stroke-play" }).lines;
    expect(lines[0]).toMatchObject({ thru: 3, gross: { total: 12, pickups: 0 } });
    expect(lines[1]).toMatchObject({ thru: 2, gross: { total: 9, pickups: 0 } });
    expect((state as { complete: boolean }).complete).toBe(false);
  });
});

describe("stroke play — properties", () => {
  it("net never exceeds gross for non-negative handicaps with full cards", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 9, maxLength: 9 }),
        fc.integer({ min: 0, max: 18 }),
        (strokes, courseHandicap) => {
          const P = golferId("p");
          const [state] = playGoldenRound(
            fixtureLinks,
            [{ golferId: P, name: "P", tee: "white", courseHandicap }],
            [{ kind: "stroke-play", id: gameId("g"), scoring: "net", players: [P] }],
            { [P]: strokes },
          );
          const line = (state as GameState & { kind: "stroke-play" }).lines[0]!;
          expect(line.net!.total).toBeLessThanOrEqual(line.gross.total);
        },
      ),
    );
  });
});
