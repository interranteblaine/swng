// The on-device golf-compute surface. The offline round must score with no signal, so the
// web runs the SAME @swng/domain golf logic on-device — but only through here, the one
// sanctioned client-side path. `foldAndScore` is the read-only cousin of RoundSession's live
// fold. The rest are re-exports of the domain round-compute the web needs; the ESLint fence in
// eslint.config.mjs forbids the web importing them straight from @swng/domain.

import { reduceRound, scoreGame } from "@swng/domain";
import type { GameConfig, GameState, RoundEvent, RoundState } from "@swng/domain";

// scoreGame throws on a kind it doesn't recognize (M2 lesson, carried to the client): a
// build must survive a round containing a future game kind rather than crashing games().
// Derived from the same union scoreGame switches on (scoring/game.ts) — the two lists
// must never drift, so this is the one place that names them. Written as a `satisfies
// Record<GameConfig["kind"], true>` object rather than a plain string array so that a
// future domain change extending the `GameConfig["kind"]` union fails THIS build (a
// missing key) instead of silently vanishing from games() — a new game kind arriving on
// the wire would otherwise just be dropped by the KNOWN_GAME_KINDS filter with no compiler
// signal that this list needs updating.
const KNOWN_GAME_KINDS_BY_KIND = {
  "stroke-play": true,
  "singles-match": true,
  stableford: true,
  "fourball-match": true,
  skins: true,
} satisfies Record<GameConfig["kind"], true>;

// The ONE known-game-kinds list this build scores. RoundSession's live games() filter reads it,
// foldAndScore below reads it, and the web's read-only round screens (WatchPage,
// ArchivedRoundPage) fold through foldAndScore rather than re-declaring their own copy — so a
// future game kind is added in exactly one place, not three.
export const KNOWN_GAME_KINDS: ReadonlySet<GameConfig["kind"]> = new Set(Object.keys(KNOWN_GAME_KINDS_BY_KIND) as GameConfig["kind"][]);

// The read-only equivalent of RoundSession's live fold (session.ts): reduceRound over the event
// log, then scoreGame over the known-kind games — byte-identical math, no outbox, no HLC
// identity. The web's read-only round views (a spectator's WatchPage, an archived card) score a
// static log this way; the live round still goes through createRoundSession. Both paths run the
// SAME domain functions, so a rendered number is a fact of @swng/domain computed the one place,
// never re-derived per screen. reduceRound throws until a genesis (round-created) event exists
// (its own contract) — a caller that may hold a pre-genesis log guards on events.length first.
export const foldAndScore = (events: readonly RoundEvent[]): { state: RoundState; games: readonly GameState[] } => {
  const state = reduceRound(events);
  const games = state.games.filter((config) => KNOWN_GAME_KINDS.has(config.kind)).map((config) => scoreGame(config, state));
  return { state, games };
};

// The on-device round-compute the web needs, re-exported through the one sanctioned seam (the
// ESLint fence forbids the web importing these straight from @swng/domain). scoreGame/reduceRound
// are deliberately NOT re-exported — foldAndScore and RoundSession subsume every web use of them.
//
// The four handicap re-exports that stood here (handicappingFor, courseHandicapFor,
// courseHandicapFromRatingSlopePar, unratedCourseHandicap) are DELETED with handicap/whs.ts itself
// (spec 2026-07-29 §7): nothing converts an index into strokes anymore, because a player states
// the number directly. Nothing replaces them — `averageOf` and the crew board's own
// `averageOfValues`/`spreadOfValues` are deliberately NOT re-exported either: those numbers are
// server-computed and served, so an on-device copy would be fence-legal and boundary-wrong. `formatOverPar` is a presentation
// formatter the web imports straight from @swng/domain, exactly as `underPar` already does.
//
// `nineHoleContribution` (task 5) IS re-exported, unlike its average.ts neighbors above: it's the
// nine-hole-doubling rule alone (spec §2d), not the average fold, and RecordSections.tsx needs it
// to render a history row's "counts +32" line over already-served score/par fields — the fix for
// the last golf logic this arc found re-derived inline in the web (`(score - par) * 2`).
//
// `parForHoles`/`dotsForHoles` (task-5 fix round) are the static par/dots totals over a set of
// holes — ResultsView.tsx's "Par N" headline and ScorecardGrid.tsx's OUT/IN/TOT rows hand-rolled
// these sums in two places each until the review caught the duplication; one copy beside
// grossForHoles, which already owns the score half of the same segment.
//
// `sortedStrokePlayLines`/`sortedStablefordLines`/`sortedSkinsLines` (task-5 fix round, spec
// 2026-07-30 §10 review I2) replace GamePanel.tsx's three inline `.sort()` calls — a leaderboard's
// ranking order is golf logic (the stroke-play order carries an owner ruling, spec 2026-07-19
// §2b), the same class `aggregateSeason` already moved server-side for crew standings ("the web
// never re-ranks").
// `playedAtMsOf` (round-played-date spec 2026-08-01 §3c/§6): THE one rule for "when was this
// round played," re-exported so a web read surface that only holds a raw event log (no folded
// RoundState yet — e.g. a spectator's hook before its first successful pull) can still ask.
// Prefer `state.playedAtMs` wherever a folded RoundState is already on hand (reduceRound already
// calls this exact function to produce it — reading the field is not a second implementation of
// the rule, just a second READ of the one answer); this re-export is for the narrower case where
// no fold exists yet.
export {
  gameStrokeAllocation,
  roundStrokeAllocation,
  netStrokes,
  totalDots,
  dotsForHoles,
  grossForHoles,
  parForHoles,
  unresolvedGames,
  nineHoleContribution,
  sortedStrokePlayLines,
  sortedStablefordLines,
  sortedSkinsLines,
  playedAtMsOf,
} from "@swng/domain";
