# Analytics — Read Folds Over Sealed Rounds — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** The spec'd analytics — bests + milestones on the golfer record, "your record here"
on the course page, partner records / superlatives / all-time on the crew — as pure domain
folds computed on read, with exactly ONE storage change (`holeResults` on `GolferRoundLine`).

**Architecture:** Spec `docs/superpowers/specs/2026-07-21-analytics-read-folds-design.md`
(binding — read §1–§5 before any task). Snapshot is the only truth; the golfer's per-round
row is the one cache, written by the ONE projector and rebuilt by the existing rebuild; the
crew folds counted snapshots at read; the web renders served numbers and computes nothing.

**Tech Stack:** Existing monorepo — @swng/domain (pure TS + Vitest), @swng/contracts (Zod),
@swng/application (ports + use cases), @swng/lambda (declarative dispatcher), apps/infra-cdk,
@swng/web (React 19 + Tailwind 4, happy-dom tests).

## Global Constraints

- `pnpm validate` green at EVERY commit. Single-file runs: `pnpm --filter <pkg> exec vitest run <file>`.
- **Never store a computed number** (spec §1): no new tables, no new projections, no stored
  aggregates. The ONLY storage change in this plan is the additive `holeResults` field on
  `GolferRoundLine` (spec §2).
- The round event log, `RoundArchive`, `settleRound`, and the settled wire (`contracts/round.ts`)
  are UNTOUCHED. Zero edits under `packages/domain/src/round/` except none at all.
- One producer: `holeResults` and `distribution` are both built by `archiveGolferLine` in one
  walk. No second extraction path anywhere.
- Old lines without `holeResults` are TOLERATED everywhere: excluded from hole-based stats,
  never a throw, never counted as zero (spec §2).
- "Fully holed out" has ONE implementation (`fullyHoledOut` in `golfer/analytics.ts`) used by
  bests, milestones, course record, and crew net averages.
- The web compute fence (`eslint.config.mjs` `@typescript-eslint/no-restricted-imports`
  banlist for `apps/web/src`): every NEW barrel-exported domain compute name added by this
  plan MUST be appended to the banlist in the same task that exports it. Present-layer phrase
  formatters are allowed (existing precedent) and are NOT banned.
- `apps/web/e2e/crewSeason.spec.ts`'s frozen-deck assertions stay BYTE-IDENTICAL; new
  assertions are additive and hand-derived from the frozen deck before any live run.
- Deploy (controller-run close-out, not a plan task): `deploy:beta` LAMBDA-FIRST (the new
  bundle's record schema requires `bests`/`milestones`), then `publish:web:beta`, then ONE
  `rebuildProjections` run to backfill `holeResults`, then e2e gates. No wipe.
- Work on local `main`; never push.

---

### Task 1: `holeResults` on the golfer's row

**Files:**
- Modify: `packages/domain/src/round/holeResult.ts` (add `DecidedHoleResult`)
- Modify: `packages/domain/src/golfer/record.ts`
- Test: `packages/domain/src/golfer/record.test.ts` (exists — extend)
- Modify: `packages/domain/src/index.ts` (export `DecidedHoleResult` type if not already via `holeResult.js` re-export)

**Interfaces:**
- Consumes: `cellAt`, `findTeeSet`, `RoundArchive` (all existing).
- Produces: `GolferRoundLine.holeResults?: readonly GolferHoleLine[]` and
  `GolferHoleLine = { hole: number; par: number; result: DecidedHoleResult }` — Tasks 2–4
  read exactly this shape. `DecidedHoleResult = Exclude<HoleResult, { kind: "cleared" }>`.

- [ ] **Step 1: Add `DecidedHoleResult`** to `packages/domain/src/round/holeResult.ts`:

```ts
// What a reader sees through cellAt (round/state.ts): absent-or-cleared is undefined, so a
// cell a reader actually receives is never "cleared". The narrowed alias exists so extracts
// built through cellAt (golfer/record.ts's holeResults) carry the truth in their type.
export type DecidedHoleResult = Exclude<HoleResult, { kind: "cleared" }>;
```

- [ ] **Step 2: Write the failing tests** in `record.test.ts` (build archives through the
  file's existing fixture helpers — do NOT hand-construct archives a second way):

```ts
it("holeResults records every decided hole with its frozen par, in card order", () => {
  // fixture: hole 1 strokes 5 (par 4), hole 2 picked-up (par 3), hole 3 conceded (par 5),
  // hole 4 unscored, hole 5 cleared
  const line = archiveGolferLine(archive, golfer);
  expect(line.holeResults).toEqual([
    { hole: 1, par: 4, result: { kind: "strokes", strokes: 5 } },
    { hole: 2, par: 3, result: { kind: "picked-up" } },
    { hole: 3, par: 5, result: { kind: "conceded" } },
    // hole 4 (silence) and hole 5 (cleared) are OMITTED — cellAt's own contract
  ]);
});

it("holeResults and distribution agree — one walk, strokes cells only in the buckets", () => {
  const line = archiveGolferLine(fullArchive, golfer);
  const strokesHoles = line.holeResults!.filter((h) => h.result.kind === "strokes");
  const bucketTotal =
    line.distribution.eagles + line.distribution.birdies + line.distribution.pars +
    line.distribution.bogeys + line.distribution.doublePlus;
  expect(strokesHoles.length).toBe(bucketTotal);
});
```

- [ ] **Step 3: Run to verify failure** —
  `pnpm --filter @swng/domain exec vitest run src/golfer/record.test.ts` — FAIL
  (`holeResults` undefined).

- [ ] **Step 4: Implement** in `record.ts`. Add to the interface (after `distribution`):

```ts
// The player's hole-by-hole facts from the frozen card (analytics spec 2026-07-21 §2):
// decided cells only via cellAt (unscored + cleared omitted), card order, par frozen at play
// time — a later card supersession never rewrites a historical line. OPTIONAL because lines
// written before this field exist until one rebuildProjections run backfills them; readers
// exclude such lines from hole-based stats with honest sample counts, never throw.
readonly holeResults?: readonly GolferHoleLine[];
```

with, above the interface:

```ts
export interface GolferHoleLine {
  readonly hole: number;
  readonly par: number;
  readonly result: DecidedHoleResult;
}
```

and extend the ONE existing loop in `archiveGolferLine` (do not add a second loop):

```ts
const distribution = { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 };
const holeResults: GolferHoleLine[] = [];
for (const hole of teeSet.holes) {
  const cell = cellAt(archive.cells, golferId, hole.number);
  if (!cell) continue;
  if (cell.result.kind === "cleared") continue; // unreachable (cellAt hides cleared) — narrows the type
  holeResults.push({ hole: hole.number, par: hole.par, result: cell.result });
  if (cell.result.kind !== "strokes") continue;
  // ...existing bucket arithmetic unchanged...
}
```

and add `holeResults,` to the returned object (unconditionally — a new line always carries
it, possibly `[]`).

- [ ] **Step 5: Run** the file, then `pnpm validate`. The wire is UNAFFECTED by construction —
  verify: `grep -n holeResults packages/contracts/src/golfers.ts packages/application/src/golfers/recordOf.ts`
  returns nothing (`toWireLine` maps fields explicitly, so the wire line never carries it).

- [ ] **Step 6: Commit** — `feat(domain): the golfer's row records the holes — holeResults, one walk with distribution`

---

### Task 2: Bests + milestones in the metrics fold

**Files:**
- Create: `packages/domain/src/golfer/analytics.ts`
- Create: `packages/domain/src/golfer/analytics.test.ts`
- Modify: `packages/domain/src/golfer/metrics.ts`
- Modify: `packages/domain/src/index.ts` (export the new types; NOT the helper functions unless a later task needs them cross-package — `fullyHoledOut`/`grossOf` ARE needed by Task 4, so export them)
- Modify: `eslint.config.mjs` (append `bests`, `milestones` — if exported — plus `fullyHoledOut`, `grossOf` to the web banlist)
- Test: `packages/domain/src/golfer/metrics.test.ts` (extend)

**Interfaces:**
- Consumes: `GolferRoundLine.holeResults` (Task 1).
- Produces (used by Tasks 3–5):

```ts
// analytics.ts
export const fullyHoledOut = (line: GolferRoundLine): boolean =>
  line.holeResults !== undefined &&
  line.holeResults.length === line.holes &&
  line.holeResults.every((h) => h.result.kind === "strokes");
export const grossOf = (line: GolferRoundLine): number; // sum of strokes; call only when fullyHoledOut
export interface BestRound { readonly roundId: RoundId; readonly gross: number; readonly toPar: number; }
export interface GolferBests { readonly best18?: BestRound; readonly best9?: BestRound; }
export type MilestoneKind = "first-birdie" | "first-eagle" | "broke-100" | "broke-90" | "broke-80";
export interface Milestone { readonly kind: MilestoneKind; readonly roundId: RoundId; }
export const bestsOf = (lines: readonly GolferRoundLine[]): GolferBests;      // lines oldest→newest
export const milestonesOf = (lines: readonly GolferRoundLine[]): readonly Milestone[];
```

- `GolferMetrics` gains REQUIRED `bests: GolferBests` (possibly `{}`) and
  `milestones: readonly Milestone[]` (possibly `[]`), computed inside `golferMetrics`.

**Definitions (spec §3, verbatim into tests):** best = lowest gross among fully holed-out
lines of that hole count, tie → the EARLIER line (strict `<` while scanning oldest→newest).
`toPar = gross − line.par`. Milestones, achieved-only, earliest qualifying line each:
first-birdie = first line with a strokes hole exactly 1 under its par; first-eagle = ≥2 under;
broke-N = first fully holed-out **18** with gross < N (N ∈ {100, 90, 80}). Milestone array
order: the fixed kind order above (a stable wire order, not chronological).

- [ ] **Step 1: Write failing tests** in `analytics.test.ts` — line fixtures are plain object
  literals (no archives needed). Cases: (a) bests picks lowest gross per hole count and
  ignores a lower-gross line that has a picked-up hole; (b) tie → earlier roundId; (c) a line
  without `holeResults` is never fully holed out; (d) first-birdie at the earliest −1 hole and
  an eagle line does NOT satisfy first-birdie; (e) broke-90 ignores a 9-hole 42; (f) an 85
  earns broke-100 AND broke-90 from the same round; (g) empty lines → `{}` / `[]`.
- [ ] **Step 2: Run — FAIL** (`analytics.ts` missing).
- [ ] **Step 3: Implement** `analytics.ts` exactly to the definitions:

```ts
export const grossOf = (line: GolferRoundLine): number =>
  line.holeResults!.reduce((sum, h) => sum + (h.result.kind === "strokes" ? h.result.strokes : 0), 0);

export const bestsOf = (lines: readonly GolferRoundLine[]): GolferBests => {
  const bestFor = (holes: 9 | 18): BestRound | undefined => {
    let best: BestRound | undefined;
    for (const line of lines) {
      if (line.holes !== holes || !fullyHoledOut(line)) continue;
      const gross = grossOf(line);
      if (best === undefined || gross < best.gross) best = { roundId: line.roundId, gross, toPar: gross - line.par };
    }
    return best;
  };
  const best18 = bestFor(18);
  const best9 = bestFor(9);
  return { ...(best18 ? { best18 } : {}), ...(best9 ? { best9 } : {}) };
};

export const milestonesOf = (lines: readonly GolferRoundLine[]): readonly Milestone[] => {
  const firstHole = (test: (underPar: number) => boolean): RoundId | undefined =>
    lines.find((line) => line.holeResults?.some((h) => h.result.kind === "strokes" && test(h.par - h.result.strokes)))?.roundId;
  const firstBroke = (threshold: number): RoundId | undefined =>
    lines.find((line) => line.holes === 18 && fullyHoledOut(line) && grossOf(line) < threshold)?.roundId;
  const found: { kind: MilestoneKind; roundId: RoundId | undefined }[] = [
    { kind: "first-birdie", roundId: firstHole((u) => u === 1) },
    { kind: "first-eagle", roundId: firstHole((u) => u >= 2) },
    { kind: "broke-100", roundId: firstBroke(100) },
    { kind: "broke-90", roundId: firstBroke(90) },
    { kind: "broke-80", roundId: firstBroke(80) },
  ];
  return found.filter((m): m is Milestone => m.roundId !== undefined);
};
```

- [ ] **Step 4: Wire into `golferMetrics`** (metrics.ts): add `bests: bestsOf(lines)` and
  `milestones: milestonesOf(lines)` to the returned object and the `GolferMetrics` interface
  (REQUIRED members, the typicalEighteen precedent). Extend `metrics.test.ts`: an existing
  fixture asserts the two new members' presence and one hand-computed value.
- [ ] **Step 5: Fence** — append the new compute names to the eslint banlist entry for
  `@swng/domain` in `eslint.config.mjs` (`bestsOf`, `milestonesOf`, `fullyHoledOut`,
  `grossOf`). Run `pnpm lint`.
- [ ] **Step 6: Run both test files, then `pnpm validate`.** Expect FAILURES OUTSIDE domain:
  every web/contracts test fixture that constructs a `GolferMetrics` literal now misses the two
  required members — fix each fixture by adding `bests: {}, milestones: []` (mechanical sweep;
  the contracts schema itself is Task 5's job, so if `pnpm validate` fails ONLY in contracts
  schema-vs-type assignability, add the two schema fields there in THIS task instead of
  leaving main red — note it in the report either way).
- [ ] **Step 7: Commit** — `feat(domain): bests + milestones join the metrics fold`

---

### Task 3: The personal course record fold + its phrases

**Files:**
- Create: `packages/domain/src/golfer/courseRecord.ts`
- Create: `packages/domain/src/golfer/courseRecord.test.ts`
- Create: `packages/domain/src/golfer/present.ts` (phrase formatters — fence-ALLOWED)
- Create: `packages/domain/src/golfer/present.test.ts`
- Modify: `packages/domain/src/index.ts`, `eslint.config.mjs` (ban `courseRecord`; do NOT ban the present formatters)

**Interfaces:**
- Consumes: `GolferRoundLine` + Task 2's `fullyHoledOut`/`grossOf`.
- Produces (Task 5 serves this; Task 7 renders it):

```ts
export interface CourseHoleInsight { readonly hole: number; readonly par: number; readonly plays: number; }
export interface CourseRecord {
  readonly rounds: number; // lines at this course, any state
  readonly best?: BestRound;
  readonly scoringAverage?: number; // mean gross over fully holed-out lines, 1 decimal (roundHalfUp(x*10)/10)
  // Present iff rounds >= 5 (spec §4's gate — the domain owns it, not the web)
  readonly insights?: {
    readonly worstHole?: CourseHoleInsight & { readonly avgOverPar: number; readonly doublePlus: number };
    readonly scoringHole?: CourseHoleInsight & { readonly parOrBetter: number };
    readonly neverBirdied?: readonly number[]; // present iff 1..3 holes remain
  };
}
export const courseRecord = (lines: readonly GolferRoundLine[], courseId: CourseId): CourseRecord;
```

**Definitions (spec §4):** filter `line.courseId === courseId`. Per-hole stats aggregate
strokes-plays only (the distribution precedent), joined by hole number; par shown is the most
recent line's par for that hole. worstHole = highest mean (strokes − par) among holes with
≥3 strokes-plays; ties → more doublePlus (strokes ≥ par+2), then LOWER hole number.
scoringHole = highest parOrBetter/plays rate among holes with ≥3 strokes-plays; ties → lower
hole number. neverBirdied = holes with ≥1 strokes-play and zero plays under par, included in
the output only when 1 ≤ count ≤ 3. `avgOverPar` rounded to 1 decimal (roundHalfUp(x*10)/10).

Phrases in `present.ts` (copy is the mockup's, artifact `7a167ca5`):

```ts
export const worstHolePhrase = (w: { hole: number; avgOverPar: number; doublePlus: number; plays: number }): string =>
  `Hole ${w.hole} gets you — +${w.avgOverPar.toFixed(1)} a round; you’ve doubled it ${w.doublePlus} time${w.doublePlus === 1 ? "" : "s"} in ${w.plays} plays.`;
export const scoringHolePhrase = (s: { hole: number; parOrBetter: number; plays: number }): string =>
  `Hole ${s.hole} is your scoring hole — par or better in ${s.parOrBetter} of ${s.plays}.`;
export const neverBirdiedPhrase = (holes: readonly number[]): string =>
  holes.length === 1 ? `You’ve never birdied ${holes[0]}.` : `You’ve never birdied ${holes.join(", ")}.`;
```

- [ ] **Step 1: Failing tests** — hand-pinned fixtures: the gate at 4 vs 5 rounds; worst-hole
  tie broken by doublePlus then hole number; a line without `holeResults` counts toward
  `rounds` but contributes no hole stats and can't hold `best`; neverBirdied omitted at 0 and
  at 4 remaining, present at 3; scoringAverage excludes a picked-up line; phrase snapshots.
- [ ] **Step 2: Run — FAIL.** **Step 3: Implement.** **Step 4: Run — PASS, then `pnpm validate`.**
- [ ] **Step 5: Commit** — `feat(domain): courseRecord — your record here, the holes by name`

---

### Task 4: Crew analytics folds

**Files:**
- Create: `packages/domain/src/crew/analytics.ts`
- Create: `packages/domain/src/crew/analytics.test.ts`
- Modify: `packages/domain/src/crew/ledger.ts` (export `configForResult` — one copy)
- Modify: `packages/domain/src/index.ts`, `eslint.config.mjs` (ban `partnerRecords`, `netAverages`, `mostImproved`, `stablefordTitle`)

**Interfaces:**
- Consumes: `RoundArchive`, `archiveGolferLine` (Task 1's holeResults ride along),
  `fullyHoledOut`/`grossOf` (Task 2), `configForResult` (newly exported).
- Produces (Task 5 serves; Task 7 renders):

```ts
export interface PartnerRecord { readonly a: GolferId; readonly b: GolferId; readonly wins: number; readonly losses: number; readonly halves: number; }
// Four-ball only (spec §5); a pair counts iff BOTH are in memberIds. Pair identity: lexicographic a<b.
// Sorted wins desc, then a asc, then b asc.
export const partnerRecords = (archives: readonly RoundArchive[], memberIds: ReadonlySet<GolferId>): readonly PartnerRecord[];

export interface NetAverage { readonly golferId: GolferId; readonly holes: 9 | 18; readonly rounds: number; readonly average: number; }
// Per member: net = grossOf(line) − line.courseHandicap over fully holed-out archives they
// played; grouped per hole count; QUALIFIED at rounds >= 3; each member keeps the hole count
// with more qualifying rounds (tie → 18); average to 1 decimal. Sorted average asc, golferId asc.
export const netAverages = (archives: readonly RoundArchive[], memberIds: ReadonlySet<GolferId>): readonly NetAverage[];

export interface ImprovementEntry { readonly golferId: GolferId; readonly from: number; readonly to: number; }
// Input rows are application-computed (spec §5: index as of first/last counted round).
// Returns entries with to < from (a DROP), sorted by drop desc then golferId asc — [] when none.
export const mostImproved = (entries: readonly { readonly golferId: GolferId; readonly from?: number; readonly to?: number }[]): readonly ImprovementEntry[];

// Stableford points leader(s) of one season's roster-filtered ledger; [] when the ledger is
// empty or the leading points are 0.
export const stablefordTitle = (ledger: readonly SeasonLedgerLine[]): readonly GolferId[];
```

- [ ] **Step 1: Failing tests.** Build small archives through the ledger tests' existing
  fixture helpers. Cases: fourball pair with a non-member partner excluded; halved fourball
  gives both pairs a half; net average splits 9s from 18s and drops a 2-round hole count;
  the 3-round floor; mostImproved excludes a riser and an undefined end; stablefordTitle tie
  returns both, all-zero returns [].
- [ ] **Step 2: Run — FAIL. Step 3: Implement** (reuse `configForResult` for fourball configs;
  build each member's line via `archiveGolferLine(archive, golferId)` inside `netAverages` —
  participants not in the archive throw `unknown-participant`, so guard with
  `archive.participants.some(...)` first). **Step 4: PASS + `pnpm validate`.**
- [ ] **Step 5: Commit** — `feat(domain): crew analytics — partner records, net averages, most improved, titles`

---

### Task 5: Contracts + application — the wire and the use cases

**Files:**
- Modify: `packages/contracts/src/golfers.ts` (metrics schema += `bests`/`milestones`; new `GetMyCourseRecordResponse`)
- Modify: `packages/contracts/src/crews.ts` (standings += `partners`/`superlatives`; new `CrewRecordsResponse`)
- Create: `packages/application/src/golfers/getMyCourseRecord.ts`
- Modify: `packages/application/src/crews/getSeasonStandings.ts`
- Create: `packages/application/src/crews/getCrewRecords.ts`
- Modify: `packages/application/src/index.ts` (export the new use cases)
- Tests: `packages/contracts/src/golfers.test.ts`, `crews.test.ts`,
  `packages/application/src/golfers/golferSlice.test.ts`,
  `packages/application/src/crews/` slice tests (extend the existing files)

**Interfaces:**
- Consumes: Tasks 2–4's domain exports; existing ports `ProjectionStore.listLines`,
  `SnapshotStore.getMany`, `CrewStore.{getSeason,listCountedRounds,listSeasons}`,
  `GolferStore.getBySub`. **No port changes.**
- Produces (Task 6 routes these; Task 7 fetches them):

```ts
// golfers.ts — metrics gains (REQUIRED, both response shapes):
//   bests: { best18?: { roundId, gross, toPar }, best9?: ... }
//   milestones: readonly { kind: "first-birdie"|"first-eagle"|"broke-100"|"broke-90"|"broke-80", roundId }[]
export interface GetMyCourseRecordResponse {
  readonly courseId: CourseId;
  readonly rounds: number;
  readonly best?: { readonly roundId: RoundId; readonly gross: number; readonly toPar: number };
  readonly scoringAverage?: number;
  readonly insights?: {
    readonly worstHole?: { readonly hole: number; readonly par: number; readonly plays: number; readonly avgOverPar: number; readonly doublePlus: number };
    readonly scoringHole?: { readonly hole: number; readonly par: number; readonly plays: number; readonly parOrBetter: number };
    readonly neverBirdied?: readonly number[];
  };
}

// crews.ts — SeasonStandingsResponse gains (REQUIRED):
//   partners: readonly { a, b, nameA, nameB, wins, losses, halves }[]
//   superlatives: {
//     lowestNet?: { holes: 9|18, average: number, rounds: number, golfers: readonly { golferId, name }[] },
//     mostImproved?: readonly { golferId, name, from, to }[],  // absent (not []) when nobody qualifies
//   }
export interface CrewRecordsResponse {
  readonly rounds: number; // distinct counted rounds all-time
  readonly ledger: readonly SeasonStandingLine[];
  readonly headToHead: readonly HeadToHeadRecord[];
  readonly partners: readonly { readonly a: GolferId; readonly b: GolferId; readonly nameA: string; readonly nameB: string; readonly wins: number; readonly losses: number; readonly halves: number }[];
  readonly titles: readonly { readonly seasonId: string; readonly name: string; readonly golfers: readonly { readonly golferId: GolferId; readonly name: string }[] }[]; // CLOSED seasons only
}
```

- [ ] **Step 1: Contracts (TDD via the contracts test files):** extend `golferMetricsSchema` +
  `getMyRecordResponseSchema.metrics` with `bests`/`milestones` (shared sub-schemas, declared
  once, the indexMetricSchema idiom); add `getMyCourseRecordResponseSchema`; extend
  `seasonStandingsResponseSchema`; add `crewRecordsResponseSchema`. Response schemas stay
  NON-strict (deploy-window tolerance — house style; request wire unchanged).
- [ ] **Step 2: `getMyCourseRecord`** — the `getMyRecord` idiom exactly:

```ts
export const getMyCourseRecord =
  (deps: { golferStore: GolferStore; projectionStore: ProjectionStore }) =>
  async (claims: AccountClaims, courseId: CourseId): Promise<GetMyCourseRecordResponse> => {
    const found = await deps.golferStore.getBySub(claims.sub);
    const lines = found ? await deps.projectionStore.listLines(found.golfer.id) : [];
    const record = courseRecord(sortLines(lines), courseId); // oldest→newest, ties like recordOf
    return { courseId, ...record };
  };
```

- [ ] **Step 3: Extend `getSeasonStandings`** — after the existing fold: `partnerRecords` and
  `netAverages` over the SAME `archives` + `memberIds` already in scope (names via the
  existing `nameByGolfer`); most-improved per spec §5 — for each roster member,
  `listLines(golferId)`, then `golferMetrics(sortLines(lines).filter(l => l.finalizedAtMs <= boundaryMs)).swngIndex?.value`
  at the season's first and last counted rounds' `finalizedAtMs` (skip both fetches and omit
  `mostImproved` entirely when `counted.length === 0`); feed `mostImproved(entries)`.
  Member line fetches run `Promise.all`, one query per member.
- [ ] **Step 4: `getCrewRecords`** — `requireCrewMember`, `listSeasons`, `listCountedRounds`
  per season, dedupe roundIds, ONE `snapshots.getMany`, then the exact `getSeasonStandings`
  roster-filter + `aggregateSeason` composition for the all-time ledger/head-to-head,
  `partnerRecords` for pairs, and `titles` = per CLOSED season:
  `stablefordTitle(roster-filtered aggregateSeason(that season's contributions).ledger)`,
  mapped to `{seasonId, name, golfers}` and included only when non-empty.
- [ ] **Step 5: Slice tests** (extend the existing in-memory-port slice tests): course record
  round-trips through the use case with a two-course line set; standings response carries
  hand-pinned partners/superlatives from a two-archive fixture; records dedupes a round
  counted in two seasons; a member with no lines yields no mostImproved entry, not a crash.
- [ ] **Step 6: Run contract + application tests, `pnpm validate`** (web `GolferMetrics`
  fixtures were already fixed in Task 2). **Step 7: Commit** —
  `feat(contracts,application): course record + crew records on the wire, standings grow analytics`

---

### Task 6: Routes — dispatcher, composition root, CDK

**Files:**
- Modify: `packages/lambda/src/http/routes.ts` (+2 routes)
- Modify: `packages/lambda/src/compositionRoot.ts` (wire both use cases)
- Modify: `apps/infra-cdk/lib/swngStack.ts` (+2 HTTP routes, in the stage `DependsOn` set; NOT in `ANON_THROTTLED_ROUTES`)
- Test: `packages/lambda/src/http/dispatch.test.ts` (extend), `apps/infra-cdk` stack tests (pinned route counts move 38→40 HTTP / 40→42 total — read the pins and update them)

**Interfaces:**
- Consumes: Task 5's use cases + schemas.
- Produces: `GET /me/courses/{courseId}/record` (auth `golfer`) and
  `GET /crews/{crewId}/records` (auth `golfer`), both 200.

- [ ] **Step 1:** Route entries — the `GET /golfers/{golferId}` idiom verbatim:

```ts
{
  method: "GET",
  path: "/me/courses/{courseId}/record",
  auth: "golfer",
  successStatus: 200,
  handler: async (ctx) => useCases.getMyCourseRecord(ctx.account!, courseId(ctx.pathParams.courseId!)),
},
{
  method: "GET",
  path: "/crews/{crewId}/records",
  auth: "golfer",
  successStatus: 200,
  handler: async (ctx) => useCases.getCrewRecords(ctx.account!, crewId(ctx.pathParams.crewId!)),
},
```

- [ ] **Step 2:** Composition root wiring (mirror `getMyRecord`'s deps line); dispatch tests
  assert both routes exist, are golfer-gated (401 bare), and call through.
- [ ] **Step 3:** CDK — add both paths where the HTTP routes are declared, following the
  existing `GET /me/record` declaration exactly; keep them OUT of the anon-throttle set;
  update the stack tests' pinned counts and the stage-DependsOn pin.
- [ ] **Step 4:** `pnpm validate`. **Step 5: Commit** —
  `feat(lambda,infra): two analytics reads — course record, crew records (38→40 HTTP routes)`

---

### Task 7: Web — render the served numbers

**Files:**
- Modify: `apps/web/src/api.ts` (`getMyCourseRecord`, `getCrewRecords` — the `getMyRecord` fetch idiom, both schema-parsed)
- Modify: `apps/web/src/golfers/RecordSections.tsx` (+Bests +Milestones sections)
- Create: `apps/web/src/courses/CourseRecordSection.tsx`
- Modify: `apps/web/src/courses/CoursePage.tsx` (render it, signed-in only)
- Create: `apps/web/src/crews/CrewRecordsSection.tsx`
- Modify: `apps/web/src/crews/SeasonPanel.tsx` (+partners +superlatives), `apps/web/src/crews/CrewPage.tsx` (render CrewRecordsSection)
- Tests: co-located `.test.tsx` for every touched component (extend existing files; new files get their own, with per-file `afterEach(cleanup)` — no global auto-cleanup)

**Interfaces:** consumes Task 5's wire shapes and Task 3's phrase formatters
(`worstHolePhrase`/`scoringHolePhrase`/`neverBirdiedPhrase` — fence-allowed present imports).
The web computes NO golf result: every number rendered below arrives on the wire.

- [ ] **Step 1: RecordSections** — between `IndexOverTime` and the typical-18 line, two new
  sections (person-aware copy, the existing convention; render nothing when empty):

```tsx
{(metrics.bests.best18 ?? metrics.bests.best9) && (
  <div>
    <h3 className="text-base font-semibold">Best rounds</h3>
    <ul className="flex flex-col gap-1 text-sm text-fairway tabular-nums">
      {metrics.bests.best18 && <li>{bestLine("Best 18", metrics.bests.best18)}</li>}
      {metrics.bests.best9 && <li>{bestLine("Best 9", metrics.bests.best9)}</li>}
    </ul>
  </div>
)}
{metrics.milestones.length > 0 && (
  <div>
    <h3 className="text-base font-semibold">Milestones</h3>
    <ul className="flex flex-col gap-1 text-sm text-fairway">
      {metrics.milestones.map((m) => <li key={m.kind}>{milestoneLine(m)}</li>)}
    </ul>
  </div>
)}
```

with local presentation helpers (`bestLine` joins gross/toPar/courseName by looking the
`roundId` up in `history` — a join of served values, not compute; `milestoneLine` maps kind →
copy: "First birdie" / "First eagle" / "Broke 100" / "Broke 90" / "Broke 80", each linking
the round via the history row's course name; vsPar-style signing reuses the FILE'S existing
`vsPar` helper). Extend `RecordSections`' props NOT at all — `metrics`/`history` already
carry everything.

- [ ] **Step 2: CourseRecordSection** — props `{ courseId }`; reads `useAuth`; renders
  nothing signed-out; fetches `getMyCourseRecord` on mount (the GolferPage fetch idiom:
  ignore-flag effect); renders the mockup's two blocks — "Your record here" stat lines
  (rounds / best `${gross} (${sign})` / scoring average) and "The holes, by name" iff
  `insights` present, each sentence via the domain phrase formatters; below the gate renders
  `Your course record builds at 5 rounds here — you've played N.` (the IndexOverTime gate
  copy idiom). Integrate into `CoursePage` after the card block.
- [ ] **Step 3: SeasonPanel** — beside the existing ledger table: a "Partners — four-ball"
  list (`{nameA} & {nameB} — {wins}–{losses}` + `· {halves} halved` when > 0) and a "Season
  superlatives" block (lowest net: `Lowest net average — {names} · {average}` with
  `({rounds} rounds{holes === 9 ? " · 9 holes" : ""})`; most improved:
  `Most improved — {name} · {from} → {to}` per entry). Empty partners list / absent
  superlatives render NOTHING (no empty-state footnote — the ledger's existing empty-state
  lesson).
- [ ] **Step 4: CrewRecordsSection** — fetches `getCrewRecords`; renders "All-time" —
  head-to-head sentences (reuse SeasonPanel's existing leader-first sentence helper by
  extracting it if it isn't shared yet), lifetime ledger table (same columns as season),
  partners, and titles (`Stableford titles — {name} '{yy}` per season, joined "·"). Renders
  nothing while loading; an error renders the section's honest fallback line
  ("Records aren't available right now."). Integrate into `CrewPage` below the seasons.
- [ ] **Step 5: Tests** — RecordSections: bests/milestones render from a fixture and are
  ABSENT for `{bests: {}, milestones: []}` (plus the existing snapshots stay green);
  CourseRecordSection: gate copy below 5 rounds, phrases at ≥5, nothing signed-out;
  SeasonPanel: partners/superlatives from a fixture, nothing when absent; CrewRecordsSection:
  titles + h2h from a fixture. Run each file, then `pnpm validate` (includes the fence — no
  new banned import may appear; the phrase formatters must import cleanly).
- [ ] **Step 6: Commit** — `feat(web): the record shows bests + milestones, the course shows your record, the crew shows partners + superlatives + all-time`

---

### Task 8: E2E reconciliation (deliberate task — the string-breakage lesson)

**Files:**
- Modify: `apps/web/e2e/identityRecord.spec.ts` (bests + milestones assertions on its
  hand-pinned three rounds — derive expected gross/toPar/milestones BY HAND from the spec's
  definitions and the spec file's own seeded scores before running)
- Modify: `apps/web/e2e/crewSeason.spec.ts` (ADDITIVE: after the existing byte-identical
  standings assertions, assert partners/superlatives/records against values hand-derived from
  the FROZEN deck; existing assertions untouched)
- Modify: `apps/web/e2e/courseEntry.spec.ts` OR `fieldTest.spec.ts` (one beat: after
  finalize, the course page shows "Your record here" with rounds ≥ 1 — locator by accessible
  heading, verified against the JSX)
- Modify: root `e2e/` only if the record-shape assertions there parse metrics (they parse via
  contracts schemas — Task 5 made the new members required, so any fixture literals there were
  already updated; verify with a grep for `typicalEighteen` fixtures)

- [ ] **Step 1:** Hand-derive every expected value and write it into the spec files as
  literals with a derivation comment (the frozen-deck discipline).
- [ ] **Step 2:** `pnpm validate` (e2e specs typecheck under it). Playwright runs happen at
  the controller's close-out against beta, not in this task.
- [ ] **Step 3: Commit** — `test(e2e): analytics beats — pinned bests/milestones, frozen-deck partners + superlatives`

---

## Self-review notes (writing-plans checklist)

- Spec coverage: §2→T1, §3→T2 (+wire T5), §4→T3/T5/T6/T7, §5→T4/T5/T6/T7, §6→T5/T6 +
  controller close-out, §8→every task's tests + T8. The §4 course-page gate copy and §5
  empty-state rules are in T7 steps.
- No placeholder steps: every new function/schema/route/section has its code or its exact
  shape + integration point; host-file context the implementer reads in place.
- Type consistency: `GolferHoleLine`/`DecidedHoleResult` (T1) are the only new cross-task
  types consumed by T2–T4; `BestRound` flows T2→T5 wire verbatim; `SeasonStandingLine`/
  `HeadToHeadRecord` reused, never redeclared.
