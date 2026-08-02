import { describe, expect, it } from "vitest";
import { deviceId, gameId, golferId, opId, roundId } from "../ids.js";
import type { Hlc } from "../round/hlc.js";
import type { Participant } from "../round/participant.js";
import type { RoundEvent } from "../round/events.js";
import { reduceRound } from "../round/state.js";
import { scoreGame } from "./game.js";
import { playGoldenRound } from "./golden/deck.js";
import { fixtureLinks, fixtureLinks18 } from "./golden/fixtureCourse.js";
import { sortedStablefordLines } from "./stableford.js";
import type { StablefordLine } from "./game.js";

const A = golferId("ann");
const B = golferId("bo");
const players: readonly Participant[] = [
  { golferId: A, name: "Ann", tee: "white", strokes: 3 },
  { golferId: B, name: "Bo", tee: "white", strokes: 0 },
];
const game = { kind: "stableford", id: gameId("s1"), players: [A, B] } as const;

describe("stableford — golden cards", () => {
  it("standard points with a pickup scoring zero: Ann 10, Bo 17", () => {
    // Stableford is a MEDAL kind, so each player takes their own roster number (spec 2026-07-30
    // §3): Bo is on 0 — net === gross — and Ann's 3 dots land on SI 1..3 (holes 2, 4, 7).
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
    // Same strokes (so identical dots) and identical scores guarantee a tie without
    // hand-computing net/points arithmetic for two different numbers.
    const D = golferId("dee");
    const E = golferId("eve");
    const equalHandicapPlayers: readonly Participant[] = [
      { golferId: D, name: "Dee", tee: "white", strokes: 0 },
      { golferId: E, name: "Eve", tee: "white", strokes: 0 },
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
    // Ann's 3 strokes land on SI 1..3 (holes 2, 7, 4); she plays h1 (SI 5) and h3 (SI 9), so
    // neither of the holes under test carries a dot. She leaves h2 with no cell at all.
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
    // Cal's 12 strokes over 9 holes: base floor(12/9) = 1 dot on every hole, plus extra 12%9 = 3
    // on SI<=3 (h2 SI1, h7 SI2, h4 SI3), which get 2. Bo is on 0 and plays off scratch.
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
    const rosterWithCal: readonly Participant[] = [...players, { golferId: C, name: "Cal", tee: "white", strokes: 12 }];
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

// Extracted from GamePanel.tsx (the web) in task-5's fix round (spec 2026-07-30 §10 review) so
// there is exactly one implementation, called through @swng/client.
describe("sortedStablefordLines", () => {
  const line = (id: string, points: number): StablefordLine => ({ golferId: golferId(id), thru: 9, points });

  it("sorts points descending — the highest score leads", () => {
    const sorted = sortedStablefordLines([line("a", 20), line("b", 35), line("c", 28)]);
    expect(sorted.map((l) => l.golferId)).toEqual([golferId("b"), golferId("c"), golferId("a")]);
  });

  it("does not mutate its input array", () => {
    const lines = [line("a", 20), line("b", 35)];
    sortedStablefordLines(lines);
    expect(lines.map((l) => l.golferId)).toEqual([golferId("a"), golferId("b")]);
  });
});

// Whole-branch review Finding 5: reverting ONLY the loop's hole source in scoreStableford — from
// `playerTeeSet`'s round-scoped `holes` back to the tee set's own full `.holes` — while leaving
// `gameStrokeAllocation(..., state.holes)` correctly scoped, leaves every OTHER test in this file
// green (they never narrow a round after scoring, so no cell ever sits outside the selection).
// Task 8 (spec 2026-08-02 §3b) made that combination user-reachable: switching "all" → "front"
// keeps holes 10-18's already-recorded scores by design (fold-time scoring is never destructive —
// state.ts), so a narrowed round can carry real cells the round no longer intends. Under the
// revert, those out-of-selection cells still get walked, `gameStrokeAllocation`'s map has no entry
// for them (it's scoped to the front nine), and `dots?.get(hole.number) ?? 0` silently reads that
// as "no stroke on this hole" rather than "not this round's hole" — so they get COUNTED instead of
// excluded.
describe("scoreStableford — a round narrowed after scoring (whole-branch review Finding 5)", () => {
  it("counts only the front nine after all 18 are scored and the round narrows to front", () => {
    const at = (wallMs: number): Hlc => ({ wallMs, counter: 0, deviceId: deviceId("d1") });
    let op = 0;
    const base = (wallMs: number) => ({ opId: opId(`op-narrow-sf-${op++}`), hlc: at(wallMs), authorId: A });
    const events: RoundEvent[] = [
      { ...base(1), kind: "round-created", roundId: roundId("r-narrow-sf"), card: fixtureLinks18, playedAtMs: 1 },
      { ...base(2), kind: "participant-joined", participant: { golferId: A, name: "Ann", tee: "white", strokes: 0 } },
      { ...base(3), kind: "round-started" },
      { ...base(4), kind: "game-added", config: { kind: "stableford", id: gameId("s-narrow"), players: [A] } },
    ];
    // Scratch strokes (0) means net === gross everywhere, so scoring exactly at par is worth
    // exactly 2 + par - par = 2 points on EVERY hole, front or back — which makes the front-nine
    // vs. whole-card totals cleanly distinguishable: 9 holes -> 18 points, 18 holes -> 36 points.
    for (const hole of fixtureLinks18.teeSets[0]!.holes) {
      events.push({ ...base(10 + hole.number), kind: "score-recorded", golferId: A, hole: hole.number, result: { kind: "strokes", strokes: hole.par } });
    }
    // Narrow to front AFTER all 18 are already scored — holes 10-18 keep their cells, just outside
    // the round's current selection.
    events.push({ ...base(100), kind: "round-holes-set", holes: "front" });

    const state = reduceRound(events);
    const line = (scoreGame(state.games[0]!, state) as { lines: readonly { golferId: string; thru: number; points: number }[] }).lines[0]!;
    // Correct: only the front nine's 9 cells count. Under the reverted loop source, this would be
    // thru: 18, points: 36 — every back-nine cell counted too.
    expect(line.thru).toBe(9);
    expect(line.points).toBe(18);
  });
});
