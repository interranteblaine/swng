// Fixture + frozen-expectation module for crewSeason.spec.ts (M8 Task 7 — the golden season
// gate). Mirrors fieldDeck18's own idiom (packages/domain/src/scoring/golden/fieldDeck18.ts):
// the deck's hole-by-hole scores are hand-designed against the brief's own constraints, then
// verified against the REAL domain engines (playGoldenRoundLog/settleRound/crewContribution/
// aggregateSeason — no forked math) before crewSeason.spec.ts ever calls the live API. A deck
// that disagrees with FROZEN_LINE below is a design bug in THIS file, never something adjusted
// to match a live run (BLOCKED-don't-fudge, task-7-brief.md's own verbatim law).
//
// Course: 18 holes, all par 4 (par 72), one flat tee. Every player's course handicap is 0 for
// the whole season (brief) — playingHandicap(0, *) is 0 strokes on every hole regardless of
// stroke index, so net === gross everywhere and stableford points collapse to
// max(0, 2 + par - net) = max(0, 6 - gross). Same "flat tee keeps arithmetic hand-verifiable"
// reasoning as identityRecord.spec.ts's own buildIdentityCourseCard.
import type { GameConfigInput } from "@swng/contracts";
import {
  aggregateSeason,
  crewContribution,
  gameId,
  playGoldenRoundLog,
  settleRound,
} from "@swng/domain";
import type { CourseCard, GameConfig, GolferId, HeadToHeadRecord, Participant, SeasonLedgerLine } from "@swng/domain";

export const SEASON_ROUNDS = 12;
export const HOLES = 18;

export interface SeasonGolferIds {
  readonly al: GolferId;
  readonly bo: GolferId;
  readonly cy: GolferId;
  readonly dee: GolferId;
}

type Role = "al" | "bo" | "cy" | "dee";
const ROLES: readonly Role[] = ["al", "bo", "cy", "dee"];

export const roleNames: Readonly<Record<Role, string>> = { al: "Al", bo: "Bo", cy: "Cy", dee: "Dee" };

export const buildCourseCard = (courseName: string): CourseCard => ({
  courseName,
  teeSets: [
    {
      name: "member",
      rating: 72.0,
      slope: 113,
      holes: Array.from({ length: HOLES }, (_, i) => ({ number: i + 1, par: 4, yardage: 380, strokeIndex: i + 1 })),
    },
  ],
});

type Favor = "al" | "bo";

interface RoundPlan {
  // The ONLY holes among 1-17 where Al and Bo differ — the favored side pars (4), the other
  // bogeys (5); every other hole on 1-17 is a flat par for all four (which alone ties the
  // 4-way skins low every time, see this file's header comment, regardless of what Al/Bo do
  // on a `decisive` hole — Cy and Dee never move off par on 1-17).
  readonly decisive: readonly { readonly hole: number; readonly favor: Favor }[];
  // Hole 18's outright skins winner (birdies; the other three par) — rotates Al,Bo,Cy,Dee
  // across the season (brief) so each wins exactly 3 of the 12 full 18-skin pots (54 total).
  readonly hole18Winner: Role;
}

// The deck construction contract (task-7-brief.md, verbatim constraints): singles Al-Bo H2H
// 5W/5L/2H (Al wins 1-5, halved 6-7, Bo wins 8-12); skins hole 18 rotates Al,Bo,Cy,Dee,... In
// a round where Al or Bo is hole 18's own skins winner, that same birdie ALSO wins the match
// hole outright (hole18Winner birdies, the other of Al/Bo pars) — contributing +/-1 to that
// round's match margin "for free." In a round where Cy or Dee wins hole 18, Al and Bo both
// par it, so hole 18 is a halved match hole and contributes 0. `decisive` supplies whatever
// EXTRA margin (on top of that forced hole-18 contribution) is needed to land the round's own
// required category — hand-derived per round in task-7-report.md's own trace; this table is
// the freeze, not something this spec recomputes at run time.
const ROUND_PLAN: readonly RoundPlan[] = [
  { decisive: [], hole18Winner: "al" }, // R1: Al wins — hole18 alone contributes +1
  {
    decisive: [
      { hole: 1, favor: "al" },
      { hole: 2, favor: "al" },
    ],
    hole18Winner: "bo",
  }, // R2: Al wins — +2 on 1-17 overcomes hole18's -1 (Bo)
  { decisive: [{ hole: 1, favor: "al" }], hole18Winner: "cy" }, // R3: Al wins — +1 (hole18 halved, Cy wins skins)
  { decisive: [{ hole: 1, favor: "al" }], hole18Winner: "dee" }, // R4: Al wins — +1 (hole18 halved, Dee wins skins)
  { decisive: [], hole18Winner: "al" }, // R5: Al wins — hole18 alone contributes +1
  { decisive: [{ hole: 1, favor: "al" }], hole18Winner: "bo" }, // R6: halved — +1 cancels hole18's -1 (Bo)
  { decisive: [], hole18Winner: "cy" }, // R7: halved — hole18 halved, nothing else decisive
  { decisive: [{ hole: 1, favor: "bo" }], hole18Winner: "dee" }, // R8: Bo wins — -1 (hole18 halved, Dee wins skins)
  {
    decisive: [
      { hole: 1, favor: "bo" },
      { hole: 2, favor: "bo" },
    ],
    hole18Winner: "al",
  }, // R9: Bo wins — -2 overcomes hole18's +1 (Al)
  { decisive: [], hole18Winner: "bo" }, // R10: Bo wins — hole18 alone contributes -1
  { decisive: [{ hole: 1, favor: "bo" }], hole18Winner: "cy" }, // R11: Bo wins — -1 (hole18 halved, Cy wins skins)
  { decisive: [{ hole: 1, favor: "bo" }], hole18Winner: "dee" }, // R12: Bo wins — -1 (hole18 halved, Dee wins skins)
];

if (ROUND_PLAN.length !== SEASON_ROUNDS) {
  throw new Error(`ROUND_PLAN must have exactly ${SEASON_ROUNDS} entries, has ${ROUND_PLAN.length}`);
}

// Round n's (1-indexed) 18-hole gross scores for each of the four roles, keyed by the CALLER's
// real golferIds — one generator feeds both the live API calls (recordScoreDirect, one call
// per golfer per hole) and the local oracle below (computeLocalSeason), so a deck edit can
// never desync the two.
export const roundScores = (ids: SeasonGolferIds, roundNumber: number): Readonly<Record<Role, readonly number[]>> => {
  const plan = ROUND_PLAN[roundNumber - 1];
  if (!plan) throw new Error(`no ROUND_PLAN entry for round ${roundNumber}`);

  const al: number[] = [];
  const bo: number[] = [];
  for (let hole = 1; hole <= HOLES - 1; hole += 1) {
    const decisive = plan.decisive.find((d) => d.hole === hole);
    if (!decisive) {
      al.push(4);
      bo.push(4);
    } else if (decisive.favor === "al") {
      al.push(4);
      bo.push(5);
    } else {
      al.push(5);
      bo.push(4);
    }
  }
  al.push(plan.hole18Winner === "al" ? 3 : 4);
  bo.push(plan.hole18Winner === "bo" ? 3 : 4);

  const cy = Array.from({ length: HOLES }, (_, i) => (i === HOLES - 1 && plan.hole18Winner === "cy" ? 3 : 4));
  const dee = Array.from({ length: HOLES }, (_, i) => (i === HOLES - 1 && plan.hole18Winner === "dee" ? 3 : 4));

  void ids; // ids is not needed to compute the SHAPE of scores — see roundScoresByGolfer below, which keys it onto real golferIds
  return { al, bo, cy, dee };
};

// roundScores keyed onto the CALLER's real golferIds — the shape playGoldenRoundLog's own
// FixtureScores wants (golden/deck.ts) and what recordScoreDirect's own per-golfer loop reads.
export const roundScoresByGolfer = (ids: SeasonGolferIds, roundNumber: number): Readonly<Record<string, readonly number[]>> => {
  const byRole = roundScores(ids, roundNumber);
  return { [ids.al]: byRole.al, [ids.bo]: byRole.bo, [ids.cy]: byRole.cy, [ids.dee]: byRole.dee };
};

// The three standing games, wire shape (id-less — POST /rounds/{roundId}/games's own
// GameConfigInput, and the SAME shape saved as the crew's standing-game preset) — singles
// Al-Bo at allowance 1 (inconsequential here: both course handicaps are 0 all season, so the
// match-strokes diff is 0 regardless of allowance), 4-way skins (carryover is NOT a config
// knob — scoreSkins always carries a tied/undecided hole's pot forward, packages/domain/src/
// scoring/skins.ts), 4-way stableford.
export const seasonGames = (
  ids: SeasonGolferIds,
): { readonly singles: GameConfigInput; readonly skins: GameConfigInput; readonly stableford: GameConfigInput } => ({
  singles: { kind: "singles-match", a: ids.al, b: ids.bo, allowance: 1 },
  skins: { kind: "skins", players: [ids.al, ids.bo, ids.cy, ids.dee] },
  stableford: { kind: "stableford", players: [ids.al, ids.bo, ids.cy, ids.dee] },
});

const idConfigs = (ids: SeasonGolferIds): readonly GameConfig[] => [
  { id: gameId("singles"), kind: "singles-match", a: ids.al, b: ids.bo, allowance: 1 },
  { id: gameId("skins"), kind: "skins", players: [ids.al, ids.bo, ids.cy, ids.dee] },
  { id: gameId("stableford"), kind: "stableford", players: [ids.al, ids.bo, ids.cy, ids.dee] },
];

// The local oracle (brief: "verify your deck against the domain engines locally first"): plays
// all 12 rounds through the SAME playGoldenRoundLog -> settleRound -> crewContribution ->
// aggregateSeason pipeline the real server exercises, entirely in-process, no network.
// crewSeason.spec.ts's own step 1 asserts this equals frozenSeasonExpectation (below) BEFORE
// any live call — a mismatch here is a bug in ROUND_PLAN/roundScores, never something to
// adjust to match a live run.
export const computeLocalSeason = (
  ids: SeasonGolferIds,
): { readonly ledger: readonly SeasonLedgerLine[]; readonly headToHead: readonly HeadToHeadRecord[] } => {
  const card = buildCourseCard("Local Oracle Course");
  const participants: readonly Participant[] = [
    { golferId: ids.al, name: "Al", tee: "member", courseHandicap: 0 },
    { golferId: ids.bo, name: "Bo", tee: "member", courseHandicap: 0 },
    { golferId: ids.cy, name: "Cy", tee: "member", courseHandicap: 0 },
    { golferId: ids.dee, name: "Dee", tee: "member", courseHandicap: 0 },
  ];
  const games = idConfigs(ids);

  const contributions = Array.from({ length: SEASON_ROUNDS }, (_, i) => {
    const roundNumber = i + 1;
    const scores = roundScoresByGolfer(ids, roundNumber);
    const events = playGoldenRoundLog(card, participants, games, scores, [], true);
    return crewContribution(settleRound(events));
  });

  return aggregateSeason(contributions);
};

// Hand-derived per-role season totals (task-7-report.md carries the full per-round trace this
// freezes): Al/Bo both 5W-5L-2H (the singles H2H) at 430 stableford points and 54 skins each;
// Cy/Dee 0-0-0 (never in the singles match) at 435 points and 54 skins each. Skins: each role
// is hole-18's rotating winner in exactly 3 of the 12 rounds (Al: 1,5,9; Bo: 2,6,10; Cy:
// 3,7,11; Dee: 4,8,12) -> 3 x 18 = 54. Points: see the header derivation in task-7-report.md.
const FROZEN_LINE: Readonly<Record<Role, Omit<SeasonLedgerLine, "golferId" | "rounds">>> = {
  al: { wins: 5, losses: 5, halves: 2, points: 430, skins: 54 },
  bo: { wins: 5, losses: 5, halves: 2, points: 430, skins: 54 },
  cy: { wins: 0, losses: 0, halves: 0, points: 435, skins: 54 },
  dee: { wins: 0, losses: 0, halves: 0, points: 435, skins: 54 },
};

// The frozen expectation, mapped onto whichever real golferIds the live crew mints — ledger
// sorted lexicographically by golferId (aggregateSeason's own order, crew/ledger.ts) since the
// live response comes back in that same order. H2H: Al's wins (5) equal Bo's (5), so aWins/
// bWins is symmetric regardless of which of the two sorts first into "a" lexicographically —
// no ambiguity to resolve at run time.
export const frozenSeasonExpectation = (
  ids: SeasonGolferIds,
): { readonly ledger: readonly SeasonLedgerLine[]; readonly headToHead: readonly HeadToHeadRecord[] } => {
  const ledger = ROLES.map((role) => ({ golferId: ids[role], rounds: SEASON_ROUNDS, ...FROZEN_LINE[role] })).sort((a, b) =>
    a.golferId < b.golferId ? -1 : a.golferId > b.golferId ? 1 : 0,
  );
  const [a, b] = ids.al < ids.bo ? [ids.al, ids.bo] : [ids.bo, ids.al];
  const headToHead: readonly HeadToHeadRecord[] = [{ a, b, aWins: 5, bWins: 5, halves: 2 }];
  return { ledger, headToHead };
};
