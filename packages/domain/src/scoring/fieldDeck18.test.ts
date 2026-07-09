import { describe, expect, it } from "vitest";
import { defaultAllowance, playingHandicap } from "./allowances.js";
import type { FixtureScores } from "./golden/deck.js";
import { playGoldenRound } from "./golden/deck.js";
import { fieldDeck18 } from "./golden/fieldDeck18.js";
import { fixtureLinks18 } from "./golden/fixtureCourse.js";

// The M5 field deck: one 18-hole round, fourball match + skins over the same log.
// Every number pinned here was hand-verified in the implementation plan (h13
// engine-adjudicated 2026-07-09) and doubles as the oracle for the M5 UI gate —
// the Playwright spec consumes the same fieldDeck18 export.
const { players, fourball, skins, scores, corrections, expected } = fieldDeck18;
const [ann, bo, cal, dee] = players.map((p) => p.golferId);

// A mid-round snapshot is the same deck cut off after hole n — corrections are
// passed separately so the pre-correction snapshots can leave them off.
const thru = (n: number): FixtureScores =>
  Object.fromEntries(Object.entries(scores).map(([golfer, holes]) => [golfer, holes.slice(0, n)]));

describe("M5 field deck — 18-hole fourball + skins golden card", () => {
  it("playing handicaps: fourball 90% gives 7/2/14/5, skins 100% gives 8/2/15/5", () => {
    // The allowance math is load-bearing for every dot on the UI card: fourball
    // dots are relative to Bo's 2, skins dots are the full playing handicap.
    for (const { golferId, courseHandicap } of players) {
      expect(playingHandicap(courseHandicap, defaultAllowance("fourball-match"))).toBe(expected.playingHandicaps.fourball[golferId]);
      expect(playingHandicap(courseHandicap, defaultAllowance("skins"))).toBe(expected.playingHandicaps.skins[golferId]);
    }
  });

  it("final card: fourball closes 2&1 thru 17; skins pay 0/7/0/8 with 3 carried out", () => {
    // A-side wins h5, h11, h15; B-side wins h10; everything else halves — h13
    // only because Cal's SI-4 dot nets him 4 against Bo's gross 4, and h17 via
    // Bo's net 4 against Cal's net 4 after Ann picked up.
    const [fourballState, skinsState] = playGoldenRound(fixtureLinks18, players, [fourball, skins], scores, corrections);
    expect(fourballState).toMatchObject(expected.fourballFinal);
    expect(skinsState).toMatchObject(expected.skinsFinal);
  });

  it("thru 16: A-side dormie at 2 up with no outcome yet; the h16 skin rides into 17", () => {
    const [fourballState, skinsState] = playGoldenRound(fixtureLinks18, players, [fourball, skins], thru(16), corrections);
    expect(fourballState).toMatchObject(expected.fourballThru16);
    // Dormie is exactly not-decided-yet — an outcome here would mean the ladder
    // closed the match a hole early.
    expect(fourballState).not.toHaveProperty("outcome");
    expect(skinsState).toMatchObject(expected.skinsThru16);
  });

  it("pre-correction thru 9: Cal's as-entered h9 4 (net 3) wins the 5-skin pot", () => {
    // Same deck, corrections withheld — the transient standing the correction
    // later rewrites. Only skins is pinned pre-correction: the fourball also
    // transiently gives B h9, but the gate never shows that standing.
    const [skinsState] = playGoldenRound(fixtureLinks18, players, [skins], thru(9));
    expect(skinsState).toMatchObject(expected.skinsPreCorrectionThru9);
  });

  it("the pot ledger: 2+2+6+5 paid plus 3 carried out accounts for all 18 skins", () => {
    // h1 carry → Bo takes 2 at h2; h3 carry → Dee takes 2 at h4; h5–h9 all tie
    // (the corrected h9 makes it a three-way net-4 tie, so the pot Cal briefly
    // held rides on) → Dee takes the swollen 6 at h10; h11–h14 carry → Bo takes
    // 5 at h15; h16–h18 tie out, stranding 3 (pinned as carriedOut above).
    const ledger = [
      { holes: 2, boSkins: 2, deeSkins: 0, carrying: 0 },
      { holes: 4, boSkins: 2, deeSkins: 2, carrying: 0 },
      { holes: 9, boSkins: 2, deeSkins: 2, carrying: 5 },
      { holes: 10, boSkins: 2, deeSkins: 8, carrying: 0 },
      { holes: 15, boSkins: 7, deeSkins: 8, carrying: 0 },
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
