# Crew Scoreboard & Window Seasons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seasons become time windows and the crew page fills itself — a per-member
scoreboard and together-records derived on read from golfer projection lines, the entire
manual round-counting apparatus deleted.

**Architecture:** One new pure domain fold (`crew/scoreboard.ts`) over already-fetched
projection lines; `CrewSeason` gains `startsAtMs`/`closedAtMs`; `getSeasonStandings`/
`getCrewRecords` re-derive their round sets (window × current roster, shared-roundId for
together records); the wire drops superlatives/counted rounds and gains the scoreboard;
SeasonPanel leads with the board. Spec:
`docs/superpowers/specs/2026-07-21-crew-scoreboard-window-seasons-design.md` (binding).

**Tech Stack:** existing monorepo (Zod contracts, DynamoDB adapter contract tests under
DynamoDB Local, Vitest, Playwright e2e against beta).

## Global Constraints

- `pnpm validate` green at EVERY commit; work on local `main`, never push.
- **Frozen-deck law:** crewSeason's hand-designed NUMBERS are untouchable — singles H2H
  5W-5L-2H, skins 54 each, stableford 430/430/435/435, the domain-owned ledger order.
- The web computes no golf result (ESLint fence): every scoreboard number arrives SERVED;
  the web may only format (spec §5). No client-side sorting of served scoreboard rows.
- Wire naming: `CrewSeasonView` stays field-for-field with the store shape
  (`startsAtMs`, `closedAtMs` — `createdAtMs` already rides it); the shared-rounds list
  keeps `finalizedAt` (spec §4).
- Window rule (spec §2): played date = `createdAtMs ?? finalizedAtMs`; window inclusive
  BOTH ends; start rule `max(latest closedAtMs among closed seasons, Jan 1 UTC of
  creation year)`.
- Route counts after Task 5: HTTP 42→40, total 44→42 (dispatch.test.ts pins).
- No data wipe. Legacy folds: season rows without `startsAtMs` read as `createdAtMs`;
  orphan `SEASON#<id>#ROUND#<id>` items tolerated forever (listSeasons already filters).
- Deploy (close-out only, controller-run): lambda-first, `publish:web:beta` immediately
  after (spec §4 stale-bundle note).

---

### Task 1: Domain — `crew/scoreboard.ts`

**Files:**
- Create: `packages/domain/src/crew/scoreboard.ts`
- Create: `packages/domain/src/crew/scoreboard.test.ts`
- Modify: `packages/domain/src/index.ts` (export the new module's names)

**Interfaces (Produces — Tasks 3 uses verbatim):**

```ts
export type StoredLine = GolferRoundLine & { readonly finalizedAtMs: number; readonly createdAtMs?: number };
export interface SeasonWindow { readonly startMs: number; readonly endMs?: number; }
export const playedAtMs: (line: { readonly finalizedAtMs: number; readonly createdAtMs?: number }) => number;
export const inWindow: (window: SeasonWindow, line: StoredLine) => boolean;
export interface ScoreboardLine {
  readonly golferId: GolferId;
  readonly rounds: number;
  readonly best18?: { readonly gross: number; readonly toPar: number };
  readonly netPer18?: number;
  readonly index?: number;
  readonly indexDelta?: number;
}
export const crewScoreboard: (
  members: readonly { readonly golferId: GolferId; readonly lines: readonly StoredLine[] }[],
  window: SeasonWindow,
) => readonly ScoreboardLine[];
export const sharedRoundIds: (
  members: readonly { readonly golferId: GolferId; readonly lines: readonly StoredLine[] }[],
  window: SeasonWindow,
) => readonly RoundId[];
```

- [ ] **Step 1: Write the module** — implementation (verify `grossOf`/`fullyHoledOut`
  signatures against `golfer/analytics.ts` before writing; they take a `GolferRoundLine`):

```ts
import type { GolferId, RoundId } from "../ids.js";
import { fullyHoledOut, grossOf } from "../golfer/analytics.js";
import { golferMetrics } from "../golfer/metrics.js";
import type { GolferRoundLine } from "../golfer/record.js";
import { roundHalfUp } from "../scoring/strokes.js";

// The crew scoreboard (crew-scoreboard spec §3a): a pure fold over ALREADY-FETCHED golfer
// projection lines — never a fetcher (the crew/analytics.ts discipline). `lines` per member
// is the FULL career in chronological order (application sorts via sortLines — golferMetrics'
// own contract); the fold windows internally so index/indexDelta can see the whole record.

export type StoredLine = GolferRoundLine & { readonly finalizedAtMs: number; readonly createdAtMs?: number };

export interface SeasonWindow {
  readonly startMs: number;
  readonly endMs?: number; // absent = open season
}

// The ONE played-date rule (spec §2): the round's created (played) time first, its finalize
// time when older lines predate createdAtMs — the roundLabel/chart-anchor precedent.
export const playedAtMs = (line: { readonly finalizedAtMs: number; readonly createdAtMs?: number }): number =>
  line.createdAtMs ?? line.finalizedAtMs;

// Inclusive at BOTH ends: a round played at the very instant of a close belongs to the
// season that was closing (spec §2).
export const inWindow = (window: SeasonWindow, line: StoredLine): boolean => {
  const at = playedAtMs(line);
  return at >= window.startMs && (window.endMs === undefined || at <= window.endMs);
};

export interface ScoreboardLine {
  readonly golferId: GolferId;
  readonly rounds: number;
  readonly best18?: { readonly gross: number; readonly toPar: number };
  readonly netPer18?: number;
  readonly index?: number;
  readonly indexDelta?: number;
}

const NET_PER_18_MIN_ROUNDS = 3; // the netAverages refusing-to-draw-noise floor, carried forward (spec §3a)

export const crewScoreboard = (
  members: readonly { readonly golferId: GolferId; readonly lines: readonly StoredLine[] }[],
  window: SeasonWindow,
): readonly ScoreboardLine[] => {
  const rows = members.map(({ golferId, lines }) => {
    const windowed = lines.filter((line) => inWindow(window, line));

    // Lowest gross over fully-holed-out in-window 18s; strict < keeps the EARLIER round on a
    // tie (lines arrive chronological — the bestsOf precedent).
    let best18: { gross: number; toPar: number } | undefined;
    for (const line of windowed) {
      if (line.holes !== 18 || !fullyHoledOut(line)) continue;
      const gross = grossOf(line);
      if (best18 === undefined || gross < best18.gross) best18 = { gross, toPar: gross - line.par };
    }

    // AGS-based, vs-par, normalized per 18 (spec §3a's honesty argument); one decimal.
    const netLines = windowed.filter((line) => line.ags !== undefined);
    const netPer18 =
      netLines.length >= NET_PER_18_MIN_ROUNDS
        ? roundHalfUp(
            (netLines.reduce((sum, line) => sum + (line.ags! - line.courseHandicap - line.par), 0) /
              netLines.reduce((sum, line) => sum + line.holes, 0)) *
              18 *
              10,
          ) / 10
        : undefined;

    // The index is always the whole career; the delta is window-scoped via the same
    // played-date rule the window itself uses.
    const index = golferMetrics(lines).swngIndex?.value;
    const before = golferMetrics(lines.filter((line) => playedAtMs(line) < window.startMs)).swngIndex?.value;
    const indexDelta = index !== undefined && before !== undefined ? roundHalfUp((index - before) * 10) / 10 : undefined;

    return {
      golferId,
      rounds: windowed.length,
      ...(best18 !== undefined ? { best18 } : {}),
      ...(netPer18 !== undefined ? { netPer18 } : {}),
      ...(index !== undefined ? { index } : {}),
      ...(indexDelta !== undefined ? { indexDelta } : {}),
    };
  });

  // Total order, domain-owned (the aggregateSeason precedent): netPer18 asc with absent
  // LAST, rounds desc, golferId asc.
  return rows.sort((x, y) => {
    if (x.netPer18 !== y.netPer18) {
      if (x.netPer18 === undefined) return 1;
      if (y.netPer18 === undefined) return -1;
      return x.netPer18 - y.netPer18;
    }
    return y.rounds !== x.rounds ? y.rounds - x.rounds : x.golferId < y.golferId ? -1 : x.golferId > y.golferId ? 1 : 0;
  });
};

// "We played together" as a DERIVED fact (spec §3b): roundIds where >=2 DISTINCT members
// hold an in-window line. No order promised — callers sort for the wire.
export const sharedRoundIds = (
  members: readonly { readonly golferId: GolferId; readonly lines: readonly StoredLine[] }[],
  window: SeasonWindow,
): readonly RoundId[] => {
  const holders = new Map<RoundId, Set<GolferId>>();
  for (const { golferId, lines } of members) {
    for (const line of lines) {
      if (!inWindow(window, line)) continue;
      const set = holders.get(line.roundId) ?? new Set<GolferId>();
      set.add(golferId);
      holders.set(line.roundId, set);
    }
  }
  return [...holders.entries()].filter(([, set]) => set.size >= 2).map(([roundId]) => roundId);
};
```

- [ ] **Step 2: Write the tests** (`scoreboard.test.ts`) with a line builder that makes
  `grossOf`/`fullyHoledOut` real:

```ts
// mkLine: n holes of {par, strokes} so grossOf/fullyHoledOut operate on real holeResults.
const mkLine = (opts: {
  roundId: string; holes: 9 | 18; par: number; ch: number; ags?: number;
  overs?: number; // first `overs` holes bogey, rest par -> gross = par + overs
  pickedUpHole?: number; finalizedAtMs: number; createdAtMs?: number; differential?: number;
}): StoredLine => { /* build holeResults hole-by-hole so hole pars SUM to line.par (internally
  honest fixtures): par 72/18 → 18×4; par 36/9 → 9×4; par 70/18 → 16×4 + 2×3. First `overs`
  holes get strokes par+1, the rest par; `pickedUpHole` swaps that hole's result for a
  picked-up arm. Set `ags`, `differential`, `distribution` explicitly per case. */ };
```

  Cases and hand-derived oracles (spec §7):
  1. **netPer18 worked fixture** — member with three lines: 18h par 72 CH 12 ags 85
     (+1), 9h par 36 CH 5 ags 41 (0), 18h par 70 CH 8 ags 80 (+2); sum 3 over 45 holes
     × 18 = **1.2**.
  2. **Floor** — only 2 ags-bearing lines → `netPer18` absent.
  3. **best18** — fully-holed 18s gross 85 (par 72) and 80 (par 70) → `{gross: 80,
     toPar: 10}`; tie: gross 80 (par 70, earlier) then gross 80 (par 72, later) →
     `toPar: 10` (the earlier line won).
  4. **Exclusions** — a 9-hole line and a line with `pickedUpHole` (not fully holed out)
     never produce `best18`.
  5. **Window edges** — `playedAt == startMs` in; `== endMs` in; `startMs − 1` out;
     `endMs + 1` out; a line with `createdAtMs` outside but `finalizedAtMs` inside is
     OUT (created wins).
  6. **Zero-round member** — present as `{golferId, rounds: 0}` with every optional
     absent.
  7. **index/indexDelta reuse-proof** (never re-derive the engine): with rated lines
     (differentials set), `row.index === golferMetrics(lines).swngIndex?.value`;
     `row.indexDelta === roundHalfUp((index − golferMetrics(preWindowLines).swngIndex!.value) * 10) / 10`;
     delta absent when no pre-window lines exist.
  8. **Sort totality** — netPer18 asc; absent-last; rounds desc tiebreak; golferId final;
     two fully-identical rows keep deterministic order.
  9. **sharedRoundIds** — two members sharing one in-window roundId → returned; the same
     round shared only OUTSIDE the window → not; a round held by one member only → not;
     result has no duplicates.

- [ ] **Step 3:** `pnpm -F @swng/domain vitest run src/crew/scoreboard.test.ts` → all pass;
  export the new names from `packages/domain/src/index.ts`; `pnpm validate` → exit 0.
- [ ] **Step 4: Commit** — `feat(domain): crew scoreboard fold — window, shared rounds, per-member lines`

---

### Task 2: Seasons become windows — store, verbs, and the auto-season

**Files:**
- Modify: `packages/application/src/ports/crewStore.ts` (CrewSeason + doc; leave counted
  methods alone — Task 5 deletes them)
- Create: `packages/application/src/crews/seasonStart.ts`
- Modify: `packages/application/src/crews/createSeason.ts`, `createCrew.ts`,
  `closeSeason.ts`, `reopenSeason.ts`
- Modify: `packages/adapters-dynamodb/src/createDynamoCrewStore.ts` (write + legacy fold)
- Modify: `packages/contracts/src/crews.ts` (`CrewSeasonView` + schema: required
  `startsAtMs`, optional `closedAtMs`)
- Modify: `packages/lambda/src/compositionRoot.ts` (`createCrew` gains `clock`,
  `closeSeason` gains `clock` — lines ~335/~355)
- Tests: adapter contract test file for crewStore; the four use-case slice test files

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `CrewSeason` with `startsAtMs: number` and `closedAtMs?: number` (exact shape
  in spec §2); `seasonStartMs(existing: readonly CrewSeason[], nowMs: number): number` and
  `yearStartUtcMs(nowMs: number): number` from `seasonStart.ts`.

- [ ] **Step 1:** `seasonStart.ts`:

```ts
import type { CrewSeason } from "../ports/crewStore.js";

// Window-start rule (crew-scoreboard spec §2): a new season picks up where the last closed
// one ended, or January 1 (UTC) of the creation year — whichever is LATER. Fixed at
// creation, stored, never recomputed: sequential seasons tile, and a season created after
// its rounds were played still reaches back to the year start.
export const yearStartUtcMs = (nowMs: number): number => Date.UTC(new Date(nowMs).getUTCFullYear(), 0, 1);

export const seasonStartMs = (existing: readonly CrewSeason[], nowMs: number): number => {
  const latestClosedEnd = existing.reduce<number | undefined>(
    (acc, season) => (season.closedAtMs !== undefined && (acc === undefined || season.closedAtMs > acc) ? season.closedAtMs : acc),
    undefined,
  );
  return Math.max(latestClosedEnd ?? 0, yearStartUtcMs(nowMs));
};
```

- [ ] **Step 2:** Use-case changes:
  - `createSeason`: after name validation — `const seasons = await deps.crewStore.listSeasons(id);`
    then build the season with `startsAtMs: seasonStartMs(seasons, now)` (one `clock.now()`
    read reused for `createdAtMs`).
  - `createCrew`: deps gain `clock: Clock`; after `crewStore.put(crew, undefined)`:

```ts
    // Every crew starts alive (spec §2): its first season exists before anyone asks —
    // named for the year, window from Jan 1, the start rule's no-closed-seasons case.
    const now = deps.clock.now();
    await deps.crewStore.putSeason(id, {
      seasonId: deps.ids.newId(),
      name: String(new Date(now).getUTCFullYear()),
      status: "open",
      createdAtMs: now,
      startsAtMs: yearStartUtcMs(now),
    });
```

  - `closeSeason`: deps gain `clock: Clock`; the closed value becomes
    `{ ...season, status: "closed", closedAtMs: deps.clock.now() }`.
  - `reopenSeason`: drop the field on reopen —
    `const { closedAtMs: _closedAtMs, ...rest } = season;` then
    `putSeason(id, { ...rest, status: "open" })`. (Verify the adapter's `putSeason` is a
    whole-item put — the port doc says "whichever CrewSeason a caller supplies wins
    outright" — so an absent field is truly removed.)
- [ ] **Step 3:** Adapter: `putSeason` writes `startsAtMs` and spreads `closedAtMs` only
  when present; season reads fold `startsAtMs: item.startsAtMs ?? item.createdAtMs` and
  spread `closedAtMs` only when present (both `getSeason` and `listSeasons` paths — find
  the one item→season mapping and change it once).
- [ ] **Step 4:** Contracts: `CrewSeasonView` + `crewSeasonViewSchema` gain
  `startsAtMs: z.number().int()` and `closedAtMs: z.number().int().optional()` (comment:
  field-for-field with `CrewSeason`, the standing rule).
- [ ] **Step 5: Tests.**
  - Contract (DynamoDB Local): open-season round-trip carries `startsAtMs`, no
    `closedAtMs`; closed round-trip carries both; **legacy fold** — insert a raw season
    item WITHOUT `startsAtMs` via the low-level client, `getSeason` returns
    `startsAtMs === createdAtMs`; close-then-reopen round-trip ends with `closedAtMs`
    absent (whole-item put proof).
  - Slices: `seasonStartMs` — no closed seasons → Jan 1 UTC of `now`'s year; one closed
    season with `closedAtMs` in June → June wins; a closed season from LAST year + now in
    a new year → Jan 1 of the new year wins (the `max`); `createCrew` → `listSeasons`
    yields exactly one open season named `String(year)` with `startsAtMs ===
    yearStartUtcMs(now)`; `closeSeason` stamps `closedAtMs = now`; `reopenSeason` clears it.
- [ ] **Step 6:** `pnpm validate` → exit 0; `pnpm test:contract` → green.
- [ ] **Step 7: Commit** — `feat(crews): seasons are windows — the tiling start rule, close stamps the end, crews start alive`

---

### Task 3: The wire flips — standings/records re-derived, the panel leads with the board

ONE atomic commit across application + contracts + web + the deck spec's reconciliation
(the index-source precedent: the wire type is imported everywhere, there is no green
intermediate). The frozen deck NUMBERS do not move.

**Files:**
- Modify: `packages/application/src/crews/getSeasonStandings.ts`, `getCrewRecords.ts`
- Modify: `packages/lambda/src/compositionRoot.ts` (`getCrewRecords` gains
  `projectionStore`)
- Modify: `packages/contracts/src/crews.ts` (response v2; leave the counted/superlative
  schemas EXPORTED but unreferenced — Task 5 deletes them)
- Modify: `apps/web/src/crews/SeasonPanel.tsx`, `SeasonPanel.test.tsx`, `CrewPage.tsx`
  (+ its test if the prop change surfaces)
- Create: `apps/web/src/ui/vsPar.ts` (hoist `vsPar` from
  `apps/web/src/golfers/RecordSections.tsx` VERBATIM — one copy; re-point RecordSections;
  its tests unchanged)
- Modify: `apps/web/e2e/crewSeason.spec.ts` (reconciliation only — see Step 5)

**Interfaces:**
- Consumes: Task 1's `crewScoreboard`/`sharedRoundIds`/`SeasonWindow`/`playedAtMs`;
  Task 2's `CrewSeason.startsAtMs/closedAtMs`.
- Produces: `SeasonStandingsResponse` v2 and `ScoreboardRow`/`SharedRoundView` exactly as
  spec §4; SeasonPanel renders served rows in served order.

- [ ] **Step 1: Contracts** — add:

```ts
const scoreboardRowSchema = z.object({
  golferId: golferIdSchema,
  name: z.string(),
  rounds: z.number().int(),
  best18: z.object({ gross: z.number().int(), toPar: z.number().int() }).optional(),
  netPer18: z.number().optional(),
  index: z.number().optional(),
  indexDelta: z.number().optional(),
});
const sharedRoundViewSchema = z.object({ roundId: roundIdSchema, finalizedAt: z.number().int() });
```

  and rewrite `SeasonStandingsResponse`/`seasonStandingsResponseSchema` to spec §4's exact
  shape (`startsAtMs` required, `closedAtMs` optional, `scoreboard` + `rounds` required
  arrays; `superlatives` and the old counted `rounds` gone from THIS schema only).
- [ ] **Step 2: `getSeasonStandings` rewrite** — keep `rosterFilteredContribution`
  exported as-is; the body becomes:

```ts
const { crew } = await requireCrewMember(deps, claims, id);
const season = await deps.crewStore.getSeason(id, seasonId);
if (!season) throw new ApplicationError("season-not-found");

const window: SeasonWindow = { startMs: season.startsAtMs, ...(season.closedAtMs !== undefined ? { endMs: season.closedAtMs } : {}) };

// ONE listLines per roster member — the fetch the old mostImproved boundary already paid —
// feeds the scoreboard, the shared-round derivation, and the index boundaries alike (spec §3b).
const members = await Promise.all(
  crew.members.map(async (member) => ({
    golferId: member.golferId,
    lines: sortLines(await deps.projectionStore.listLines(member.golferId)),
  })),
);

const nameByGolfer = new Map(crew.members.map((member) => [member.golferId, member.name]));
const scoreboard = crewScoreboard(members, window).map((row) => ({ ...row, name: nameByGolfer.get(row.golferId) ?? row.golferId }));

const shared = sharedRoundIds(members, window);
const archives = await deps.snapshots.getMany([...shared]);
const memberIds = new Set(crew.members.map((member) => member.golferId));
const memberOnlyContributions = archives.map((archive) => rosterFilteredContribution(archive, memberIds));
const { ledger, headToHead } = aggregateSeason(memberOnlyContributions);
const partners = partnerRecords(archives, memberIds).map((pair) => ({
  ...pair,
  nameA: nameByGolfer.get(pair.a) ?? pair.a,
  nameB: nameByGolfer.get(pair.b) ?? pair.b,
}));

// Shared rounds newest-first; any holder's line carries the same finalizedAtMs.
const finalizedByRound = new Map<RoundId, number>();
for (const { lines } of members) for (const line of lines) if (!finalizedByRound.has(line.roundId)) finalizedByRound.set(line.roundId, line.finalizedAtMs);
const rounds = shared
  .map((roundId) => ({ roundId, finalizedAt: finalizedByRound.get(roundId)! }))
  .sort((a, b) => b.finalizedAt - a.finalizedAt);

return {
  seasonId: season.seasonId,
  name: season.name,
  status: season.status,
  startsAtMs: season.startsAtMs,
  ...(season.closedAtMs !== undefined ? { closedAtMs: season.closedAtMs } : {}),
  scoreboard,
  rounds,
  ledger: ledger.map((line) => ({ ...line, name: nameByGolfer.get(line.golferId) ?? line.golferId })),
  headToHead,
  partners,
};
```

- [ ] **Step 3: `getCrewRecords` rewrite** — deps gain `projectionStore: ProjectionStore`
  (+ compositionRoot). Same one-fetch `members` assembly; all-time =
  `sharedRoundIds(members, { startMs: 0 })` → one `getMany` → the existing folds
  unchanged; `rounds: sharedEver.length`; titles per CLOSED season, chronological as
  today, each over `sharedRoundIds(members, { startMs: season.startsAtMs,
  ...(season.closedAtMs !== undefined ? { endMs: season.closedAtMs } : {}) })` — the
  conditional spread matters: a LEGACY closed season (closed before this arc) has no
  `closedAtMs` and reads as an open-ended window, never a crash — resolved through the
  SAME `archiveByRoundId` map (no second fetch). `CrewRecordsResponse` shape unchanged.
- [ ] **Step 4: SeasonPanel v2.** Layout top-to-bottom (spec §5): season header (name +
  `closed` badge + window line + close/reopen, existing idioms) → scoreboard table →
  together section (ledger + existing footnote, head-to-head, partners — untouched) →
  "Played together" rounds list (links preserved, Remove gone). Exact renderings:
  - Window line (mono, local dates like the anchor precedent): open →
    `Since {MMM d, yyyy}`; closed → `{MMM d, yyyy} – {MMM d, yyyy}` from
    `startsAtMs`/`closedAtMs`.
  - Columns `Golfer · Rounds · Best 18 · Net/18 · Index`. Cells: golfer name via
    `GolferLink` (the roster-name link discipline); `rounds` int; `best18` →
    `` `${gross} (${vsPar(toPar, 0)})` `` else `—`; `netPer18` → `vsPar(netPer18, 1)`
    else `—`; index → `formatHandicapIndex(index)` plus, when `indexDelta` present,
    `` ` (${indexDelta >= 0 ? "+" : "−"}${Math.abs(indexDelta).toFixed(1)})` `` — else
    `—`. Rows in SERVED order (no client sort — assert structurally in the test).
  - Table footnote (the ledger-footnote idiom): `Best 18 — lowest gross, fully holed
    out · Net/18 — net vs par per 18 holes, from adjusted scores; builds at 3 rounds ·
    Index — swng index, with change over this season.`
  - When EVERY row has `rounds === 0`, one line under the table: `Rounds appear here
    automatically when members finalize them.`
  - Close-confirm teaching line becomes: `Closing ends the season — rounds finalized
    after this stay out of it, and its titles are awarded. You can reopen it later.`
  - DELETE: the picker (`openPicker`/`count`/`myRounds`/`uncounted`), per-round Remove
    (`remove`/`pendingRoundId`/`removeError`), `humanizeAppendError`, the superlatives
    section, the `GetMyRoundsResponse`/counted imports; drop the `myGolferId` prop if the
    Remove gate was its last use (update `CrewPage`'s callsite).
  - Tests: rewrite the counted/superlative tests; add — served-order structural pin,
    every dash arm, the delta sign both directions, footnote text, empty-board line,
    window line open + closed, close-confirm new copy.
- [ ] **Step 5: crewSeason.spec.ts reconciliation (compile + frozen numbers only —
  Task 4 adds the new oracles).** Delete `expectedLowestNet`/`expectAbsentMostImproved`
  and every `superlatives` assertion + the `SeasonSuperlatives` import; test 4 becomes
  "the season contains every finished round with no counting act" (create "The Golden
  Dozen" AFTER the 12 rounds via `createSeasonDirect` — the start rule reaches back;
  assert `standings.rounds` has all 12 roundIds newest-first in the new
  `{roundId, finalizedAt}` shape); DELETE test 6 (un-count/re-count — its window
  replacement lands in Task 4); tests 1–3, 5, 7, 8/8b, 9 keep every frozen assertion
  (ledger/H2H/skins/stableford/titles) — only response-shape touches (`rounds` shape, no
  `appendedBy`). Remove `appendCountedRoundDirect`/`removeCountedRoundDirect` USAGE (the
  helpers themselves die in Task 5 if unshared — grep).
- [ ] **Step 6:** `pnpm validate` → exit 0 (root e2e workspace typechecks too — fix any
  straggler imports it surfaces).
- [ ] **Step 7: Commit** — `feat(crews): the scoreboard is served — window-derived standings, superlatives and counting doors out of the wire`

---

### Task 4: E2E — frozen scoreboard oracles and the window taught on the wire

**Files:**
- Modify: `apps/web/e2e/crewSeason.spec.ts`
- Sweep: `grep -rn "counted\|season" e2e/ apps/web/e2e/` for any other surface (expected:
  none beyond crewSeason).

- [ ] **Step 1: Local oracle derivation (extend test 1, the local-verification idiom).**
  Build each member's `StoredLine[]` from the deck's local archives via
  `archiveGolferLine(archive, golferId)` + synthetic chronology (`finalizedAtMs = deck
  round order`, no `createdAtMs`), run `crewScoreboard(members, { startMs: 0 })` locally,
  and assert it against LITERAL values frozen into the spec file (run once, read the
  printed values, freeze them — the oracle is the literal, the fold is the derivation
  tool). Freeze ALL FOUR members' rows locally. Expected shape of the truth (verify,
  don't assume): 12 rounds each; `best18` present; `netPer18` present (≥3); `index`
  present; `indexDelta` ABSENT for everyone (no pre-window lines).
- [ ] **Step 2: Live assertions, roster-scoped.** Test 5 (roster is Al alone at that
  point): `standings.scoreboard` is exactly Al's frozen row (plus his roster name).
  Test 8 (Bo joins late): the board now carries Bo's frozen row too — the
  aggregation-scope law reaching the scoreboard. Live lines differ from the local
  synthesis only in real timestamps, which no column reads.
- [ ] **Step 3: New final test — "the window on the wire."** Close "The Golden Dozen"
  (organizer) → play a 13th round shared by Al+Bo with NO games (join + scores +
  finalize) → closed standings: `rounds` still the 12, ledger byte-identical (the window
  end held) → reopen → `rounds` now 13 and the ledger STILL byte-identical (a gameless
  round contributes nothing — the together-fold's own truth) while Al/Bo's scoreboard
  `rounds` tick to 13. Leave the season open at suite end (nothing follows it).
- [ ] **Step 4:** `pnpm validate` → exit 0 (the spec compiles; live runs are close-out).
- [ ] **Step 5: Commit** — `test(e2e): frozen scoreboard oracles + close/reopen window pins on the golden deck`

---

### Task 5: The deletion wave — counting apparatus and superseded superlatives, whole

Everything below is consumerless after Task 3. One commit.

**Files:**
- Delete: `packages/application/src/crews/appendCountedRound.ts`,
  `removeCountedRound.ts` (+ their slice tests)
- Modify: `packages/application/src/ports/crewStore.ts` (delete `CountedRound`,
  `addCountedRound`, `removeCountedRound`, `listCountedRounds`),
  `packages/application/src/index.ts`
- Modify: `packages/adapters-dynamodb/src/createDynamoCrewStore.ts` (delete the three
  implementations + the `countedRoundSk` WRITE vocabulary; KEEP the listSeasons
  client-side filter — it is the orphan tolerance now, re-comment it as such)
- Modify: the crewStore contract tests (delete counted cases; ADD the orphan pin — insert
  a raw `SEASON#<id>#ROUND#<id>` item, `listSeasons` excludes it)
- Modify: `packages/lambda/src/http/routes.ts` (delete both routes + imports),
  `packages/lambda/src/http/dispatch.test.ts` (route counts 42→40 HTTP / 44→42 total),
  `packages/lambda/src/compositionRoot.ts` (drop the two use-case wirings)
- Modify: `packages/contracts/src/crews.ts` (delete `CountedRoundView`,
  `countedRoundViewSchema`, `AppendCountedRoundRequest/Response`,
  `RemoveCountedRoundResponse`, `SeasonSuperlatives` + `seasonSuperlativesSchema` and its
  sub-schemas — `partnerStandingRecordSchema` STAYS)
- Modify: `packages/domain/src/crew/analytics.ts` (delete `netAverages`, `NetAverage`,
  `mostImproved`, `ImprovementEntry` + their tests; `partnerRecords`, `stablefordTitle`,
  `configForResult` stay), `packages/domain/src/index.ts`
- Sweep: `apps/web/e2e/` helper file (delete `appendCountedRoundDirect`/
  `removeCountedRoundDirect` if now unused)

- [ ] **Step 1:** Delete in the order listed (routes last so nothing dangles mid-edit).
- [ ] **Step 2: Grep gates** — each must return ONLY the adapter tolerance filter/comment
  and its contract pin:
  `grep -rn "ountedRound" packages apps e2e --include="*.ts" --include="*.tsx"`;
  and these must return NOTHING:
  `grep -rn "netAverages\|NetAverage\|mostImproved\|ImprovementEntry\|SeasonSuperlatives\|round-already-counted" packages apps e2e --include="*.ts" --include="*.tsx"`
  (the counted-mutation `season-closed` throw sites die with their files; `closeSeason`'s
  comment referencing them gets updated in place).
- [ ] **Step 3:** `pnpm validate` → exit 0; `pnpm test:contract` → green (counted cases
  gone, orphan pin in).
- [ ] **Step 4: Commit** — `chore(crews): delete the counting apparatus and superseded superlatives whole`

---

### Close-out (controller-run — NOT a task)

`pnpm validate` → `pnpm deploy:beta` LAMBDA-FIRST → `publish:web:beta` immediately (the
old bundle fails the new standings parse on crew pages until refresh — accepted symmetric
window, spec §4) → `pnpm e2e:beta` ×2 → crewSeason live ×2 (frozen numbers + new oracles)
→ full `pnpm e2e:field` → an adversarial USE pass on deployed beta.swng.golf: a real
crew, a member finalizes a round having never opened the crew page, the board is alive;
close/reopen live → docs sweep (CLAUDE.md arc paragraph; `docs/product.md` crew/ledger
section amended to the watching-crew model; spec status line). NO wipe.
