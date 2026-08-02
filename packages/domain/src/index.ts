export * from "./ids.js";
export * from "./errors.js";
export * from "./course/card.js";
export * from "./course/course.js";
export * from "./round/hlc.js";
export * from "./round/participant.js";
export * from "./round/holeResult.js";
export * from "./round/events.js";
export * from "./round/state.js";
export * from "./round/playedAt.js";
export * from "./round/archive.js";
export { hasHoleChoice, intendedHoles } from "./round/holes.js";
export type { HoleSelection } from "./round/holes.js";
export * from "./scoring/strokes.js";
// scoring/allowances.js and scoring/strokeBasis.js are both deleted: the 95/90/100 allowance
// table and the StrokeBasis/resolveStrokes/anchorOf derivation that replaced it are gone with the
// whole idea that anything computes a player's strokes (spec 2026-07-30 §9). A player's strokes
// are one asserted integer on the roster; allocation.js only spreads them over holes.
export * from "./scoring/allocation.js";
export * from "./scoring/strokePlay.js";
export * from "./scoring/matchLadder.js";
export * from "./scoring/singlesMatch.js";
export * from "./scoring/stableford.js";
export * from "./scoring/fourballMatch.js";
export * from "./scoring/skins.js";
export * from "./scoring/result.js";
export * from "./scoring/present.js";
export * from "./scoring/golden/fixtureCourse.js";
export * from "./scoring/golden/deck.js";
export * from "./scoring/golden/fieldDeck18.js";
// handicap/ is deleted in its entirety (spec 2026-07-29 §7): whs.ts's adjusted gross score, score
// differentials, the Rule 5.2a table, the 9-hole pairing and the course-handicap conversions, and
// present.ts's formatHandicapIndex/formatCourseHandicap/strokeGrant/indexSourcePhrase — every one
// of which existed to render a NEGATIVE stroke count, which `strokes` can no longer be. The one
// signed-number renderer left is `formatOverPar` in scoring/present.js, exported above.
export * from "./golfer/golfer.js";
export * from "./golfer/placeholderName.js";
export * from "./golfer/record.js";
// golfer/average.ts (spec 2026-07-29 §2c/§5): what you normally shoot relative to par — the fold
// the record and the crew board both read, plus AveragePoint for the profile's chart. Banned onto
// the web-side fence below like every other barrel-exported golf computation. Every member here is
// deliberately NOT re-exported through @swng/client except one: `nineHoleContribution` (task 5) —
// the average itself is server-computed and served, so an on-device copy of THAT fold would be
// fence-legal and boundary-wrong, but the doubling rule alone is a small pure fact the web still
// needs to render a history row's "counts +32" line over already-served score/par fields; it's
// re-exported so that rendering doesn't re-derive `* 2` inline.
export * from "./golfer/average.js";
export * from "./golfer/metrics.js";
export * from "./golfer/coursesPlayed.js";
// analytics.ts (analytics spec 2026-07-21 §3): export the types every consumer needs to name
// (GolferMetrics.bests/milestones' own member shapes). bestsOf/milestonesOf stay
// package-internal (metrics.ts imports them directly): nothing outside @swng/domain calls them —
// golferMetrics is the one sanctioned way to reach a bests/milestones value. hasCompleteScore/
// scoreOf ("does this card have a score, and what is it" — task-1, spec §7, which also deleted
// the separate fullyHoledOut/grossOf pair this file used to export: once a gimme is just a
// `strokes` cell, "has a number" and "holed out" are the same question) stay package-internal
// for the same reason: average.ts, record.ts, courseRecord.ts and crew/scoreboard.ts are their
// only callers.
export type { BestRound, GolferBests, MilestoneKind, Milestone } from "./golfer/analytics.js";
// courseRecord.ts (analytics spec 2026-07-21 §4): "Your record here" — the per-course fold plus
// its CourseHoleInsight member shape. `courseRecord` itself is compute (bans onto the web-side
// fence below); the phrase formatters in present.ts are fence-ALLOWED, the handicap/present.ts
// precedent — the web renders through them, never rebuilding the sentences inline.
export type { CourseHoleInsight, CourseRecord } from "./golfer/courseRecord.js";
export { courseRecord } from "./golfer/courseRecord.js";
export * from "./golfer/present.js";
export * from "./crew/crew.js";
export * from "./crew/ledger.js";
// crew/analytics.ts (analytics spec 2026-07-21 §5): partner records / season titles — folds
// beside the existing standings, banned onto the web-side fence below like every other
// barrel-exported golf computation. (The lowest-net/most-improved season superlatives these
// once also fed are deleted whole, crew-scoreboard spec §3c.)
export * from "./crew/analytics.js";
// crew/scoreboard.ts (crew-scoreboard spec §3a/§3b): the per-member crew scoreboard fold +
// sharedRoundIds — banned onto the web-side fence below like every other barrel-exported golf
// computation.
export * from "./crew/scoreboard.js";
// crew/seasonWindow.ts: a season's chosen YYYY-MM-DD dates become the SeasonWindow the crew
// scoreboard fold above already consumes — banned onto the web-side fence below like every
// other barrel-exported golf computation.
export * from "./crew/seasonWindow.js";
// GameConfig is already re-exported via ./round/events.js (game.ts owns the
// type; events.ts re-exports it so RoundEvent's "game-added" arm has a name to
// reference) — re-export game.ts's other members individually so `export *`
// here doesn't collide on GameConfig.
export type { GameState, RunningTotal, StrokePlayLine, StablefordLine, SkinsLine, MatchOutcome, FourballOutcome, GameConfigDraft } from "./scoring/game.js";
export { gameMembers, scoreGame } from "./scoring/game.js";
