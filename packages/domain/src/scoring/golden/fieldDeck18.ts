import type { GolferId } from "../../ids.js";
import { gameId, golferId } from "../../ids.js";
import type { Participant } from "../../round/participant.js";
import type { GameConfig } from "../game.js";
import type { FixtureCorrection, FixtureScores } from "./deck.js";

// The M5 field deck: the golden data AND the expected results for one 18-hole
// round on fixtureLinks18 — a fourball match (Ann+Bo vs Cal+Dee, default 90%
// allowance) and skins (all four, default full allowance) over the same log.
// It lives in the domain package so the golden test (fieldDeck18.test.ts) and
// the M5 Playwright UI gate consume one source instead of each hand-copying a
// scorecard; every expected number was hand-verified in the implementation plan
// and is pinned against the real engines by the test.
const ann = golferId("ann");
const bo = golferId("bo");
const cal = golferId("cal");
const dee = golferId("dee");

const players: readonly Participant[] = [
  { golferId: ann, name: "Ann", tee: "white", courseHandicap: 8 },
  { golferId: bo, name: "Bo", tee: "white", courseHandicap: 2 },
  { golferId: cal, name: "Cal", tee: "white", courseHandicap: 15 },
  { golferId: dee, name: "Dee", tee: "white", courseHandicap: 5 },
];

const fourball: Extract<GameConfig, { kind: "fourball-match" }> = {
  kind: "fourball-match",
  id: gameId("field-fourball"),
  a: [ann, bo],
  b: [cal, dee],
};

const skins: Extract<GameConfig, { kind: "skins" }> = {
  kind: "skins",
  id: gameId("field-skins"),
  players: [ann, bo, cal, dee],
};

// The card AS ENTERED: Cal's h9 starts at the mis-tapped 4 — the correction
// below rewrites it to 5 (a later score-recorded event that wins by hlc), so
// replaying scores+corrections reproduces the true entry history, not just the
// final card. Ann's h17 is a first-class picked-up, not a gap.
const scores: FixtureScores = {
  [ann]: [5, 5, 3, 6, 4, 4, 5, 6, 5, 5, 3, 7, 5, 4, 6, 3, "picked-up", 5],
  [bo]: [4, 4, 3, 5, 4, 3, 5, 5, 4, 5, 3, 6, 4, 5, 5, 4, 4, 4],
  [cal]: [6, 6, 4, 7, 5, 4, 6, 6, 4, 6, 4, 7, 5, 5, 7, 3, 5, 6],
  [dee]: [4, 5, 3, 5, 5, 3, 5, 6, 4, 4, 4, 6, 5, 4, 6, 4, 5, 4],
};

const corrections: readonly FixtureCorrection[] = [{ golfer: cal, hole: 9, score: 5 }];

// By thru-16 the skins lines already read final — Bo's h15 win was the last
// pot paid; only the h16 skin is still riding — so one lines constant serves
// both snapshots.
const finalSkinsLines = [
  { golferId: ann, skins: 0 },
  { golferId: bo, skins: 7 },
  { golferId: cal, skins: 0 },
  { golferId: dee, skins: 8 },
] as const;

const expected = {
  // Fourball playing handicaps roundHalfUp(ch×0.9): dots relative to Bo's low
  // put Ann on SI 1–5, Cal on SI 1–12, Dee on SI 1–3. Skins plays full
  // handicap, so its dots follow the course handicaps directly.
  playingHandicaps: {
    fourball: { [ann]: 7, [bo]: 2, [cal]: 14, [dee]: 5 } as Readonly<Record<GolferId, number>>,
    skins: { [ann]: 8, [bo]: 2, [cal]: 15, [dee]: 5 } as Readonly<Record<GolferId, number>>,
  },
  fourballFinal: {
    kind: "fourball-match",
    id: fourball.id,
    up: 2,
    leader: "a",
    thru: 17,
    remaining: 1,
    dormie: false,
    outcome: { winner: "a", closing: "2&1" },
  },
  fourballThru16: { kind: "fourball-match", id: fourball.id, up: 2, leader: "a", thru: 16, remaining: 2, dormie: true },
  skinsFinal: { kind: "skins", id: skins.id, lines: finalSkinsLines, carrying: 0, carriedOut: 3, complete: true },
  skinsThru16: { kind: "skins", id: skins.id, lines: finalSkinsLines, carrying: 1, carriedOut: 0, complete: false },
  // With the correction withheld, Cal's net 3 at h9 takes the pot that h5–h8
  // carried — the transient standing the h9 correction later hands to Dee at h10.
  skinsPreCorrectionThru9: {
    kind: "skins",
    id: skins.id,
    lines: [
      { golferId: ann, skins: 0 },
      { golferId: bo, skins: 2 },
      { golferId: cal, skins: 5 },
      { golferId: dee, skins: 2 },
    ],
    carrying: 0,
    carriedOut: 0,
    complete: false,
  },
} as const;

export const fieldDeck18 = { players, fourball, skins, scores, corrections, expected } as const;
