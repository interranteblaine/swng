# Games Legibility — the model teaches, the UI shows

**Date:** 2026-07-18
**Status:** Approved (owner: "write the spec and plan. make judgements on anything open.")
**Owner problem statement:** Games are hard to understand and need to be more user friendly in
both rounds and crews. It's currently jargony, not clear, and not user friendly. Viewing games
is also confusing. All of this is very confusing for players who are new to games. Also: are
these the right games?

## 1. Diagnosis

Three distinct failures compound for a new player:

1. **Setup speaks database, not golf.** The add-game form is a bare `Kind` dropdown, then raw
   fields: **"Allowance"** as a naked decimal input (`0.95`) — WHS jargon nobody at a muni
   knows; **"Player A / Player B"**, **"Side A – Player 1"** — schema-speak; **"Net/Gross"**
   unexplained. Nothing says what Stableford *is*, what a skin *is*, or who a game fits.
   `product.md` already promised the answer we didn't build: *"format-correct allowances
   applied automatically (adjustable by the group)"* and *"the first-tee negotiation is over
   before it starts."*
2. **There is no way to view a game.** The chip is both the game *selector* and the *entire*
   standings display — one truncated line, and `describeGame` filters it to **leaders only**.
   A non-leader cannot find themselves anywhere. The product's stated magic moment ("the app
   is the one member of the group who always knows the state of every game") currently answers
   only "who's winning" — never "where do I stand," never "what happened" (which holes the
   skins carried through, how the match unfolded).
3. **The crew ledger doesn't name its games.** The season table's columns are
   `W-L-H · Points · Skins` with nothing connecting them to the games that produced them, and
   head-to-head reads like a database row (`Al 5–4–2 vs Bo`).

## 2. Design principle

**Each game's human meaning — its name, its one-line rules, its handicap convention — becomes
domain truth in one tested module, and every surface renders through it.** This is the
`handicap/present.ts` precedent (thin UI, truth in the model) applied to games. Not tooltips
sprinkled over jargon; not invented friendly names.

Jargon policy: golf's own words that a Saturday player uses (**UP, thru, halved, skins, net,
gross, 3&2, dots**) stay — `product.md` §10: swng speaks golf's visual language. Insider and
WHS jargon (**dormie, allowance-as-a-decimal, AGS, differential**) is translated or glossed
inline where it appears, never left bare.

## 3. Domain: `packages/domain/src/scoring/present.ts` (new)

Pure formatters over `GameConfig["kind"]`, barrel-exported (they compute no golf *result*, so
the web's compute fence does not ban them — same class as `formatHandicapIndex`):

| function | contract |
|---|---|
| `gameKindLabel(kind)` | `"Stroke play"` \| `"Match play"` \| `"Stableford"` \| `"Four-ball"` \| `"Skins"` |
| `gameKindBlurb(kind)` | the one-line rules, exact copy below |
| `gameKindFits(kind)` | `"2 players"` (singles), `"4 players"` (four-ball), `"2+ players"` (others) |
| `allowancePhrase(kind, allowance?)` | `"Full handicap (standard)"`, `"95% handicap (standard)"`, `"85% handicap (adjusted)"` — resolved against `defaultAllowance(kind)`; pct = `Math.round(resolved * 100)`; 100% reads "Full handicap" |

Exact blurb copy (these strings are the tested pins):

- stroke-play: `Classic card golf — lowest total score wins.`
- singles-match: `Head-to-head, hole by hole. Win more holes to win the match.`
- stableford: `Points every hole — one blow-up hole can't sink you. Most points wins.`
- fourball-match: `2 v 2 — each side counts its better ball, hole by hole.`
- skins: `Every hole is worth a skin. Win the hole outright to take it — ties carry it to the next hole.`

**Renames are presentation-only.** Wire kinds (`singles-match`, `fourball-match`) are
unchanged everywhere — events, configs, contracts, stored data. Only labels change.

## 4. Domain: per-hole trails on live `GameState`

The sheets (§6) need "what happened, hole by hole." The engines already walk this — the
extension exposes what the walk knows. **All three additions are live-`GameState`-only; the
settled `GameResult` and every contracts schema stay byte-unchanged** (the `relativeToPar`
lesson, applied from the start — `resultOf` already builds results from named fields, so no
strip is needed; a test pins `holes` absent from every settled result).

- **singles-match & fourball-match** gain
  `holes: readonly { hole: number; winner: "a" | "b" | "halved" }[]` — the decided prefix the
  ladder consumed, in card order: `cardTeeSet.holes.slice(0, ladder.thru)` zipped with the
  engine's own `winners` array (all defined inside that prefix). An early closeout (3&2 at
  hole 16) yields exactly 16 entries; post-outcome holes never appear (the ladder ignores
  them, so does the trail).
- **skins** gains
  `holes: readonly { hole: number; winner?: GolferId; pot: number }[]` — one entry per
  *decided* hole (the same sequential walk as `holesDecided`; `holes.length ===
  holesDecided`). `pot` is what the hole was worth (`1 + carrying-in`); `winner` present iff
  a single lowest net took it (and took `pot` skins), absent means the pot carried.
  `lines`/`carrying`/`carriedOut`/`holesDecided` are unchanged.

Web maps `"a"`/`"b"` to names via the frozen config, exactly as `describeFourball` already
does.

## 5. Setup: the add-game form teaches

`AddGameForm` is extracted from `SetupPanel.tsx` into its own file
(`apps/web/src/round/AddGameForm.tsx` — it grows; SetupPanel keeps the join code + roster) and
rebuilt:

**Game picker** — the `Kind` dropdown becomes a radio-card list, one card per kind: label
(`gameKindLabel`) + fits (`gameKindFits`) on the first line, blurb (`gameKindBlurb`)
underneath. Each radio input carries `aria-label={gameKindLabel(kind)}` so the accessible name
is the label alone. Default selection stays `stableford`; changing kind resets the
player/allowance fields as today.

**Who's in** — plain golf words, no schema-speak:

- stroke-play / stableford / skins: a checkbox fieldset with legend **"Who's in?"** (checkbox
  labels = participant names, unchanged).
- singles-match: fieldset **"Who's playing?"** with two selects labeled **"Player 1"** /
  **"Player 2"**.
- fourball-match: two fieldsets **"Team 1"** / **"Team 2"**, each with selects
  **"First player"** / **"Second player"**. Four distinct players required (unchanged).
- stroke-play scoring options are relabeled: **"Net — with handicap strokes"** /
  **"Gross — raw scores"** (values `net`/`gross` unchanged).

**Strokes preview replaces the allowance input.** Once the selection is valid, a **"Strokes"**
block renders:

- Line 1: `allowancePhrase(kind, allowance)` + an **"Adjust"** toggle.
- Line 2: the computed outcome, from the existing `gameDots`/`totalDots`/`strokeGrant` (a
  preview `GameConfig` is built with `gameId("preview")` — ids are unvalidated brands):
  each member as `Pat 5 dots` (singular `1 dot`), `Sam gives 1` for a plus player, members
  with none omitted; if every member has none: `No strokes — everyone plays scratch.`
- singles-match only, a fixed explainer line: `Match play uses the difference — only the
  higher handicap gets strokes.`
- **"Adjust"** reveals a number input labeled **"Handicap %"** (value
  `Math.round(allowance * 100)`, min 0, max 100, `step="any"`; submitted as `percent / 100`).
  The raw decimal input is gone. The preview re-renders live as it changes.

**Guards:** skins requires ≥ 2 checked players client-side (the Add button stays disabled — a
1-player skins game is meaningless; no wire/validation change). Stroke play and stableford
keep ≥ 1 (solo against the card is legitimate).

**Submit button text stays exactly "Add game".**

The roster's per-game dot badges in `SetupPanel` render their labels through `gameKindLabel`;
the local `GAME_KIND_LABEL` map is deleted.

## 6. Viewing: the game sheet

**Chips stay the glance layer, unchanged in role** (pull-not-push, product.md §4). The fix is
one interaction: **tapping the already-active chip opens that game's sheet.** The active chip
renders a trailing `›` glyph (aria-hidden) so the second tap is visible. Inactive-chip tap
still selects (grid dots switch, as today). The sheet lives inside `StandingsHeader` (the same
bottom-sheet idiom as its End-game confirm: `fixed inset-x-0 bottom-0 z-50 rounded-t-2xl`,
`role="dialog"` with `aria-label` = `<title> standings`, max-height ~80vh with
`overflow-y-auto`, an ✕ close button) — so it lands on **live, results, archived, and watch**
views automatically, since all four reuse `StandingsHeader`. Watch/archived render from the
local fold, so trails arrive there with zero wire changes.

Sheet content, per kind — header is always: title (as the chip: `gameKindLabel`, stroke play
appends ` (net)`/` (gross)`), then `allowancePhrase(kind, config.allowance)`, then the blurb
line, then an "Ended" note if terminated:

- **Stroke play** — a table, **every player** (not just leaders): Player · Total (net when
  net-scored) · Thru · vs par, sorted ascending by total.
- **Stableford** — the decoder line `Eagle 4 · Birdie 3 · Par 2 · Bogey 1 · worse 0`, then a
  table: Player · Points · Thru, sorted descending by points.
- **Match play / Four-ball** — a status sentence: outcome → `Pat wins 3&2` / `Match halved`;
  live → `All square thru 12` or `Pat is 2 UP with 2 to play`, with the dormie gloss appended
  when dormie: ` — dormie: Alex must win every remaining hole to tie.` Then the **hole trail**:
  a match-card grid — header row of hole numbers (decided holes only, from `holes`), one row
  per side (name / `Pat & Sam`), cells `●` (won) or `·` (halved). Then the strokes line (same
  format as the setup preview, from `gameDots`).
- **Skins** — status: live-with-carry → `Carrying 2 into hole 14`; complete-with-strand →
  `3 carried out — the final pot was never won`. Totals line, sorted descending:
  `Pat 3 · Alex 2 · Sam 0`. Then the **story list** from `holes`, carry runs collapsed:
  `Hole 1 — Pat takes 1`, `Holes 2–3 — carried`, `Hole 4 — Alex takes 3`. (A list, not a
  grid: it reads as the story of the game on a phone; the match grid stays a grid because
  that's golf's own match-card idiom.)

The chip lines themselves change in exactly one way: **` · dormie` is dropped** from the
singles and fourball lines (the sheet explains dormie in plain words; the chip stays short).
Chip titles inherit the renames via `describeGame` → `gameKindLabel`.

## 7. Results and the crew ledger

**ResultsView** — the "Handicap differentials" section becomes **"Posted to handicaps"**, rows:

- complete: `Pat — adjusted score 82 · posts 12.3` (differential still `.toFixed(1)`; no math
  change)
- unrated: `Pat — adjusted score 82 · unrated course, not posted`
- incomplete: `Pat — card incomplete, nothing posted`

**SeasonPanel** — column headers become `Member · Rounds · Matches (W–L–H) · Stableford pts ·
Skins`; a footnote renders under the table: `From this season's counted rounds — match
results, Stableford points, and skins for current members.` Head-to-head becomes a
leader-first sentence: `Al leads Bo 5–4` / `Al and Bo are tied 4–4`, with ` · 2 halved`
appended when halves > 0 (a pure web-side formatting helper, `describeGame`-class).

## 8. Are these the right games? — decision record

**Yes; change no games in this arc.** The five cover the group shapes that show up: 2 players
(match play), 4 (four-ball, skins), any number (stableford, skins, stroke play), and they're
the formats whose scoring people actually want computed. The gap a US muni crowd will feel
first is **Nassau** — and `product.md` correctly classifies Nassau as a *structure*
(front/back/overall over a match, presses initiated from the card), not a sixth engine; it
deserves its own arc where presses are designed properly, and after this arc the picker is
exactly where it will slot in with its own blurb. Wolf/Vegas/quota/junk remain v2 per the
product's own vision. Making five games legible is the prerequisite for a sixth being worth
anything.

## 9. Out of scope

- New games/engines (Nassau recorded as the next game arc; owner-triggered).
- Any wire, contract, event, or stored-data change (this whole arc is presentation + live
  `GameState` fields).
- Junk/tags, presses, `CH` roster-line notation, ScorePad/scoring flow (already good), the
  between-holes anything (deleted by owner call, stays deleted).

## 10. Invariants and gates

1. **The settled wire is byte-unchanged.** No contracts diff; a domain test pins that
   `resultOf` output for singles/fourball/skins carries no `holes` key. Old snapshots parse
   as before (nothing new is required anywhere).
2. **One copy of game meaning.** `gameKindLabel`/`gameKindBlurb`/`gameKindFits`/
   `allowancePhrase` are the only sources; `GAME_KIND_LABEL` is deleted; a review-gate grep
   (`git grep -n "Singles match\|Fourball match" -- apps/web/src packages`) must return only
   this spec/plan — run at the relevant task's close and again at the whole-branch review.
3. **The compute fence still holds.** No new banlist entries needed (present.ts exports are
   formatters; trails are `GameState` fields, and the engines/`matchLadder` stay banned);
   `pnpm lint` green throughout.
4. **e2e reconciliation is a real task, not a hope** (the CourseSearch string-breakage
   lesson): `apps/web/e2e/support.ts`'s game helpers drive the new picker/labels;
   `unratedCourse` (`chip("Singles match")` → `"Match play"`), `fieldTest`
   (`chip("Fourball match")` → `"Four-ball"`), and `courseEntry`'s singles setup are updated.
   `fieldTest`'s skins oracle runs through the app's own `describeGame`, so its lines
   self-update; the dormie drop is verified against any pinned line containing it.
5. **Close-out** (controller-run): `pnpm validate` green at every commit; `deploy:beta`
   lambda-first (engines changed; wire unchanged, bundle kept in lockstep) → `publishWeb` →
   `e2e:beta` 16/16 ×2 → full `e2e:field` → a browser walk on deployed beta.swng.golf that
   drives the picker, reads a strokes preview, opens a live game sheet, and checks the ledger
   labels. No data wipe (nothing stored changes).
