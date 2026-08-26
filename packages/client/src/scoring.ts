// The on-device golf-compute surface. The offline round must score with no signal, so the
// web runs the SAME @swng/domain golf logic on-device — but only through here, the one
// sanctioned client-side path. `foldAndScore` is the read-only cousin of RoundSession's live
// fold. The rest are re-exports of the domain round-compute the web needs; the ESLint fence in
// eslint.config.mjs forbids the web importing them straight from @swng/domain.

// Moved to @swng/domain (2026-08-24, MCP arc Phase 1): the server folds rounds too, and
// @swng/application may not import this package. Re-exported here because the web reaches
// on-device compute through @swng/client, not through @swng/domain.
export { foldAndScore, KNOWN_GAME_KINDS } from "@swng/domain";

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
//
// `playedAtMsOf` (round-played-date spec 2026-08-01 §3c/§6) is deliberately NOT re-exported here
// (round-played-date Task 7): every web read surface that needs "when was this round played"
// already holds a folded RoundState by the time it asks (useWatchRound/RoundPage/
// RoundRecordPage all read `state.playedAtMs` off foldAndScore's own result) — reduceRound
// already calls playedAtMsOf to produce that field, so reading it is a second READ of the one
// answer, not a second implementation. A re-export with zero callers is dead weight; the
// domain-compute ESLint banlist entry for `playedAtMsOf` stays regardless (eslint.config.mjs) —
// that fence bans a future direct-from-@swng/domain leak independently of whether this file ever
// re-exports the name.
// `intendedHoles` (spec 2026-08-02 §3c) is the round's own hole list — which holes it set out to
// play, off a given tee. The grid and the results headline both need it to draw and total the right
// holes; it is golf compute, so it comes through here and is banned from direct import below.
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
  intendedHoles,
} from "@swng/domain";
