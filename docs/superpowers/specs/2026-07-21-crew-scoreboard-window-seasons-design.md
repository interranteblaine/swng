# The crew watches — window seasons and the automatic scoreboard

> **PARTIALLY SUPERSEDED (2026-07-22) by `2026-07-22-crew-seasons-are-the-record-design.md`.** The
> core here stands — the crew watches, seasons are time windows, the scoreboard + together-records
> are read folds. What changed: a season's window is no longer the derived `startsAtMs` + `Jan 1`
> tiling rule; it is now two CHOSEN, required, visible dates (`startsAt`/`endsAt` strings, edited via
> `PUT /crews/{crewId}/seasons/{seasonId}`), and a season's Live/Final state is derived from `endsAt`
> alone with the crowning apparatus (`status`, `closedAtMs`, `stablefordTitle`, the All-time
> `getCrewRecords` surface) deleted. Read the successor for the season model; this spec remains
> authoritative for the scoreboard/together-records folds it introduced.

> Status: **owner-approved design** (2026-07-21, "ok. let's spec and plan" on the pitched
> model). Origin: an owner field report — crews are "lacking and clunky" — plus a Codex
> proposal (automatic crew scoreboard) that this design adjudicates rather than adopts.
> The diagnosis: **the crew only knows what you tell it.** Every member must manually
> count each finished round into a season — a per-round, per-member chore nobody performs
> after golf — so the crew page sits empty while the app already knows everything (any
> signed-in golfer can open any member's record page today, `GET /golfers/{golferId}`,
> navigation spec §6b). The crew is currently less informed than a stranger tapping your
> name.

## 1. The principle (binding)

**The crew watches; members just play.** A crew is a grouping (owner ruling 2026-07-13) —
an aggregation scope over records that are already visible. It READS its members' golf; it
is never FED it. No member performs any per-round act for the crew, ever. Everything below
is derivation-on-read from the golfer projection lines and the sealed snapshots; nothing
derived is stored (the analytics binding model's spirit holds — the one amendment to its
letter is that a season now stores a **window**, not a list of rounds).

Disclosure is unchanged by construction: the scoreboard rearranges facts a crew-mate can
already read on your golfer page. That — not "joining implies consent" — is why automatic
is right and a per-round "share with crew?" prompt would be pure chore protecting nothing.

## 2. A season is a time window (binding)

`CrewSeason` (application port, `ports/crewStore.ts`) becomes:

```ts
export interface CrewSeason {
  readonly seasonId: string;          // unchanged (opaque, server-minted, no "#")
  readonly name: string;              // unchanged
  readonly status: "open" | "closed"; // unchanged
  readonly createdAtMs: number;       // unchanged
  readonly startsAtMs: number;        // NEW — window start, fixed at creation
  readonly closedAtMs?: number;       // NEW — window end; set by close, cleared by reopen
}
```

- **Window** = `[startsAtMs, closedAtMs ?? ∞]`, both ends inclusive.
- **A round is in the season** iff its **played date** — `createdAtMs ?? finalizedAtMs`
  from the golfer projection line (the `roundLabel`/chart-anchor precedent: played date
  first) — falls in the window AND its golfer is on the **current roster**. Tenure is
  ignored (no `joinedAt` exists; leave drops your rows, rejoin restores them — the
  standing aggregation-scope law, exactly what crewSeason test 8 already pins).
- **Start rule (fixed at creation, stored, never recomputed):**
  `startsAtMs = max(latest closedAtMs among this crew's closed seasons, Jan 1 UTC of the
  creation year)`. No closed seasons → Jan 1 UTC. One sentence for humans: *a new season
  picks up where the last closed one ended, or January 1.* This makes sequential seasons
  tile (Spring Cup closed in June → Fall Cup starts in June) and makes
  memorialize-after-the-fact work (a season created AFTER the rounds were played still
  contains them — the window reaches back to January 1). `CreateSeasonRequest` stays
  `{name}` — no date picker, no wire field, YAGNI.
- **Close** (`closeSeason`) sets `closedAtMs = clock.now()` in the same `putSeason` that
  flips `status` (the use case gains a `Clock` dep). **Reopen** deletes `closedAtMs` —
  reopening is lossless by construction, as before, and a round played after a close
  ENTERS the season if it's reopened (the window is open again; that is the honest
  reading and it is pinned, not apologized for). Overlapping open windows are possible
  after a reopen — a season is a lens, not accounting; documented, never guarded.
- **Every crew starts alive:** `createCrew` auto-opens the crew's first season, named for
  the creation year (`"2026"`), `startsAtMs` = Jan 1 UTC of that year — the same start
  rule degenerated. A brand-new crew's board already shows the season its members have
  played. `createCrew` gains a `Clock` dep; `CreateCrewResponse` is unchanged (the season
  arrives via `listSeasons` as always).
- **Legacy fold:** stored season rows without `startsAtMs` read as
  `startsAtMs = createdAtMs` (adapter-level, contract-pinned — the no-source→swng
  precedent). No migration, no wipe.

### 2b. The counting apparatus is deleted whole

`CountedRound`, `CrewStore.addCountedRound/removeCountedRound/listCountedRounds`, the
adapter implementations and `countedRoundSk` write vocabulary, the
`appendCountedRound`/`removeCountedRound` use cases, both routes
(`POST /crews/{crewId}/seasons/{seasonId}/rounds`, `DELETE
.../rounds/{roundId}` — HTTP routes 42→40, total 44→42), the wire schemas
(`CountedRoundView`, `AppendCountedRoundRequest/Response`,
`RemoveCountedRoundResponse`), the error vocabulary that existed only for them
(`round-already-counted`, the counted-mutation `season-closed` 409 — close still gates
titles; there is simply nothing left to mutate), and the web doors (SeasonPanel's
"Count a round…" picker, the per-round Remove, `humanizeAppendError`). Stored
`SEASON#<id>#ROUND#<id>` items become orphans, tolerated forever: `listSeasons` already
filters them out client-side (contract-pinned; the `standingGame` precedent — never a
migration).

## 3. One window feeds two boards (binding)

### 3a. The scoreboard — every member, from their own lines

A new domain module `crew/scoreboard.ts` (the `crew/analytics.ts` idiom: pure folds,
never a fetcher):

```ts
export interface SeasonWindow { readonly startMs: number; readonly endMs?: number; }

// The ONE played-date rule (spec §2) — exported so application derives shared rounds
// with the same clock the scoreboard windows by.
export const playedAtMs = (line: { finalizedAtMs: number; createdAtMs?: number }): number;
export const inWindow = (window: SeasonWindow, line: StoredLine): boolean; // inclusive both ends

export interface ScoreboardLine {
  readonly golferId: GolferId;
  readonly rounds: number;                                        // windowed line count
  readonly best18?: { readonly gross: number; readonly toPar: number };
  readonly netPer18?: number;                                     // one decimal
  readonly index?: number;                                        // current swng index
  readonly indexDelta?: number;                                   // one decimal, signed
}

// `lines` per member: the FULL career, chronologically sorted (sortLines upstream —
// golferMetrics' own contract); the fold windows internally.
export const crewScoreboard = (
  members: readonly { readonly golferId: GolferId; readonly lines: readonly StoredLine[] }[],
  window: SeasonWindow,
): readonly ScoreboardLine[];

// RoundIds where >=2 DISTINCT members hold an in-window line — "we played together" as a
// derived fact, never a curated one. No order promised.
export const sharedRoundIds = (
  members: readonly { readonly golferId: GolferId; readonly lines: readonly StoredLine[] }[],
  window: SeasonWindow,
): readonly RoundId[];
```

Column semantics (exact):

- **rounds** — count of the member's in-window lines, 9s and 18s alike. Every current
  member gets a row, including `rounds: 0` — the board is the roster's presence, and an
  all-dash row is the invitation.
- **best18** — lowest `grossOf(line)` among in-window, `fullyHoledOut`, 18-hole lines;
  `toPar = gross − line.par`; ties keep the earlier played round (the `bestsOf`
  strict-`<` precedent); absent when no qualifying line.
- **netPer18** — over in-window lines with `ags` present:
  `sum(ags − courseHandicap − par) / sum(holes) × 18`, `roundHalfUp` to one decimal.
  AGS-based deliberately (every line has one, rated or unrated, picked-up holes already
  absorbed at net double bogey) and vs-par deliberately (a raw gross averaged across
  par-70s/72s and 9s/18s is a dishonest number — the per-18 normalization is the
  `typicalEighteen` precedent). **Floor: 3 qualifying lines** (the `netAverages`
  refusing-to-draw-noise floor carried forward), else absent.
- **index** — `golferMetrics(careerLines).swngIndex?.value` (the career index, never
  windowed — an index is always the whole record).
- **indexDelta** — `index − golferMetrics(lines with playedAtMs < window.startMs)
  .swngIndex?.value`, one decimal; absent unless BOTH ends exist. Negative = improved.
- **Sort (total, domain-owned — the aggregateSeason precedent):** `netPer18` asc,
  absent-last → `rounds` desc → `golferId` asc.

### 3b. Together records — the existing folds over derived shared rounds

`ledger`/`headToHead` (`aggregateSeason` over `rosterFilteredContribution`),
`partnerRecords`, and `stablefordTitle` keep folding archives EXACTLY as today — the only
change is where the round set comes from: **`sharedRoundIds` of the window** instead of
the stored counted list. You cannot accidentally play a match with a crew-mate; a shared
roundId IS the fact "we played together."

- `getSeasonStandings`: ONE `listLines` per roster member (`Promise.all` — the fetch the
  mostImproved boundary code already performed) feeds the scoreboard, the shared-round
  derivation, AND the index boundaries; `snapshots.getMany(sharedRoundIds)` feeds the
  together folds. The response's `rounds` list becomes the shared rounds, newest-first by
  `finalizedAtMs`, rendered under the heading **"Played together"** (which also teaches
  why the list is shorter than the rounds column sums).
- `getCrewRecords` (gains a `projectionStore` dep): all-time = shared rounds EVER (no
  window) from the same one-fetch derivation; `titles` = per CLOSED season, the shared
  rounds of that season's window (from the one union `getMany`), folded as today.
  `CrewRecordsResponse` is shape-unchanged.

### 3c. The superlatives are superseded, not kept

`SeasonSuperlatives` (`lowestNet`, `mostImproved`) and the domain folds that existed only
for them (`netAverages`, `NetAverage`, `mostImproved`, `ImprovementEntry`) are DELETED.
The scoreboard shows every member's net and index change — a board where everyone has a
line supersedes winner-only callouts; keeping both would put two differently-defined net
numbers on one page. `stablefordTitle` stays (titles on close are a distinct honor, not a
column).

## 4. Wire (exact)

`CrewSeasonView` gains required `startsAtMs` and optional `closedAtMs` — the Ms names
deliberately: "CrewSeason IS the wire CrewSeasonView shape field-for-field — no separate
mapping" is that wire's standing rule (createSeason.ts's own comment; `createdAtMs`
already rides it), and legacy rows are served safe by the adapter fold (§2). The
standings response header carries the same two names for the same reason. The shared
rounds list keeps `finalizedAt` — the successor of `CountedRoundView`'s existing wire
name. `SeasonStandingsResponse` becomes:

```ts
export interface ScoreboardRow { // ScoreboardLine + the roster's own name (nameByGolfer precedent)
  readonly golferId: GolferId; readonly name: string; readonly rounds: number;
  readonly best18?: { readonly gross: number; readonly toPar: number };
  readonly netPer18?: number; readonly index?: number; readonly indexDelta?: number;
}
export interface SharedRoundView { readonly roundId: RoundId; readonly finalizedAt: number; }
export interface SeasonStandingsResponse {
  readonly seasonId: string; readonly name: string; readonly status: "open" | "closed";
  readonly startsAtMs: number; readonly closedAtMs?: number;
  readonly scoreboard: readonly ScoreboardRow[];       // REQUIRED, replaces superlatives
  readonly rounds: readonly SharedRoundView[];         // shared rounds, newest-first
  readonly ledger: readonly SeasonStandingLine[];      // unchanged
  readonly headToHead: readonly HeadToHeadRecord[];    // unchanged
  readonly partners: readonly PartnerStandingRecord[]; // unchanged
}
```

No new routes; two deleted (§2b). **Deploy is lambda-first** and `publish:web:beta`
follows immediately: an old bundle parsing the new response fails on the missing required
`superlatives` until refresh (crew pages only — the record-redesign symmetric-window
precedent, accepted for beta), and its counting doors 404 against deleted routes for the
same window.

## 5. Web (`apps/web/src/crews/`)

`SeasonPanel` reorders to: season header (name, `closed` badge, window dates, close/reopen
— all existing idioms) → **the scoreboard table** (leads; mono numbers; `best18` rendered
`"79 (+7)"` history-row style, vs-par and delta through the existing signed-number
presentation discipline — the whole-tree grep gate applies, no new carve-outs) → the
together section exactly as today (ledger + footnote, head-to-head, partners) → the
"Played together" rounds list (links, no Remove). Deleted: the picker, Remove,
superlatives block, `humanizeAppendError`, the `GetMyRounds` import. Copy:

- Scoreboard footnote (table-scoped, the ledger-footnote precedent): net and delta
  definitions in one line, including the 3-round floor.
- When every row has `rounds: 0`: "Rounds appear here automatically when members finalize
  them." — the model taught in one sentence, shown only when the board is empty.
- Close confirm teaching line becomes: "Closing ends the season — rounds finalized after
  this stay out of it, and its titles are awarded. You can reopen it later."
- The existing gameless-together copy ("standings build from games between current
  members") stays — still exactly true.

`CrewPage`/`CrewCreatePage`/`CrewRecordsSection`: no structural change (records response
is shape-unchanged; the auto-season simply appears in the picker).

## 6. Out of scope (recorded)

- **Tenure filtering** (Codex's "rounds played while a member") — rejected: no `joinedAt`
  exists, leave/rejoin becomes ambiguous, current-roster pure aggregation is standing law.
- **A second, manually-curated season mode** (Codex's "formal seasons can retain explicit
  selection") — rejected: two counting models is the bloat this repo keeps deleting. A
  designated-rounds competition, if ever real, is a future *event* concept.
- **Avg gross column** — rejected: dishonest across mixed pars/hole-counts (§3a).
- **Friends system / activity feed** — out, agreed with the Codex proposal.
- **All-time scoreboard** — the all-time section stays together-records + titles; career
  solo stats live on the golfer's own page.

## 7. Testing

- **Domain (`crew/scoreboard.test.ts`):** the worked netPer18 fixture (85/12/72-par-18 →
  +1; 41/5/36-par-9 → 0; 80/8/70-par-18 → +2; sum 3 over 45 holes → **1.2**); the 3-line
  floor (2 qualifying → absent); best18 min-gross with earlier-tie; window edges inclusive
  at BOTH `startMs` and `endMs`; index/indexDelta as a reuse-proof against `golferMetrics`
  (never a hand re-derivation of the engine); zero-round members present; sort totality;
  `sharedRoundIds` distinct-member dedupe.
- **Contract (`crewStore`):** `startsAtMs`/`closedAtMs` round-trip; legacy row folds
  `startsAtMs = createdAtMs`; orphan counted items ignored by `listSeasons`; counted
  methods gone.
- **Slices:** createSeason start rule (no closed seasons → Jan 1 UTC; a closed season →
  its `closedAtMs`; the later of the two wins); createCrew auto-season; close stamps
  `closedAtMs`, reopen clears it; standings/records reads over fixture lines+snapshots.
- **E2E (`crewSeason.spec.ts` — the frozen-deck law):** the deck's hand-designed NUMBERS
  are untouchable (singles H2H, skins 54, stableford 430/430/435/435, ledger order); the
  counting tests are replaced by their window equivalents — rounds appear with NO counting
  act; "The Golden Dozen" created AFTER the 12 rounds still contains them (the start rule
  live); close → a 13th shared round stays OUT of the closed season (and enters on
  reopen — the window taught on the wire); scoreboard columns asserted against NEW oracles
  from the same frozen deck (new feature, new oracle — computed by the LOCAL domain fold
  over the deck's own archives, then frozen as literal values in the spec file before the
  first live run, the test-1 idiom: the live response must equal the frozen literals); the superlative helpers and assertions are deleted with their feature; tests
  8/8b (leave/remove → rows vanish → rejoin/re-invite → byte-identical restore) keep their
  exact meaning.
- **Close-out (controller-run):** `pnpm validate` → `deploy:beta` LAMBDA-FIRST →
  `publish:web:beta` → `e2e:beta` ×2 → crewSeason live ×2 → full `e2e:field` → an
  adversarial USE pass on deployed beta.swng.golf (a real crew, rounds finalized by
  members who never touch the crew page, the board alive) → docs sweep (CLAUDE.md;
  `docs/product.md`'s crew/ledger section amended to the watching-crew model). NO wipe.
