import { describe, expect, it } from "vitest";
import { deviceId, gameId, golferId, opId } from "../ids.js";
import type { RoundEvent } from "../round/events.js";
import type { Participant } from "../round/participant.js";
import { reduceRound } from "../round/state.js";
import { scoreGame } from "./game.js";
import { playGoldenRound, playGoldenRoundLog } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";
import { sortedSkinsLines } from "./skins.js";
import type { SkinsLine } from "./game.js";

const A = golferId("ann");
const B = golferId("bo");
const C = golferId("cal");
// Skins is a MEDAL kind (spec 2026-07-30 §3), so each player's own roster number is what they get:
// Bo off scratch, Ann's 3 dots on SI 1..3 (h2, h7, h4), Cal's 5 on SI 1..5 (h2, h7, h4, h8, h1).
const players3: readonly Participant[] = [
  { golferId: A, name: "Ann", tee: "white", strokes: 3 },
  { golferId: B, name: "Bo", tee: "white", strokes: 0 },
  { golferId: C, name: "Cal", tee: "white", strokes: 5 },
];
const game = { kind: "skins", id: gameId("k1"), scoring: "net", players: [A, B, C] } as const;

describe("skins — golden cards", () => {
  it("carryovers chain, outright net wins the pot, pickup is out: Ann 2, Bo 7", () => {
    // nets — Ann: 5,4,4,5,5,4,4,6,PU  Bo: 4,5,3,6,4,4,4,5,4  Cal: 5,6,4,7,6,5,5,6,6
    // h1 Bo takes 1; h2 Ann takes 1; h3 Bo takes 1; h4 Ann takes 1; h5 Bo takes 1;
    // h6 tie(A,B) carry→2; h7 tie(A,B) carry→3; h8 Bo takes 3; h9 Bo takes 1 (Ann is out).
    const [state] = playGoldenRound(fixtureLinks, players3, [game], {
      [A]: [5, 5, 4, 6, 5, 4, 5, 6, "picked-up"],
      [B]: [4, 5, 3, 6, 4, 4, 4, 5, 4],
      [C]: [6, 7, 4, 8, 6, 5, 6, 7, 6],
    });
    // All 9 holes decided (every player had a cell every hole).
    expect(state).toMatchObject({
      kind: "skins", complete: true, carrying: 0, carriedOut: 0, holesDecided: 9,
      lines: [
        { golferId: A, skins: 2 },
        { golferId: B, skins: 7 },
        { golferId: C, skins: 0 },
      ],
    });
  });

  it("gross skins contests raw scores: no dots at all, so the same card pays a different pot", () => {
    // The same three players and the same card as the golden test above, run as a GROSS pot
    // (spec §3: gross/net is a real choice on skins — a group routinely runs both over one card).
    // Every hole Ann won on net she won off a dot, so on gross she wins nothing: h2 and h4, hers
    // outright on net, both tie on gross and carry to Bo. Gross allocates nothing, by definition.
    const grossGame = { kind: "skins", id: gameId("k-gross"), scoring: "gross", players: [A, B, C] } as const;
    const [state] = playGoldenRound(fixtureLinks, players3, [grossGame], {
      [A]: [5, 5, 4, 6, 5, 4, 5, 6, "picked-up"],
      [B]: [4, 5, 3, 6, 4, 4, 4, 5, 4],
      [C]: [6, 7, 4, 8, 6, 5, 6, 7, 6],
    });
    // gross — Ann: 5,5,4,6,5,4,5,6,PU  Bo: 4,5,3,6,4,4,4,5,4  Cal: 6,7,4,8,6,5,6,7,6
    // h1 Bo 1; h2 tie(A,B) carry→2; h3 Bo takes 2; h4 tie(A,B) carry→2; h5 Bo takes 2;
    // h6 tie(A,B) carry→2; h7 Bo takes 2; h8 Bo takes 1; h9 Bo takes 1 (Ann is out).
    expect(state).toMatchObject({
      kind: "skins", scoring: "gross", complete: true, carrying: 0, carriedOut: 0, holesDecided: 9,
      lines: [
        { golferId: A, skins: 0 },
        { golferId: B, skins: 9 },
        { golferId: C, skins: 0 },
      ],
    });
  });

  it("mid-round: a tie carries into the next hole, and settlement stops at the first undecided one", () => {
    // h1 tie(A,B at net 4, Cal 5) → pot 1 carries; h2 Ann's SI-1 dot nets her 4 against Bo's 5
    // and Cal's 6, so she takes the doubled pot — the h1 carry, paid.
    // Ann has no h3 cell, so h3 is undecided and nothing after it settles — Bo's
    // would-be outright h3 win (net 3 vs Cal's 4) must NOT be paid out.
    const [state] = playGoldenRound(fixtureLinks, players3, [game], {
      [A]: [4, 5],
      [B]: [4, 5, 3],
      [C]: [6, 7, 5],
    });
    // Only h1 and h2 have every player's cell, so holesDecided stops at 2.
    expect(state).toMatchObject({
      kind: "skins", complete: false, carrying: 0, carriedOut: 0, holesDecided: 2,
      lines: [
        { golferId: A, skins: 2 },
        { golferId: B, skins: 0 },
        { golferId: C, skins: 0 },
      ],
    });
  });

  it("a cleared cell re-opens the hole: settlement stops there like a gap", () => {
    // Same mid-round fixture as above (h1 tie(A,B) carries, Ann takes the doubled pot on h2), then
    // Ann's h2 is cleared at a later hlc — the deck's own FixtureCorrection vocabulary has no
    // "cleared" arm (it only rewrites to a strokes/picked-up score), so the clear is appended as
    // a raw score-recorded event directly onto the deck's log.
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
    // h2 is unscored again (Ann's cell reads as absent via cellAt) — only h1 is decided, and its
    // tie is still riding; the chain stops there exactly like the original gap at h3, so the pot
    // Ann took on h2 is unpaid again.
    expect(skinsState).toMatchObject({
      kind: "skins", holesDecided: 1, carrying: 1, carriedOut: 0,
      lines: [
        { golferId: A, skins: 0 },
        { golferId: B, skins: 0 },
        { golferId: C, skins: 0 },
      ],
    });
  });

  it("every player out of the hole carries the pot", () => {
    // h1 all picked up → the skin carries; h2 Ann takes the doubled pot (net 3 vs 5/5 — h2 is SI 1,
    // so Ann's gross 4 and Cal's 6 each take a dot and Bo, off scratch, keeps his 5).
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
    // Same card as the golden test: Bo takes 1 on h1, Ann 1 on h2, Bo 1 on h3, Ann 1 on h4,
    // Bo 1 on h5; carries on h6–h7 build the pot to 3, which Bo takes on h8; Bo takes h9 too.
    const [state] = playGoldenRound(fixtureLinks, players3, [game], {
      [A]: [5, 5, 4, 6, 5, 4, 5, 6, "picked-up"],
      [B]: [4, 5, 3, 6, 4, 4, 4, 5, 4],
      [C]: [6, 7, 4, 8, 6, 5, 6, 7, 6],
    });
    expect(state).toMatchObject({
      holes: [
        { hole: 1, winner: B, pot: 1 },
        { hole: 2, winner: A, pot: 1 },
        { hole: 3, winner: B, pot: 1 },
        { hole: 4, winner: A, pot: 1 },
        { hole: 5, winner: B, pot: 1 },
        { hole: 6, pot: 1 },
        { hole: 7, pot: 2 },
        { hole: 8, winner: B, pot: 3 },
        { hole: 9, winner: B, pot: 1 },
      ],
    });
    // Carried entries have no winner at all (absent key, not undefined-valued) — h6 is the
    // first carry on this card.
    const trail = (state as Extract<typeof state, { kind: "skins" }>).holes;
    expect(Object.keys(trail[5]!)).not.toContain("winner");
    expect(trail).toHaveLength(9);
  });

  it("a tie on the last hole strands the pot as carriedOut", () => {
    // Same card as the golden test except Bo's AND Cal's h9 gross are both 5: h9 is tie(B,C at
    // net 5 — Cal's dots are h1/h2/h4/h7/h8, so h9 is scratch for him) with Ann picked up, so
    // h9's own skin strands with nobody to pay it to. (Bo's h9 alone is not enough under the
    // relative rule: Cal used to carry a dot on every hole at full handicap and no longer does.)
    const [state] = playGoldenRound(fixtureLinks, players3, [game], {
      [A]: [5, 5, 4, 6, 5, 4, 5, 6, "picked-up"],
      [B]: [4, 5, 3, 6, 4, 4, 4, 5, 5],
      [C]: [6, 7, 4, 8, 6, 5, 6, 7, 5],
    });
    // Complete: every hole (incl. the strand-out tie on h9) is decided.
    expect(state).toMatchObject({
      kind: "skins", complete: true, carrying: 0, carriedOut: 1, holesDecided: 9,
      lines: [
        { golferId: A, skins: 2 },
        { golferId: B, skins: 6 },
        { golferId: C, skins: 0 },
      ],
    });
  });
});

// Extracted from GamePanel.tsx (the web) in task-5's fix round (spec 2026-07-30 §10 review,
// beyond the two sites the review named — the same defect class) so there is exactly one
// implementation, called through @swng/client.
describe("sortedSkinsLines", () => {
  const line = (id: string, skins: number): SkinsLine => ({ golferId: golferId(id), skins });

  it("sorts skins won descending — the biggest winner leads", () => {
    const sorted = sortedSkinsLines([line("a", 2), line("b", 6), line("c", 0)]);
    expect(sorted.map((l) => l.golferId)).toEqual([golferId("b"), golferId("a"), golferId("c")]);
  });

  it("does not mutate its input array", () => {
    const lines = [line("a", 2), line("b", 6)];
    sortedSkinsLines(lines);
    expect(lines.map((l) => l.golferId)).toEqual([golferId("a"), golferId("b")]);
  });
});
