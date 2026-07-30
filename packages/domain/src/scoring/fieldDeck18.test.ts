import { describe, expect, it } from "vitest";
import { gameStrokeAllocation, totalDots } from "./allocation.js";
import type { FixtureScores } from "./golden/deck.js";
import { playGoldenRound, playGoldenRoundLog } from "./golden/deck.js";
import { fieldDeck18 } from "./golden/fieldDeck18.js";
import { fixtureLinks18 } from "./golden/fixtureCourse.js";
import { reduceRound } from "../round/state.js";

// The M5 field deck: one 18-hole round, fourball match + net skins over the same log.
// Every number pinned here was hand-verified in the implementation plan (h13
// engine-adjudicated 2026-07-09; re-derived by hand 2026-07-29 for the one-stroke-rule
// change) and doubles as the oracle for the M5 UI gate — the Playwright spec consumes
// the same fieldDeck18 export.
const { players, fourball, skins, scores, corrections, expected } = fieldDeck18;
const [ann, bo, cal, dee] = players.map((p) => p.golferId);

// A mid-round snapshot is the same deck cut off after hole n — corrections are
// passed separately so the pre-correction snapshots can leave them off.
const thru = (n: number): FixtureScores =>
  Object.fromEntries(Object.entries(scores).map(([golfer, holes]) => [golfer, holes.slice(0, n)]));

describe("M5 field deck — 18-hole fourball + skins golden card", () => {
  it("strokes: the deck's own typed numbers — 6/0/13/3 — reach both games and the card", () => {
    // Read straight off the roster, not derived: strokes are asserted (spec 2026-07-30 §2). Every
    // dot on the UI card comes off these numbers.
    for (const player of players) expect(player.strokes).toBe(expected.strokes[player.golferId]);
    // Both games allocate exactly that, though by DIFFERENT rules: skins is medal (each player's
    // own number) and the fourball is relative (the difference from the lowest of the four) — and
    // Bo is on 0, so the two coincide on this deck. A four-ball whose lowest member were above 0
    // would legitimately differ from skins, which is why the two arms are pinned apart in
    // allocation.test.ts rather than here.
    const roster = reduceRound(playGoldenRoundLog(fixtureLinks18, players, [fourball, skins], scores, corrections)).participants;
    for (const game of [fourball, skins]) {
      const allocation = gameStrokeAllocation(game, roster, fixtureLinks18);
      for (const { golferId } of players) expect(totalDots(allocation.get(golferId)!)).toBe(expected.strokes[golferId]);
    }
    // The card's own dots come from the SAME numbers, because the fold seats what the log asserts.
    for (const entry of roster) expect(entry.strokes).toBe(expected.strokes[entry.golferId]);
  });

  it("final card: fourball closes 1 up on the last hole; skins pay 0/5/0/10 with 3 carried out", () => {
    // B-side wins h10 (Dee's SI-2 dot nets him 3); A-side wins h11 and h15; every other hole
    // halves — including h17, where Ann picks up and Bo's 4 matches Cal's dotted 4 — so the match
    // is still live at the 18th and closes 1 up rather than early.
    const [fourballState, skinsState] = playGoldenRound(fixtureLinks18, players, [fourball, skins], scores, corrections);
    expect(fourballState).toMatchObject(expected.fourballFinal);
    expect(skinsState).toMatchObject(expected.skinsFinal);
  });

  it("thru 16: A-side 1 up with no outcome yet; the h16 skin rides into 17", () => {
    const [fourballState, skinsState] = playGoldenRound(fixtureLinks18, players, [fourball, skins], thru(16), corrections);
    expect(fourballState).toMatchObject(expected.fourballThru16);
    // 1 up with 2 to play is not decided — an outcome here would mean the ladder
    // closed the match a hole early.
    expect(fourballState).not.toHaveProperty("outcome");
    expect(skinsState).toMatchObject(expected.skinsThru16);
  });

  it("pre-correction thru 9: Cal's as-entered h9 4 (net 3) wins the 9-skin pot", () => {
    // Same deck, corrections withheld — the transient standing the correction
    // later rewrites. Only skins is pinned pre-correction: the fourball also
    // transiently gives B h9, but the gate never shows that standing.
    const [skinsState] = playGoldenRound(fixtureLinks18, players, [skins], thru(9));
    expect(skinsState).toMatchObject(expected.skinsPreCorrectionThru9);
  });

  it("the pot ledger: 10+5 paid plus 3 carried out accounts for all 18 skins", () => {
    // h1–h9 all tie (the corrected h9 makes it a three-way net-4 tie, so nothing is paid on the
    // front nine at all) → Dee takes the swollen 10 at h10; h11–h14 carry → Bo takes 5 at h15;
    // h16–h18 tie out, stranding 3 (pinned as carriedOut above).
    const ledger = [
      { holes: 2, boSkins: 0, deeSkins: 0, carrying: 2 },
      { holes: 4, boSkins: 0, deeSkins: 0, carrying: 4 },
      { holes: 9, boSkins: 0, deeSkins: 0, carrying: 9 },
      { holes: 10, boSkins: 0, deeSkins: 10, carrying: 0 },
      { holes: 15, boSkins: 5, deeSkins: 10, carrying: 0 },
    ];
    for (const { holes, boSkins, deeSkins, carrying } of ledger) {
      const [skinsState] = playGoldenRound(fixtureLinks18, players, [skins], thru(holes), corrections);
      expect(skinsState).toMatchObject({
        lines: [
          { golferId: ann, skins: 0 },
          { golferId: bo, skins: boSkins },
          { golferId: cal, skins: 0 },
          { golferId: dee, skins: deeSkins },
        ],
        carrying,
      });
    }
  });
});
