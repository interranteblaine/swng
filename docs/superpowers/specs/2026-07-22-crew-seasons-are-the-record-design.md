# The season is the record — chosen dates, a tracking window, no crown

> Status: **owner-approved direction** (2026-07-22). Two correction passes on the shipped
> crew-scoreboard arc, one theme: **the concepts say what they are.**
>
> **Pass 1 (four field corrections).** The owner caught, on the live surface: (1) "you
> create a season at a point of time, not select that point of time" — the window, the
> season's defining fact, was DERIVED (a tiling rule, close stamping the end) instead of
> stated; (2) the game ledger wore the name "standings" while the board that serves both
> crew scenarios (played-together AND me-vs-my-roommate-two-states-away) went unnamed on
> screen; (3) "a season can represent all time so we likely don't need a confusing all-time
> thing on the page" — the All-time section showed stale deleted-model vocabulary under a
> season board full of data; (4) optional/clearable bounds rejected — "removing dates is
> likely a footgun and makes things unclear." A season without a period is not a season.
>
> **Pass 2 (the crowning re-derivation).** The first draft of this spec kept "close" as a
> ceremony that awards a Stableford title. The owner rejected it root and branch — "why
> would you crown somebody before the date range is done? ... why do we even have crowning
> in the first place?" The re-derivation: **crowning requires a defined competition, and a
> crew season doesn't define one.** A crew season is a tracking window that aggregates
> whatever golf happened; picking Stableford — or any single metric off a multi-dimensional
> board — to anoint a champion invents a contest the crew never agreed to play. Crowning
> belongs to the **Event** pillar (the Trip / League, which define a format and a trophy);
> the **Crew** tracks. So `close`/`reopen`, the `status` field, and `stablefordTitle` are
> all deleted — **the end date is the only thing that ends a season, and time is the only
> state.** A second consequence of the same re-derivation: "close" and the end-date were
> two knobs for one fact, and the strange "closed but still recomputing" seam the first
> draft papered over with copy simply ceases to exist once the end date is the sole end.
>
> This spec supersedes the 2026-07-21 crew-scoreboard spec's §2 window mechanics and §3b
> all-time surface, and the 2026-07-21 close-season spec **whole**; everything else in the
> scoreboard spec stands (automatic counting-by-reading, the scoreboard fold, shared-round
> derivation, roster scoping).

## 1. The model (binding)

**A season is a named period with CHOSEN, VISIBLE, REQUIRED dates. Time is its only state.
It is the crew's only record concept.**

```ts
export interface CrewSeason {
  readonly seasonId: string;    // unchanged
  readonly name: string;        // unchanged
  readonly createdAtMs: number; // unchanged
  readonly startsAt: string;    // "YYYY-MM-DD" — required, stated at creation
  readonly endsAt: string;      // "YYYY-MM-DD" — required, stated at creation
}
```

- **No `status`.** There is no open/closed flag. A season is **Live** while today's UTC
  date ≤ `endsAt`, and **Final** once today > `endsAt` — a value DERIVED on read (a
  `YYYY-MM-DD` string compare against today's UTC date, web-side), never stored. Once the
  end date has passed, no new round can land in the window (a round's played date is
  "now"), so a Final season's board is frozen by time itself — which is exactly, and only,
  what "closed" used to mean. This makes the deleted `status` flag redundant, not merely
  unwanted.
- **Both bounds are calendar dates, both required, both always visible** — stored as
  `"YYYY-MM-DD"` strings, rendered verbatim (the "Since Dec 31, 2025" local-time artifact
  becomes unrepresentable). There is NO unbounded state: a crew that wants a lifetime board
  states wide dates ("2018-01-01 – 2028-12-31") — the window is always readable off the card.
- **A round is in-season** iff the UTC calendar date of its played time
  (`createdAtMs ?? finalizedAtMs` — the standing rule) falls in `[startsAt, endsAt]`,
  inclusive. ONE conversion, in domain: `crew/seasonWindow.ts` exports
  `seasonWindowOf({startsAt, endsAt}): SeasonWindow` — mapping the date pair to the existing
  ms `SeasonWindow` (`startsAt` → UTC midnight; `endsAt` → last ms of that UTC day) so
  `crewScoreboard`/`sharedRoundIds`/every fold is BYTE-UNTOUCHED. The known edge — a
  late-evening round near a boundary can land on the neighboring UTC day — is accepted and
  documented at the helper: one rule, no timezone machinery. The parse **rejects a
  semantically-invalid date** (`2026-02-30`, `2026-13-01`) via a round-trip check
  (`isoOf(Date.UTC(...)) === input`), not just the `\d{4}-\d{2}-\d{2}` shape — a
  fat-fingered day must not silently roll over. A malformed string reaching `seasonWindowOf`
  is a **programmer guard** (a plain `Error`, not a `DomainError` — the wire regex already
  gates every write path, so this fires only on a corrupted stored row; the same posture as
  the adapter's existing seasonId "#" guard). The user-facing ordering check (`startsAt >
  endsAt`) is a separate `ApplicationError("invalid-season-window")` → 400 in the use cases
  (§2), NOT a domain throw — so no domain error code needs an HTTP mapping.
- **DELETED:** the tiling start rule (`seasonStart.ts` whole), `startsAtMs`, `closedAtMs`,
  AND `status`. No window fact is ever derived from when someone happened to tap a button,
  and no lifecycle flag is stored. Legacy (beta rows only, disposable): the adapter folds a
  stored `startsAtMs` → its UTC date string, `endsAt` ← Dec 31 of that same year (those rows
  were the year-shaped auto-seasons), ignores `closedAtMs` AND `status` (contract-pinned);
  the next `putSeason` drops the old attributes — never a migration.

## 2. Creation and editing — the user states the period, time ends it

- **`CreateSeasonRequest` becomes `{name, startsAt, endsAt}`** (dates required, regex-pinned
  on the wire, `invalid-season-window` when `startsAt > endsAt`). The web form comes
  prefilled with the common case — name = the current year, dates = Jan 1 / Dec 31 of it —
  so "2027" is one tap; "Summer Cup, Jun 1 – Aug 31" is typed once and means what it says.
  Dates are editable in the form, never clearable.
- **`createCrew` auto-opens the current calendar year** — name `String(year)`, Jan 1 – Dec
  31 — the same season it opened before, but its dates now VISIBLE on the card instead of
  implied by a rule.
- **Seasons are editable — and editing the end date IS the whole lifecycle.**
  `PUT /crews/{crewId}/seasons/{seasonId}` (auth golfer, organizer-only — the transfer/leave
  guard idiom, organizer check before season lookup), body `{name?, startsAt?, endsAt?}` —
  plain replacement values, absent leaves a field, no null semantics anywhere; the result
  revalidated with the same window/name rules. **There is no separate "close" or "reopen":**
  to end a running season now, set `endsAt` to today; to extend or re-open one, push `endsAt`
  out. One verb, honest about what it does — it changes the dates, which are the whole truth.
- **The crew name is editable** — a gap surfaced on the live surface (2026-07-22): a crew
  could be named at creation and never renamed. `PUT /crews/{crewId}` (auth golfer,
  organizer-only — the same guard order minus the season lookup), body `{name}`, validated
  by the domain's existing `validateCrewName` (trimmed 1–60), returns the refreshed
  `CrewView`. No other crew field is mutable through it (membership has its own verbs).
- **Route delta (across §2 + §3 + §4):** +`PUT /crews/{crewId}/seasons/{seasonId}`
  +`PUT /crews/{crewId}` −`POST .../seasons/{seasonId}/close` −`POST .../seasons/{seasonId}/reopen`
  −`GET /crews/{crewId}/records` = **39 HTTP / 41 total** (from HEAD's 40 / 42).

## 3. No crown — the crew tracks, it doesn't compete

Crowning is deleted whole: `closeSeason`, `reopenSeason`, their two routes, the `status`
field, the `season-already-closed`/`season-not-closed` error codes, `stablefordTitle`, and
any season "title" on the wire. The reasoning is a **product boundary**, not a convenience
cut:

- **A crew season is a tracking window, not a competition with a defined format.** It
  aggregates whatever golf its members happened to play between two dates. Nobody agreed to
  a season-long scoring, so there is no winner to anoint. To crown one, swng would have to
  pick a single metric off a multi-dimensional board (best Net/18? most rounds? most
  Stableford points?) and declare it "the" championship — inventing a contest the crew never
  played. That arbitrariness (why Stableford?) was the tell.
- **Crowning belongs to the Event** (`product.md` §7): the Trip and the League define a
  format, points, playoffs, and a trophy, so a champion there is real and earned. The Crew
  (§6) watches and keeps the record. This spec holds that line and does not blur it.
- **Who leads is still legible — as a fact, not a title.** The "Games together" ledger keeps
  its Stableford-points column, head-to-head, partners, and skins; the "Standings" board
  keeps Net/18, Best 18, rounds, index. After a season goes Final those columns are frozen,
  and the reader can see who led any of them. swng states the numbers; it never hands out a
  crown. (`aggregateSeason` — which produces the Stableford-points column — is untouched;
  only `stablefordTitle`, the champion-extraction fold on top of it, dies.)

## 4. All-time collapses into the concept (owner ruling)

The All-time section, `getCrewRecords`, its route, `CrewRecordsResponse`, the web
`CrewRecordsSection`, its api client fn, and the stale "No rounds counted yet" copy are
**DELETED whole**. A season can represent any span a crew cares about — including effectively
all of its history, by stating wide dates — so a second, differently-shaped surface
aggregating "everything" is redundant machinery. Lifetime head-to-head ("you're 7–6 against
Dave") is a wide-dated season's games table. `partnerRecords`, `aggregateSeason`,
`sharedRoundIds`, `rosterFilteredContribution` survive (season standings consume them);
`stablefordTitle` does NOT — its only consumer was `getCrewRecords` (§3; a grep confirms no
other, and the fold + its test are removed with the route).

## 5. The names tell the truth (both crew scenarios, first-class)

The crew serves two scenarios — members who play together, and members comparing golf
played apart — and the page names them honestly:

- The scoreboard table gets a **VISIBLE heading `Standings`** — it IS the season standings
  for everyone, remote or together, already sorted as a leaderboard. Today both tables carry
  only aria-labels and no visible caption (unlike Head-to-head/Partners, which have visible
  `<h4>`s) — so the owner's "the real board went unnamed" complaint is a MISSING VISIBLE
  HEADING, not a rename. Render an `<h4>Standings` above the scoreboard and an `<h4>Games
  together` above the ledger (the existing `<h4>` idiom), and update each table's aria-label
  to match. (Wire/fold unchanged; the aria-label strings are e2e/unit LOCATORS — treat the
  change as a real string-move, not "type-reconciliation.")
- The game ledger, under its `Games together` heading, keeps the footnote it already has;
  its empty state becomes: "Appears when members play a round together." — never an
  implication that the standings are missing. Synthetic remote head-to-head (pairing up
  rounds never played against each other) is REJECTED on record: net-vs-par on the standings
  board is the honest cross-course comparison; manufactured match results are fake competition.
- **Live vs. Final is a derived label, nothing more.** A season panel's window line renders
  the chosen dates verbatim, one form always: `Jan 1 – Dec 31, 2026`, from the date STRINGS
  (a local month-name split — NEVER a `new Date` local conversion, the "Dec 31, 2025"
  artifact class). Beside it, a small **`Final`** marker shows iff today's UTC date `>
  endsAt` (the derived state of §1) — replacing the deleted `closed` badge with an honest,
  computed one; a Live season shows no marker (the dates already say it's current). No
  interaction, no stored state, no crown. Note the one accepted inconsistency: season
  membership compares the UTC date of a round's played time (§1), while a round's own date
  renders locally elsewhere — so a round finalized late on a boundary evening can read
  locally as one date yet file under the neighboring UTC day. UTC is the only deterministic
  stored option (no per-round timezone is stored); the miss is confined to after-dark
  boundary rounds and is documented so support can explain it, not hidden.
- **Lifetime is discoverable:** the create-season form (or the season-list empty state)
  carries one helper line naming the wide-dates path — "Want an all-time board? Give it wide
  dates." — so collapsing the All-time surface (§4) never hides the lifetime use.
- The **"account" roster badge is deleted** — a vestige of the ghost/claim era. It renders
  from `CrewMemberView.claimed` (`found?.sub !== undefined`), which distinguished real
  accounts from unclaimed ghosts back when a crew could hold either. Under accounts-only
  identity (the wall), every crew member joined as a signed-in account, so `claimed` is
  always true and the badge always shows — it tells the reader nothing. Delete the badge AND
  the field feeding it: `CrewMemberView.claimed` off the wire, and the async sub-lookup in
  `crewView.ts` that computes it (making `toCrewView` synchronous again unless another
  consumer of `claimed` surfaces — verified at implementation, none expected). The
  `organizer` badge stays: role is real.
- A whole-tree grep proves the words "counted" and "closed" are out of every user-facing
  crew string (the remove-member confirm still says "counted"; the season badge still says
  "closed" — both go).

## 6. Wire summary (lambda-first deploy; beta-only tolerance)

`CrewSeasonView` = the store shape field-for-field as always: gains REQUIRED
`startsAt`/`endsAt` (date strings, served safe for legacy rows by the adapter fold §1),
DROPS `startsAtMs`, `closedAtMs`, AND `status`. `CreateSeasonRequest` gains the two required
dates; `UpdateSeasonRequest` is new (all-optional plain values, `.strict()`);
`UpdateCrewRequest` is new (`{name}`, `.strict()`); `CrewMemberView` DROPS `claimed`;
`SeasonStandingsResponse` swaps its `startsAtMs`/`closedAtMs`/`status` header fields for
`startsAt`/`endsAt` and carries **no title**. `CrewRecordsResponse` and its route die.
`closeSeason`/`reopenSeason` and their two routes die. Old bundle vs new lambda: crew pages
fail loud and refresh clean (the accepted window, same class as yesterday — a new-lambda
`CrewView` without `claimed`, or a standings header without `status`, also fails the old
bundle's parse there); nothing outside `/crews/*` is touched.

## 7. Testing

- **Domain:** `seasonWindowOf` — the year pair maps to `[Jan 1 00:00:00.000Z, Dec 31
  23:59:59.999Z]`; a line at exactly the end's last ms is in, one ms later is out (composed
  with the existing `inWindow`); single-day season (`startsAt === endsAt`) contains that day;
  malformed date strings throw (shape AND round-trip); the UTC-edge doc note.
- **Contract:** date round-trips; the legacy row (`startsAtMs` + `closedAtMs` + `status`, no
  date strings) reads as its UTC start date + Dec-31-of-that-year end, with `status`/`closedAtMs`
  ignored; next put drops the old attributes.
- **Slices:** create requires both dates + `invalid-season-window` on inversion; auto
  year-season (name, both dates, no `status`) on createCrew; `updateSeason` — partial update,
  organizer 403, inverted-window 400 (NO closed-check — there is no closed state);
  `updateCrew` renames, organizer 403, invalid-name 400. NO close/reopen tests exist (the
  verbs are gone).
- **Web unit:** the `Final` marker shows for a season whose `endsAt` is in the past and is
  absent for one in the future (a frozen "today" input, not `Date.now()` in the assertion).
- **E2E (`crewSeason.spec.ts`, frozen-deck law):** the crew-creation test asserts the
  auto-season's name AND both visible dates. "The Golden Dozen" is created with the CURRENT
  UTC year's dates and still contains the deck — every frozen number (scoreboard literals,
  H2H 5W-5L-2H, skins 54, the Stableford-points ledger column 430/430/435/435) byte-identical.
  The retired close/reopen/title beats are DELETED outright (no title concept remains).
  Window pins: (a) a season created with both dates in the PAST excludes today's rounds
  entirely — an all-dash, rounds-0 board, date exclusion proven live; (b) `updateSeason`
  widening that past season's `endsAt` to include today makes the rounds appear — editing
  the dates re-scopes the window live, which IS the whole lifecycle. Projector-lag polls stay
  count-only.
- **Close-out (controller-run):** validate → `deploy:beta` LAMBDA-FIRST → `publish:web:beta`
  → `e2e:beta` ×2 → crewSeason live ×2 → full `e2e:field` → a USE pass on deployed
  beta.swng.golf (the prefilled create form; editing a season's dates AND the crew name; the
  year season's visible dates and Live/Final marker; "Standings"/"Games together" names; the
  roster with NO "account" badge; NO close/reopen buttons anywhere) → docs sweep (CLAUDE.md;
  the 2026-07-21 crew-scoreboard AND close-season specs get superseded-by pointers;
  product.md §6 already describes the watching crew — no change). NO wipe.
