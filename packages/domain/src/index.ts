export * from "./ids.js";
export * from "./errors.js";
export * from "./course/card.js";
export * from "./course/course.js";
export * from "./round/hlc.js";
export * from "./round/participant.js";
export * from "./round/holeResult.js";
export * from "./round/events.js";
export * from "./round/state.js";
export * from "./round/archive.js";
export * from "./scoring/strokes.js";
export * from "./scoring/allowances.js";
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
export * from "./handicap/whs.js";
export * from "./handicap/present.js";
export * from "./golfer/golfer.js";
export * from "./golfer/placeholderName.js";
export * from "./golfer/record.js";
export * from "./golfer/metrics.js";
export * from "./golfer/coursesPlayed.js";
// analytics.ts (analytics spec 2026-07-21 §3): export the types every consumer needs to name
// (GolferMetrics.bests/milestones' own member shapes) plus fullyHoledOut/grossOf — the "fully
// holed out" definition Task 4's course-record fold reuses. bestsOf/milestonesOf stay
// package-internal (metrics.ts imports them directly): nothing outside @swng/domain calls them —
// golferMetrics is the one sanctioned way to reach a bests/milestones value.
export type { BestRound, GolferBests, MilestoneKind, Milestone } from "./golfer/analytics.js";
export { fullyHoledOut, grossOf } from "./golfer/analytics.js";
// courseRecord.ts (analytics spec 2026-07-21 §4): "Your record here" — the per-course fold plus
// its CourseHoleInsight member shape. `courseRecord` itself is compute (bans onto the web-side
// fence below); the phrase formatters in present.ts are fence-ALLOWED, the handicap/present.ts
// precedent — the web renders through them, never rebuilding the sentences inline.
export type { CourseHoleInsight, CourseRecord } from "./golfer/courseRecord.js";
export { courseRecord } from "./golfer/courseRecord.js";
export * from "./golfer/present.js";
export * from "./crew/crew.js";
export * from "./crew/ledger.js";
// GameConfig is already re-exported via ./round/events.js (game.ts owns the
// type; events.ts re-exports it so RoundEvent's "game-added" arm has a name to
// reference) — re-export game.ts's other members individually so `export *`
// here doesn't collide on GameConfig.
export type { GameState, RunningTotal, StrokePlayLine, StablefordLine, SkinsLine, MatchOutcome, FourballOutcome, GameConfigDraft } from "./scoring/game.js";
export { gameMembers, scoreGame } from "./scoring/game.js";
