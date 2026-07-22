# Crew Seasons Are The Record Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A season carries two chosen, required, visible dates (start + end); close becomes
pure ceremony with the title served on the season; the derived-window machinery and the
All-time surface are deleted; the crew name and season name/dates become editable; and the
crew page's tables and roster say what's true (the dead "account" badge removed).

**Architecture:** One new domain conversion (`seasonWindowOf`: a required date pair → the
existing ms `SeasonWindow`, so every fold is byte-untouched); `CrewSeason` swaps
`startsAtMs`/`closedAtMs` for required `startsAt`/`endsAt` date strings; new organizer-only
update-season and update-crew routes; the records route/surface and the vestigial
`claimed` field are deleted. Spec (binding):
`docs/superpowers/specs/2026-07-22-crew-seasons-are-the-record-design.md`.

## Global Constraints

- `pnpm validate` green at EVERY commit; local `main`, never push.
- **Frozen-deck law:** crewSeason's hand-designed numbers (H2H 5W-5L-2H, skins 54,
  stableford 430/430/435/435, the scoreboard literals +0.2/−0.2/71(−1)) byte-identical.
- Every fold in `crew/scoreboard.ts`, `crew/ledger.ts`, `crew/analytics.ts` is UNTOUCHED —
  only the window's *derivation* changes. The web computes no golf result; add
  `seasonWindowOf` to the ESLint fence banlist.
- Dates are `"YYYY-MM-DD"` strings end-to-end, REQUIRED on a season (no absent/clearable
  bound — the owner's footgun ruling, 2026-07-22). NEVER rendered through a local-time
  `Date` conversion (the "Dec 31, 2025" artifact class). Wire pins the format:
  `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)`.
- Close/reopen flip `status` ONLY. Which rounds count never changes with either verb.
- Legacy tolerance (one day of beta rows only): adapter folds a stored `startsAtMs` → its
  UTC date string and synthesizes `endsAt` = Dec 31 of that same UTC year (those rows were
  the year-shaped auto-seasons); `closedAtMs` ignored; contract-pinned. No migration.
- Route count: HEAD = 40 HTTP / 42 total. After Task 2 = 42/44 (two PUTs added). After
  Task 3 = **41/43** (records route deleted). Pin the transient count in each task.
- Deploy (close-out, controller-run): LAMBDA-FIRST, `publish:web:beta` immediately.

---

### Task 1: Domain — `crew/seasonWindow.ts`

**Files:** create `packages/domain/src/crew/seasonWindow.ts` + `seasonWindow.test.ts`;
modify `packages/domain/src/index.ts`; modify `eslint.config.mjs` (fence banlist gains
`seasonWindowOf`).

**Produces (Task 2 + Task 3 consume verbatim):**

```ts
import type { SeasonWindow } from "./scoreboard.js";

export interface SeasonBounds {
  readonly startsAt: string; // "YYYY-MM-DD" — required
  readonly endsAt: string;   // "YYYY-MM-DD" — required
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// A season bound is a CALENDAR DATE, compared against the UTC date of a round's played
// time (spec §1). Known, accepted edge: a late-evening local round near a boundary can
// land on the neighboring UTC day — one rule, no timezone machinery.
//
// PROGRAMMER GUARD, not a DomainError (spec §1, review F-err): the wire regex gates every
// write path, so a malformed string here means a corrupted stored row — a plain Error, the
// posture of the adapter's own seasonId "#" guard. The round-trip check (not just the shape
// regex) rejects a semantically-invalid date (2026-02-30 rolling to Mar 2) instead of
// windowing to the wrong instant (review G6).
const isoOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const utcDayStartMs = (date: string): number => {
  if (!DATE.test(date)) throw new Error(`season bound not a YYYY-MM-DD date: "${date}"`);
  const [y, m, d] = date.split("-").map(Number);
  const ms = Date.UTC(y!, m! - 1, d!);
  if (isoOf(ms) !== date) throw new Error(`season bound is not a real calendar date: "${date}"`);
  return ms;
};

export const seasonWindowOf = (bounds: SeasonBounds): SeasonWindow => ({
  startMs: utcDayStartMs(bounds.startsAt),
  endMs: utcDayStartMs(bounds.endsAt) + 86_400_000 - 1, // last ms of the end day
});
```

Note: the user-facing `startsAt > endsAt` ordering check is NOT here — it lives in the
`createSeason`/`updateSeason` use cases as `ApplicationError("invalid-season-window")` →
400 (Task 2). `seasonWindowOf` only converts and programmer-guards.

- [ ] **Step 1: tests** (hand-pinned, composed with the existing `inWindow`):
  - `seasonWindowOf({startsAt:"2026-01-01", endsAt:"2026-12-31"})` →
    `{startMs: Date.UTC(2026,0,1), endMs: Date.UTC(2026,11,31)+86_399_999}`.
  - a `StoredLine` played at exactly `endMs` is `inWindow`; at `endMs + 1` is not; at
    `startMs - 1` is not (reuse `inWindow` from `scoreboard.js`, don't re-derive).
  - single-day season (`startsAt === endsAt`) contains a line played that UTC day.
  - malformed SHAPE (`"2026-1-1"`, `"garbage"`, `""`) throws `Error`; semantically-invalid
    (`"2026-02-30"`, `"2026-13-01"`) throws `Error` too (the round-trip check — NOT silently
    windowed to a rolled-over instant).
- [ ] **Step 2:** export from `index.ts`; add `seasonWindowOf` beside `crewScoreboard` in
  the eslint fence banlist.
- [ ] **Step 3:** `pnpm validate` exit 0. Commit:
  `feat(domain): seasonWindowOf — a season's chosen dates become the fold's window`

---

### Task 2: Store + verbs — the user states the period, and can correct it

**Files:**
- Modify: `packages/application/src/ports/crewStore.ts` (`CrewSeason` per spec §1 — swap
  `startsAtMs`/`closedAtMs` for required `startsAt`/`endsAt`).
- Modify: `crews/createSeason.ts`, `crews/createCrew.ts`, `crews/closeSeason.ts`.
- Create: `crews/updateSeason.ts`, `crews/updateCrew.ts`.
- DELETE: `crews/seasonStart.ts` + `seasonStart.test.ts`.
- Modify: `packages/application/src/errors.ts` (+ `invalid-season-window`);
  `packages/lambda/src/http/errorMapping.ts` (400) + its test.
- Modify: `packages/contracts/src/crews.ts` (season view + create/update requests).
- Modify: `packages/lambda/src/http/routes.ts` (+ `PUT /crews/{crewId}/seasons/{seasonId}`,
  + `PUT /crews/{crewId}`); `compositionRoot.ts`;
  `packages/adapters-dynamodb/src/createDynamoCrewStore.ts`.
- Modify: **`apps/infra-cdk/lib/swngStack.ts`** — the hand-maintained `HTTP_ROUTES` const
  (review G1): ADD the two `PUT` entries here, or `routesParity.test.ts` (which asserts
  `HTTP_ROUTES` === `buildRoutes` exactly) fails and CDK never wires the routes. No
  RouteSettings method-set change (`PUT` is already used by `PUT /me`, `PUT /courses/{id}`).
- Modify: route pins — `swngStack.test.ts` (42 HTTP / 44 total TRANSIENT after this task),
  `routesParity.test.ts`, `dispatch.test.ts`.
- Tests: crewStore contract tests; the crew slice tests.

Semantics (exact):
- `CrewSeason`: `{ seasonId, name, status, createdAtMs, startsAt, endsAt }`. No `closedAtMs`.
- `createSeason`: body `{name, startsAt, endsAt}`; validate name (existing 1–60);
  `if (command.startsAt > command.endsAt) throw ApplicationError("invalid-season-window")`
  (plain string compare — the `YYYY-MM-DD` format is ordinal). No derivation;
  `seasonStart.ts` is deleted.
- `createCrew`: auto-season stays the current calendar year but now with VISIBLE dates —
  `{ name: String(new Date(now).getUTCFullYear()), status: "open", createdAtMs: now,
  startsAt: `${year}-01-01`, endsAt: `${year}-12-31` }` (keep the `clock` dep).
- `closeSeason`: `{ ...season, status: "closed" }` — the `closedAtMs` stamp and the `Clock`
  dep REVERT OUT (they were yesterday's addition; the window no longer moves on close).
  `reopenSeason`: unchanged (status flip only — nothing to clear now).
- `updateSeason` (new): guard order EXACTLY `closeSeason`'s (requireCrewMember → organizer
  → season exists → `season-already-closed` when closed, message "reopen it to edit");
  body `{name?, startsAt?, endsAt?}` — absent leaves a field, no null; build the candidate
  by spreading over the stored season, then apply the SAME name + `startsAt > endsAt`
  validation before `putSeason`; return `{season}`.
- `updateCrew` (new): guard `requireCrewMember → organizer` (no season lookup); body
  `{name}`; `validateCrewName(command.name)` (domain, existing); rename is just
  `{...crew, name}` (no domain rename op exists); write via the store's `put` reusing the
  **`retryOnConflict` idiom** (`removeCrewMember.ts:31` — a get→mutate→conditional-put
  loop, NOT a naive get-then-put); return the refreshed `CrewView` via `toCrewView` (still
  async here — `claimed` isn't deleted until Task 3).
- Contracts: `crewSeasonViewSchema` gains `startsAt`/`endsAt` (regex-pinned, required),
  DROPS `startsAtMs`/`closedAtMs`; `createSeasonRequestSchema` gains the two required
  dates; new `updateSeasonRequestSchema` (`.strict()`, all-optional) and
  `updateCrewRequestSchema` (`.strict()`, `{name}`).
- Adapter (review G7): add UTC helpers `isoDate(ms) = new Date(ms).toISOString().slice(0,10)`
  and `utcYear(ms) = new Date(ms).getUTCFullYear()` (UTC to match `seasonWindowOf`); the
  `SeasonItem` interface + `putSeason`'s field-by-field builder must be rewritten to store
  `startsAt`/`endsAt` and STOP writing `startsAtMs`/`closedAtMs`; `createSeason` keeps
  `createdAtMs: clock.now()`. Read-fold legacy at the ONE `seasonOf` mapping —
  `startsAt: item.startsAt ?? (item.startsAtMs !== undefined ? isoDate(item.startsAtMs) :
  undefined)` and `endsAt: item.endsAt ?? (item.startsAtMs !== undefined ?
  `${utcYear(item.startsAtMs)}-12-31` : undefined)`; `closedAtMs` never read. COMMENT the
  fold's assumption (review G8): a legacy CLOSED season that was `[start, closedAtMs=Nov 1]`
  widens to Dec 31 — accepted only because beta rows are year-shaped auto-seasons and beta
  is disposable; NOT a general migration.

- [ ] **Contract tests:** date round-trips (create → read both dates); a raw legacy item
  (`startsAtMs` + `closedAtMs`, no date strings) reads as its UTC start date + Dec-31 end;
  an `updateSeason`/`putSeason` over it drops the old attributes (whole-item put).
- [ ] **Slice tests:** create requires both dates + `invalid-season-window` on inversion;
  `createCrew` → auto-season with `name === String(year)` and both dates; `closeSeason`
  flips status only (assert NO `closedAtMs` key anywhere); `updateSeason` partial update,
  organizer-403, closed-409, inverted-window-400; `updateCrew` renames, organizer-403,
  invalid-name-400.
- [ ] `pnpm validate` + `pnpm test:contract` green. Commit:
  `feat(crews): seasons carry chosen required dates + editable crew/season — tiling rule and closedAtMs out`

---

### Task 3: Reads + web + the deletions (ONE atomic commit)

**Files:**
- Modify: `packages/application/src/crews/getSeasonStandings.ts` (window via
  `seasonWindowOf`; `title?` on close).
- Modify (review G2 — the `toCrewView` dead-dependency ripple): `crews/crewView.ts` drops
  the async `claimed` sub-lookup and its `golferStore` dep → `toCrewView` becomes a pure
  SYNC mapper; then remove the now-dead `golferStore`/`await` at EVERY caller —
  `crews/createCrew.ts`, `crews/joinCrewByInvite.ts` (2 sites), `crews/transferOrganizer.ts`,
  `crews/getCrew.ts`, `crews/removeCrewMember.ts`, AND Task 2's new `crews/updateCrew.ts`.
  (Verify no other reader of `claimed` exists — review confirmed none but the roster badge.)
- DELETE: `crews/getCrewRecords.ts` + tests + the route `GET /crews/{crewId}/records`
  (from `routes.ts` AND `apps/infra-cdk/lib/swngStack.ts`'s `HTTP_ROUTES` const — review
  G1) + `CrewRecordsResponse`/schema + `apps/web/src/crews/CrewRecordsSection.tsx` + test +
  its api-client fn (+ api.test coverage).
- Modify: `packages/contracts/src/crews.ts` — `SeasonStandingsResponse` header fields
  `startsAtMs`/`closedAtMs` → `startsAt`/`endsAt`, gains
  `title?: { golfers: readonly { golferId: GolferId; name: string }[] }`;
  `CrewMemberView` DROPS `claimed` (+ its schema field).
- Modify: `apps/web/src/crews/SeasonPanel.tsx` + test, `CrewPage.tsx` + test,
  `compositionRoot.ts`, route pins back to **41 HTTP / 43 total** (`swngStack.test.ts`,
  `routesParity.test.ts`, `dispatch.test.ts`),
  `apps/web/e2e/crewSeason.spec.ts` (reconciliation — mostly type/field, BUT the table
  aria-label locators change too; see the heading bullet).

Semantics:
- `getSeasonStandings`: `const window = seasonWindowOf(season)` replaces the hand-built
  window; header carries `startsAt`/`endsAt`; when `season.status === "closed"`, build
  `title` from the SAME roster-filtered ledger already in scope via `stablefordTitle`
  (absent when open or when it returns `[]`), names via `nameByGolfer`.
- SeasonPanel copy (exact):
  - VISIBLE headings (review G4 — the tables are aria-labelled but unnamed on screen
    today; the owner's complaint is a missing visible heading): render `<h4>Standings`
    above the scoreboard and `<h4>Games together` above the ledger (the existing
    Head-to-head/Partners `<h4>` idiom), and update each table's `aria-label` to match
    (`"Scoreboard"`→`"Standings"`, `"Season standings"`→`"Games together"`). These
    aria-labels are LOCATORS in `SeasonPanel.test.tsx` and `crewSeason.spec.ts` — a real
    string-move, list every touched locator (the repeated string-breakage lesson).
  - games empty state → `Appears when members play a round together.`; the old "Standings
    build automatically once members play together." line is DELETED.
  - window line: a small local `YYYY-MM-DD` → `"Jan 1 – Dec 31, 2026"` formatter (split
    the strings, month-name table, NO `new Date` local conversion) — always both dates.
  - closed season with `title` → a line under the header: `Title — {names joined " · "}`.
  - create-season form: name prefilled `String(currentYear)`, two `type="date"` inputs
    prefilled `{year}-01-01` / `{year}-12-31`, submitted always (both required); PLUS one
    helper line naming the lifetime path (review Q1): `Want an all-time board? Give it wide
    dates.`
  - season edit (organizer, OPEN seasons): an `Edit` (btnQuiet) swapping the header for
    name + two date inputs + Save/Cancel (the roster-row edit idiom), one PUT then reload
    — new api fn `updateSeason`.
  - close-confirm teaching line (review Q2 — disclose the moving title): `Closing awards
    this season's titles and locks its dates. If its end date is still ahead, standings
    keep updating until then — reopen anytime to make changes.`
- CrewPage:
  - DELETE the `{member.claimed && <span className={badge}>account</span>}` render; keep
    the `organizer` badge.
  - crew-name edit (organizer): an `Edit` beside the `<h1>` crew name → an input +
    Save/Cancel, one `PUT /crews/{crewId}` via new api fn `updateCrew`, then reload.
  - REWORD the remove-member confirm line (review G3 — it still says "counted", the exact
    stale vocabulary, and is wrong under the roster-filter model): `CrewPage.tsx`'s "…Their
    rounds stay counted; their standings return if they're invited back." →
    `Their rounds stay on their own record; their crew standings return if they're invited
    back.`
- Whole-tree copy grep: `grep -rn "counted" apps/web/src` → zero user-facing hits (the
  remove-member line above is why this gate would otherwise fail).
- crewSeason.spec reconciliation: records-helper imports/assertions out (Task 4 rebuilds
  those beats); `startsAtMs` → `startsAt`; the table-name locators updated per the heading
  bullet; DELETE the `claimed` assertions (e.g. `crewSeason.spec.ts:388`
  `expect(boMember?.claimed).toBe(true)` is an ASSERTION, remove it — not just a fixture
  edit) and strip `claimed` from `SeasonPanel.test.tsx`/`CrewPage.test.tsx` fixtures.

- [ ] `pnpm validate` exit 0. Commit:
  `feat(crews): the season is the record — title on the season, honest table names, all-time surface and the dead account badge deleted`

---

### Task 4: E2E — declared windows, close moves nothing

**Files:** `apps/web/e2e/crewSeason.spec.ts` (+ `support.ts`: delete
`getCrewRecordsDirect`, add `updateSeasonDirect`/`updateCrewDirect` for the beats that
need them).

- [ ] Crew-creation test asserts the auto-season's `name === String(year)` AND both
  visible dates (`{year}-01-01` / `{year}-12-31`), where `year = new
  Date().getUTCFullYear()` — NEVER a literal.
- [ ] "The Golden Dozen" is created with the CURRENT UTC year's dates (review G5 — a
  year-fragility time bomb): `const y = new Date().getUTCFullYear()` →
  `{startsAt: `${y}-01-01`, endsAt: `${y}-12-31`}`. The deck's rounds are finalized LIVE
  "now", so a hardcoded `"2026-..."` window would empty the board (and fail every frozen
  assertion) the moment the calendar rolls to 2027. The deck still lands inside the current
  year; every frozen assertion (scoreboard literals included) byte-identical.
- [ ] The old records-route beats become season-title beats: close "The Golden Dozen" →
  its OWN standings carry `title` = the {Al, Bo} crown (same frozen numbers as the retired
  records assertion); reopen → `title` absent.
- [ ] Window pins (replacing the retired close-moves-the-window test):
  (a) on the year season, close → play a shared gameless round (today is inside the year)
  → the CLOSED season's standings INCLUDE it (rounds +1, ledger byte-identical — close
  moved nothing; the exact inverse of the retired pin); reopen → identical.
  (b) create a season with BOTH dates in the past (a fixed past year, not `Date.now`
  math sprinkled inline) → its standings contain ZERO rounds, an all-dash scoreboard with
  `rounds: 0` rows — date exclusion proven live.
- [ ] Projector-lag discipline unchanged: polls wait on COUNTS only.
- [ ] `pnpm validate` exit 0; local-verification grep-run if creds-free. Commit:
  `test(e2e): declared windows on the golden deck — titles on the season, close moves nothing`

---

### Close-out (controller-run — NOT a task)

validate → `deploy:beta` LAMBDA-FIRST → `publish:web:beta` → `e2e:beta` ×2 → crewSeason
live ×2 → full `e2e:field` → a USE pass on deployed beta.swng.golf (the prefilled create
form; editing a season's dates AND the crew name; the year season's visible dates;
"Standings"/"Games together" names; the roster with NO "account" badge; close → the title
on the season) → docs sweep (CLAUDE.md; the 2026-07-21 spec gets a superseded-by pointer;
product.md §6 already describes the watching crew — no change). NO wipe.
