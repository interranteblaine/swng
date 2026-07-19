import { describe, expect, it } from "vitest";
import { deviceId, gameId, golferId, opId } from "../ids.js";
import type { RoundEvent } from "../round/events.js";
import { reduceRound } from "../round/state.js";
import { scoreGame } from "./game.js";
import { playGoldenRound, playGoldenRoundLog } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";

const A = golferId("ann");
const B = golferId("bo");
const C = golferId("cal");
// Full handicap (skins allowance 1.0): Ann ch8 → dots all holes but h3 (SI 9);
// Bo ch2 → h2, h7; Cal ch12 → 12 dots, all nine + extras on SI≤3 (h2, h4, h7).
const players3 = [
  { golferId: A, name: "Ann", tee: "white", courseHandicap: 8 },
  { golferId: B, name: "Bo", tee: "white", courseHandicap: 2 },
  { golferId: C, name: "Cal", tee: "white", courseHandicap: 12 },
];
const game = { kind: "skins", id: gameId("k1"), players: [A, B, C] } as const;

describe("skins — golden cards", () => {
  it("carryovers chain, outright net wins the pot, pickup is out: Ann 6, Bo 3", () => {
    // nets — Ann: 4,4,4,5,4,3,4,5,PU  Bo: 4,4,3,6,4,4,3,5,4  Cal: 5,5,3,6,5,4,4,6,5
    // h1 tie(A,B) carry→2; h2 tie(A,B) carry→3; h3 tie(B,C) carry→4; h4 Ann takes 4;
    // h5 tie(A,B) carry→2; h6 Ann takes 2; h7 Bo takes 1; h8 tie(A,B) carry→2; h9 Bo takes 2.
    const [state] = playGoldenRound(fixtureLinks, players3, [game], {
      [A]: [5, 5, 4, 6, 5, 4, 5, 6, "picked-up"],
      [B]: [4, 5, 3, 6, 4, 4, 4, 5, 4],
      [C]: [6, 7, 4, 8, 6, 5, 6, 7, 6],
    });
    // All 9 holes decided (every player had a cell every hole).
    expect(state).toMatchObject({
      kind: "skins", complete: true, carrying: 0, carriedOut: 0, holesDecided: 9,
      lines: [
        { golferId: A, skins: 6 },
        { golferId: B, skins: 3 },
        { golferId: C, skins: 0 },
      ],
    });
  });

  it("mid-round: a tie carries, and settlement stops at the first undecided hole", () => {
    // h1 Ann takes 1 (net 3 vs 4/4); h2 tie(A,B at net 4) → pot 1 rides into h3.
    // Ann has no h3 cell, so h3 is undecided and nothing after it settles — Bo's
    // would-be outright h3 win (net 3 vs Cal's 4) must NOT be paid out.
    const [state] = playGoldenRound(fixtureLinks, players3, [game], {
      [A]: [4, 5],
      [B]: [4, 5, 3],
      [C]: [6, 7, 5],
    });
    // Only h1 and h2 have every player's cell — the carry rides into h3 (holesDecided + 1).
    expect(state).toMatchObject({
      kind: "skins", complete: false, carrying: 1, carriedOut: 0, holesDecided: 2,
      lines: [
        { golferId: A, skins: 1 },
        { golferId: B, skins: 0 },
        { golferId: C, skins: 0 },
      ],
    });
  });

  it("a cleared cell re-opens the hole: settlement stops there like a gap", () => {
    // Same mid-round fixture as above (h1 Ann takes 1, h2 tie(A,B) carries into h3), then
    // Ann's h2 is cleared at a later hlc — the deck's own FixtureCorrection vocabulary has
    // no "cleared" arm (it only rewrites to a strokes/picked-up/conceded score), so the
    // clear is appended as a raw score-recorded event directly onto the deck's log.
    const log = playGoldenRoundLog(
      fixtureLinks, players3, [game],
      { [A]: [4, 5], [B]: [4, 5, 3], [C]: [6, 7, 5] },
      [], false,
    );
    const clearAnnH2: RoundEvent = {
      kind: "score-recorded", golferId: A, hole: 2, result: { kind: "cleared" },
      opId: opId("clear-ann-h2"), hlc: { wallMs: 9_999, counter: 0, deviceId: deviceId("clear-device") }, authorId: A,
    };
    const state = reduceRound([...log, clearAnnH2]);
    const [skinsState] = state.games.map((config) => scoreGame(config, state));
    // h2 is unscored again (Ann's cell reads as absent via cellAt) — only h1 (Ann's outright
    // win, no carry) is decided; the chain stops there exactly like the original gap at h3.
    expect(skinsState).toMatchObject({
      kind: "skins", holesDecided: 1, carrying: 0, carriedOut: 0,
      lines: [
        { golferId: A, skins: 1 },
        { golferId: B, skins: 0 },
        { golferId: C, skins: 0 },
      ],
    });
  });

  it("every player out of the hole carries the pot", () => {
    // h1 all picked up → the skin carries; h2 Ann takes the doubled pot (net 3 vs 4/4).
    const [state] = playGoldenRound(fixtureLinks, players3, [game], {
      [A]: ["picked-up", 4],
      [B]: ["picked-up", 5],
      [C]: ["picked-up", 6],
    });
    // h1 and h2 are both decided (a pickup is still a recorded cell); h3 has no cells.
    expect(state).toMatchObject({
      kind: "skins", complete: false, carrying: 0, carriedOut: 0, holesDecided: 2,
      lines: [
        { golferId: A, skins: 2 },
        { golferId: B, skins: 0 },
        { golferId: C, skins: 0 },
      ],
    });
  });

  it("exposes the hole-by-hole story: pots, winners, carries", () => {
    // Same card as the golden test: carries on 1–3 build the pot to 4, Ann takes it on 4;
    // fresh skin carries on 5, Ann takes 2 on 6; Bo takes 1 on 7; carry on 8, Bo takes 2 on 9.
    const [state] = playGoldenRound(fixtureLinks, players3, [game], {
      [A]: [5, 5, 4, 6, 5, 4, 5, 6, "picked-up"],
      [B]: [4, 5, 3, 6, 4, 4, 4, 5, 4],
      [C]: [6, 7, 4, 8, 6, 5, 6, 7, 6],
    });
    expect(state).toMatchObject({
      holes: [
        { hole: 1, pot: 1 },
        { hole: 2, pot: 2 },
        { hole: 3, pot: 3 },
        { hole: 4, winner: A, pot: 4 },
        { hole: 5, pot: 1 },
        { hole: 6, winner: A, pot: 2 },
        { hole: 7, winner: B, pot: 1 },
        { hole: 8, pot: 1 },
        { hole: 9, winner: B, pot: 2 },
      ],
    });
    // Carried entries have no winner at all (absent key, not undefined-valued).
    const trail = (state as Extract<typeof state, { kind: "skins" }>).holes;
    expect(Object.keys(trail[0]!)).not.toContain("winner");
    expect(trail).toHaveLength(9);
  });

  it("a tie on the last hole strands the pot as carriedOut", () => {
    // Same card as the golden test except Bo's h9 gross is 5: h9 is tie(B,C at
    // net 5) with Ann picked up, so the h8 carry plus h9's own skin strands.
    const [state] = playGoldenRound(fixtureLinks, players3, [game], {
      [A]: [5, 5, 4, 6, 5, 4, 5, 6, "picked-up"],
      [B]: [4, 5, 3, 6, 4, 4, 4, 5, 5],
      [C]: [6, 7, 4, 8, 6, 5, 6, 7, 6],
    });
    // Complete: every hole (incl. the strand-out tie on h9) is decided.
    expect(state).toMatchObject({
      kind: "skins", complete: true, carrying: 0, carriedOut: 2, holesDecided: 9,
      lines: [
        { golferId: A, skins: 6 },
        { golferId: B, skins: 1 },
        { golferId: C, skins: 0 },
      ],
    });
  });
});
