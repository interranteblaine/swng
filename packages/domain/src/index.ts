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
// scoring/allowances.js is deleted: the 95/90/100 handicap-allowance table it held is replaced by
// the ONE rule in strokeBasis.js — strokes are the difference from the lowest in the field.
export * from "./scoring/strokeBasis.js";
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
// the web-side fence below like every other barrel-exported golf computation, and deliberately NOT
// re-exported through @swng/client: the average is server-computed and served, so an on-device
// copy would be fence-legal and boundary-wrong.
export * from "./golfer/average.js";
export * from "./golfer/metrics.js";
export * from "./golfer/coursesPlayed.js";
// analytics.ts (analytics spec 2026-07-21 §3): export the types every consumer needs to name
// (GolferMetrics.bests/milestones' own member shapes) plus fullyHoledOut/grossOf — the "fully
// holed out" definition Task 4's course-record fold reuses. bestsOf/milestonesOf stay
// package-internal (metrics.ts imports them directly): nothing outside @swng/domain calls them —
// golferMetrics is the one sanctioned way to reach a bests/milestones value. hasCompleteScore/
// scoreOf (spec 2026-07-29 §2d — "does this card have a score, and what is it") stay
// package-internal for the same reason: average.ts and record.ts are their only callers.
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
