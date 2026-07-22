# The season is the record — chosen dates, honest names, all-time collapsed

> Status: **owner-approved direction** (2026-07-22, four field corrections on the shipped
> crew-scoreboard arc, one theme: **the concepts say what they are**). The owner caught,
> on the live surface: (1) "you create a season at a point of time, not select that point
> of time" — the window, the season's defining fact, was DERIVED (the tiling rule, close
> stamping the end) instead of stated; (2) the game ledger wore the name "standings" while
> the board that serves both crew scenarios (played-together AND
> me-vs-my-roommate-two-states-away) went unnamed; (3) "a season can represent all time so
> we likely don't need a confusing all-time thing on the page" — the All-time section
> showed "No rounds counted yet" (stale deleted-model vocabulary) under a season board
> full of data; (4) on the first draft of THIS spec: optional/clearable bounds rejected —
> "removing dates is likely a footgun and makes things unclear." A season without a
> period is not a season; an undated "2026" would silently swallow 2027 forever. This
> spec supersedes the 2026-07-21 crew-scoreboard spec's §2 window mechanics and §3b's
> all-time surface; everything else there stands (automatic counting, the scoreboard
> fold, shared-round derivation, roster scoping).

## 1. The model (binding)

**A season is a named period with CHOSEN, VISIBLE, REQUIRED dates — and it is the crew's
only record concept.**

```ts
export interface CrewSeason {
  readonly seasonId: string;          // unchanged
  readonly name: string;              // unchanged
  readonly status: "open" | "closed"; // unchanged — but close is CEREMONY ONLY now (§3)
  readonly createdAtMs: number;       // unchanged
  readonly startsAt: string;          // "YYYY-MM-DD" — required, stated at creation
  readonly endsAt: string;            // "YYYY-MM-DD" — required, stated at creation
}
```

- **Both bounds are calendar dates, both required, both always visible** — stored as
  `"YYYY-MM-DD"` strings, rendered verbatim as dates (the "Since Dec 31, 2025"
  local-time artifact becomes unrepresentable). There is NO unbounded state: a crew that
  wants a lifetime board states wide dates ("2018-01-01 – 2028-12-31") — the window is
  always readable off the card.
- **A round is in-season** iff the UTC calendar date of its played time
  (`createdAtMs ?? finalizedAtMs` — the standing rule) falls in `[startsAt, endsAt]`,
  inclusive. ONE conversion, in domain: `crew/seasonWindow.ts` exports
  `seasonWindowOf({startsAt, endsAt}): SeasonWindow` — mapping the date pair to the
  existing ms `SeasonWindow` (`startsAt` → UTC midnight; `endsAt` → last ms of that UTC
  day) so `crewScoreboard`/`sharedRoundIds`/every fold is BYTE-UNTOUCHED. The known
  edge — a late-evening round near a boundary can land on the neighboring UTC day — is
  accepted and documented at the helper: one rule, no timezone machinery.
- **DELETED:** the tiling start rule (`seasonStart.ts` whole), `startsAtMs`, and
  `closedAtMs`. No window fact is ever derived from when someone happened to tap a
  button. Legacy (one day of beta rows): the adapter folds stored `startsAtMs` → its UTC
  date string, `endsAt` ← Dec 31 of that same year (those rows were the year-shaped
  auto-seasons), ignores `closedAtMs` (contract-pinned); the next `putSeason` drops the
  old attributes — never a migration.

## 2. Creation and editing — the user states the period

- **`CreateSeasonRequest` becomes `{name, startsAt, endsAt}`** (dates required,
  regex-pinned on the wire, `invalid-season-window` when `startsAt > endsAt`). The web
  form comes prefilled with the common case — name = the current year, dates = Jan 1 /
  Dec 31 of it — so "2027" is one tap; "Summer Cup, Jun 1 – Aug 31" is typed once and
  means what it says. Dates are editable in the form, never clearable.
- **`createCrew` auto-opens the current calendar year** — name `String(year)`, Jan 1 –
  Dec 31 — the same season it opened before, but its dates now VISIBLE on the card
  instead of implied by a rule.
- **Seasons are editable** — the correctable-system principle reaches them:
  `PUT /crews/{crewId}/seasons/{seasonId}` (auth golfer, organizer-only — the
  close/transfer guard idiom, organizer check before season lookup), body
  `{name?, startsAt?, endsAt?}` — plain replacement values, absent leaves a field, no
  null semantics anywhere; the result revalidated with the same window/name rules.
  Closed seasons reject with `season-already-closed` (the message names the way out:
  reopen it to edit).
- **The crew name is editable** — a gap surfaced on the live surface (2026-07-22): a crew
  could be named at creation and never renamed. `PUT /crews/{crewId}` (auth golfer,
  organizer-only — the same guard order minus the season lookup), body `{name}`,
  validated by the domain's existing `validateCrewName` (trimmed 1–60), returns the
  refreshed `CrewView`. No other crew field is mutable through it (membership has its own
  verbs). Routes across §2+§4: −`GET /crews/{crewId}/records` (§4) +`PUT
  .../seasons/{seasonId}` +`PUT /crews/{crewId}` = **41 HTTP / 43 total**.

## 3. Close is ceremony, and only ceremony

`closeSeason` flips `status` and nothing else; `reopenSeason` flips it back. Closing
awards the season's titles; reopening un-awards them. **Which rounds count NEVER changes
with close or reopen** — the window is the declared dates, period. (The shipped
behavior — close stamps the end, a 13th round enters on reopen — is exactly the
strangeness this kills.) The close-confirm teaching line claims only what's true:
"Closing awards this season's titles — you can reopen it later." **The title lives on
its season:** `SeasonStandingsResponse` gains `title?: { golfers: readonly {golferId,
name}[] }` — served for CLOSED seasons via the same `stablefordTitle` fold, absent when
open or scoreless — and the closed season's panel renders it. There is no separate
trophy shelf; the season list is the timeline.

## 4. All-time collapses into the concept (owner ruling)

The All-time section, `getCrewRecords`, its route, `CrewRecordsResponse`, the web
`CrewRecordsSection`, its api client fn, and the stale "No rounds counted yet" copy are
**DELETED whole**. A season can represent any span a crew cares about — including
effectively all of its history, by stating wide dates — so a second, differently-shaped
surface aggregating "everything" is redundant machinery. Lifetime head-to-head ("you're
7–6 against Dave") is a wide-dated season's games table. `partnerRecords`,
`stablefordTitle`, `rosterFilteredContribution` survive (season standings consume them).

## 5. The names tell the truth (both crew scenarios, first-class)

The crew serves two scenarios — members who play together, and members comparing golf
played apart — and the page names them honestly:

- The scoreboard table is titled **"Standings"** — it IS the season standings for
  everyone, remote or together, already sorted as a leaderboard. (Wire/fold unchanged.)
- The game ledger table is titled **"Games together"** with the footnote it already has;
  its empty state becomes: "Appears when members play a round together." — never an
  implication that the standings are missing. Synthetic remote head-to-head (pairing up
  rounds never played against each other) is REJECTED on record: net-vs-par on the
  standings board is the honest cross-course comparison; manufactured match results are
  fake competition.
- A season panel's window line renders the chosen dates verbatim, one form always:
  `Jan 1 – Dec 31, 2026`.
- The **"account" roster badge is deleted** — a vestige of the ghost/claim era. It
  renders from `CrewMemberView.claimed` (`found?.sub !== undefined`), which distinguished
  real accounts from unclaimed ghosts back when a crew could hold either. Under
  accounts-only identity (the wall), every crew member joined as a signed-in account, so
  `claimed` is always true and the badge always shows — it tells the reader nothing.
  Delete the badge AND the field feeding it: `CrewMemberView.claimed` off the wire, and
  the async sub-lookup in `crewView.ts` that computes it (making `toCrewView` synchronous
  again unless another consumer of `claimed` surfaces — verified at implementation, none
  expected). The `organizer` badge stays: role is real.
- A whole-tree grep proves the word "counted" is out of every user-facing string.

## 6. Wire summary (lambda-first deploy; beta-only tolerance)

`CrewSeasonView` = the store shape field-for-field as always: gains REQUIRED
`startsAt`/`endsAt` (date strings, served safe for legacy rows by the adapter fold §1),
DROPS `startsAtMs`/`closedAtMs`. `CreateSeasonRequest` gains the two required dates;
`UpdateSeasonRequest` is new (all-optional plain values, `.strict()`);
`UpdateCrewRequest` is new (`{name}`, `.strict()`); `CrewMemberView` DROPS `claimed`;
`SeasonStandingsResponse` swaps its `startsAtMs`/`closedAtMs` header fields for
`startsAt`/`endsAt` and gains `title?`. `CrewRecordsResponse` and its route die. Old
bundle vs new lambda: crew pages fail loud and refresh clean (the accepted window,
same class as yesterday — a new-lambda `CrewView` without `claimed` also fails the old
bundle's parse there, same window); nothing outside `/crews/*` is touched.

## 7. Testing

- **Domain:** `seasonWindowOf` — the year pair maps to `[Jan 1 00:00:00.000Z, Dec 31
  23:59:59.999Z]`; a line at exactly the end's last ms is in, one ms later is out
  (composed with the existing `inWindow`); single-day season (`startsAt === endsAt`)
  contains that day; malformed date strings throw; the UTC-edge doc note.
- **Contract:** date round-trips; the legacy row (`startsAtMs` + `closedAtMs`, no date
  strings) reads as its UTC start date + Dec-31-of-that-year end; next put drops the
  old attributes.
- **Slices:** create requires both dates + `invalid-season-window` on inversion; auto
  year-season (name, both dates) on createCrew; close/reopen flip status only (no
  `closedAtMs` anywhere); updateSeason — partial update, organizer 403, closed 409,
  inverted-window 400.
- **E2E (`crewSeason.spec.ts`, frozen-deck law):** the crew-creation test asserts the
  auto-season's name AND both visible dates; "The Golden Dozen" is created with explicit
  year dates and still contains the deck — every frozen number (scoreboard literals
  included) byte-identical; the records-route beats become season-title beats (close →
  `title` on the SEASON's own standings, the same {Al, Bo} crown; reopen → absent);
  window pins: (a) close the year season → play a shared gameless round (today is
  inside the year) → the CLOSED season's standings INCLUDE it, ledger byte-identical —
  close moved nothing, the exact inverse of the retired pin; (b) a season created with
  both dates in the PAST excludes today's rounds entirely — an all-dash, rounds-0 board,
  date exclusion proven live. Projector-lag polls stay count-only.
- **Close-out (controller-run):** validate → `deploy:beta` LAMBDA-FIRST →
  `publish:web:beta` → `e2e:beta` ×2 → crewSeason live ×2 → full `e2e:field` → a USE
  pass on deployed beta.swng.golf (the prefilled create form; an edit of a season's
  dates; the year season's visible dates; "Standings"/"Games together" names; close →
  the title on the season) → docs sweep (CLAUDE.md; the 2026-07-21 spec gets a
  superseded-by pointer; product.md needs no change — §6 already describes the watching
  crew). NO wipe.
