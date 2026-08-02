# The brand reskin — swng wears its own identity

**Date:** 2026-07-19 · **Status:** Approved (owner, via rendered mockups)
**Mockups:** https://claude.ai/code/artifact/ff994673-e55b-4bb9-a892-ec59186121c6 (four phone
boards + type specimen — the visual source of truth for this spec)
**Origin:** an owner field report — the signed-out home showed three identical "Sign in"
buttons and a console 401 on every stale-session load — that grew, by owner call, into the
full reskin: "we might as well plan the reskin."

## 1. What this is

`apps/web` adopts the marketing site's visual identity (https://swng.webflow.io/, values
extracted live from its computed styles) end to end, and the signed-out home becomes the
app's landing page. **This arc is presentation + the auth-polish fix only**: no wire change,
no backend deploy, no data change, no behavior change outside the two explicitly-specified
exceptions (the signed-out home's structure, and §7's auth session handling).

Owner rulings that bind this spec:
- The palette and copy come from the marketing site; **oxblood** (`#8b3a3a`, the site's own
  input-placeholder red) joins the palette.
- The UI face is the **system font** — the owner rejected Oswald (condensed, hard to read)
  and Archivo (voice at the cost of app feeling) in favor of "a standard clear font for an
  app." The app ships **zero font files**; system sans + Georgia + Courier are on every
  device.
- **Light-only, deliberately.** Golf happens in daylight. The palette lives in theme tokens,
  so a dark variant later is a token flip, not a redesign. No `prefers-color-scheme`
  handling in this arc.

## 2. The identity system

Tokens (Tailwind 4 `@theme`, the ONE place hex values live):

| token      | value     | role |
|------------|-----------|------|
| `forest`   | `#1c2b22` | ink; dark grounds (door band, grid header, active chips) |
| `fairway`  | `#3d5a45` | muted ink: secondary text, hole/par/SI metadata, quiet accents |
| `cream`    | `#f7f5ef` | the page ground — every screen is paper |
| `card`     | `#fffdf8` | raised surfaces: cards, inputs, the scorecard grid |
| `hairline` | `#ddd8c9` | borders and rules on cream/card |
| `gold`     | `#c9a356` | THE primary action, once per screen; the current-hole wash pairs with `goldwash` |
| `goldwash` | `#f3e9d2` | current-hole row background; warning-banner ground |
| `oxblood`  | `#8b3a3a` | the second ink — see below |

Type roles (no bundled fonts):
- **System sans** (Tailwind's default stack) — all UI: headings, buttons, labels, and every
  numeral on a card (`tabular-nums` where digits align).
- **Georgia** (`font-serif`) — sentences: framing copy, hints, empty states, blurbs.
- **Courier** (`font-mono`) — machine facts: dates, join codes, tee data, eyebrow labels,
  footers.

Shape and hierarchy:
- **Square corners everywhere.** Every `rounded*` class is deleted; none survive, including
  the two `rounded-full` badge pills (they become square chips). Cards and boxes are
  `card`-ground with `hairline` borders.
- **Button hierarchy:** gold solid = the screen's one primary action; forest outline =
  secondary; underlined text = tertiary; oxblood = careful (outline for triggers, solid for
  a confirm sheet's commit). Button labels render uppercase with letterspacing **via CSS**
  (`uppercase tracking-*`) — the JSX copy stays sentence-case (see §8 for the accessible-name
  consequence).
- **Gold appears once per screen** — a design rule enforced by review, not grep: the primary
  action (Sign in, Start a round, Create round, …) or the current-hole wash. Gold is never
  data ink (the profile chart plots forest and fairway, not gold) and never text on cream
  (contrast).

**Oxblood is the second ink** (old scorecards carried exactly two inks). Its jobs, all of
them, nothing else: **under-par scores** on the card (golf's own red-numbers convention),
**notable score states** (the picked-up/conceded glyphs), **input placeholders** (the
marketing site's idiom), **careful actions** (Scrap round, End game…, Leave round, member
removal) and **error text** (`role="alert"` copy). Not used for: generic emphasis, links,
warnings (warnings are `goldwash` ground + forest text).

## 3. The signed-out door (the one structural change)

Signed out, `/` renders the landing page — **no app header** (the hero's first word is the
wordmark), and no "Your rounds" section (a heading whose only content is a sign-in box just
enumerates a locked feature). Exactly one sign-in affordance on the page. Copy, verbatim:

- Hero (cream): h1 **"swng is the app for the golf you actually play."** · sub (Georgia)
  **"Fair matches, layered games, a record that lasts."** · gold button **"Sign in"** ·
  fineprint (Georgia) **"New here? Signing in creates your account."**
- Band (forest): h2 **"Playing today?"** · **"Join a round with the code from your group."**
  · a mono code input (aria-label **"Round code"**, placeholder **"ROUND CODE"**, oxblood
  placeholder ink) beside a cream-outline **"Join"** button · footer (mono)
  **"swng © 2026"**.

The code input navigates to `/join?code=<trimmed input>` on submit (`/join` when empty) —
the join funnel keeps ALL of its own logic (sign-in gating, peek, tee picker); the door just
pre-fills it. Sign in calls the existing `signIn()` with no returnTo (landing on home signed
in — Start a round is right there — beats resurrecting the `/create` returnTo).

Header suppression is exact: `Layout` renders no header **iff signed out AND on `/`**. Every
other route — including signed-out inner pages — keeps the header and its compact Sign in
(e2e relies on it: fieldTest scopes the funnel CTA to `main` because the header carries its
own). Signed-in `/` keeps the header.

Inner pages' `SignInCta`s (join funnel, create, course edit) keep their copy and single-CTA
structure — they were never the problem — restyled to the card idiom.

## 4. The signed-in home

Same content as today, reskinned: gold **Start a round**, forest-outline **Join by code**,
mono eyebrow **"Your rounds"**, round rows as card-ground entries (hairline border, a 3px
fairway left rule; course name in Georgia, date line in mono). All existing logic —
presence list, credential re-mint on tap, round-final error handling — byte-identical.

## 5. The sweep

Every surface in `apps/web/src` moves to the system. The invariant: **recolor, retype,
re-shape — never re-behave.** Component logic, props, handlers, routes, roles, aria
attributes, and copy are unchanged (the door is the sole copy/structure exception). Surfaces:
Layout/AuthChrome header (cream ground, forest rule, mono identity chrome, gold-underline
name link), HomePage, JoinRoundPage, CreateRoundPage, AuthCallbackPage, SetupPanel,
RoundPage (incl. offline chrome), ScorecardGrid, ScorePad, StandingsHeader (chips + confirm
sheet), GamePanel, AddGameForm, FinalizeDialog/ResultsView, ProfilePage (chart: swng line =
forest solid ●, WHS line = fairway dashed ○ — gold is never data ink), ArchivedRoundPage,
WatchPage, CourseSearch, CourseSummaryCard, CoursePage, AddCoursePage, EditCoursePage,
HoleGrid, CrewPage (badges become square chips), CrewCreatePage, CrewJoinPage, SeasonPanel.

Scorecard specifics: grid on `card` ground with `hairline` cell rules and a forest header
row (mono column labels, sans player names); hole/par/SI metadata in mono fairway; scores in
sans semibold `tabular-nums`; the current-hole row washes `goldwash` (replacing
`bg-emerald-950`); the picked-up/conceded glyphs (today's amber) become oxblood — notable
states wear the second ink.

**Under-par ink is a domain convention, not a view trick** (thin-UI rule): a new
`underPar(score, par): boolean` presentation helper joins `@swng/domain`'s
`scoring/present.ts` (tested there, exported like `formatHandicapIndex` — presentation
helpers are fence-allowed). The web applies oxblood to a gross score iff
`underPar(gross, par)` and to a net line iff `underPar(net, par)`.

## 6. Shared idioms live in one module

`apps/web/src/ui/classes.ts` — exported class-string constants (usable on `button`, `Link`,
`input` alike): `btnPrimary` (gold), `btnSecondary` (forest outline), `btnCreamOutline` (on
forest grounds), `btnDanger` (oxblood outline), `btnDangerSolid` (oxblood fill, confirm
sheets), `cardBox` (card + hairline border), `eyebrow` (mono uppercase tracked fairway),
`inputBox` (sans, card ground, oxblood placeholder), `inputCode` (mono, tracked). Every
swept surface composes from these; a class string that duplicates an idiom instead of
importing it is a review defect (the one-copy discipline).

## 7. Auth polish — the 401 dies, and background failure stops navigating

Both in `useAuth.ts`, the one policy site. No wire change; e2e-injected tokens carry future
`expiresAt` and are untouched.

1. **Proactive refresh:** `withAuth` checks the stored `expiresAt` before using the token —
   expired or within a 60s skew, it refreshes FIRST, then calls with the fresh token. The
   existing 401 → refresh → retry path stays as the safety net. (Today: Cognito ID tokens
   live 60 minutes and `expiresAt` is stored but never read, so every stale-session load
   fires a guaranteed console 401.)
2. **Background failure degrades in place:** a failed refresh clears the local session
   (tokens + golfer state) and rethrows — **no redirect**. The signed-out chrome simply
   appears. The explicit Sign out button keeps the Cognito `/logout` redirect (papercut 6's
   Hosted-UI-cookie reason is about user intent, which a background expiry doesn't carry;
   the cookie surviving a background clear is a feature — the next Sign in tap resumes
   seamlessly).

This closes the 401 half of papercut 18 structurally; the 400 `oauth2/token` remains only
when a refresh genuinely dies, now without a user-visible redirect.

## 8. Tests, gates, and the accessible-name consequence

- **Whole-tree grep gates** (the invariant spans the tree, not a file list):
  - no legacy palette: `grep -rE '(slate|emerald|amber|zinc|gray|stone|neutral|sky|blue|red)-[0-9]' apps/web/src` → empty;
  - no radius: `grep -rE '\brounded(-[a-z0-9]+)?\b' apps/web/src` → empty;
  - no font files: `find apps/web -name '*.woff*' -o -name '*.ttf' -o -name '*.otf'` → empty;
  - no stray hex: `grep -rE '#[0-9a-fA-F]{6}\b' apps/web/src --include='*.tsx'` → empty
    (SVG strokes use classes/`currentColor`; hexes live in `styles.css` only).
- **CSS uppercase changes Playwright accessible names** (Chromium applies `text-transform`
  to the accname; happy-dom/testing-library reads `textContent` and does not). Unit tests
  keep sentence-case matchers; e2e locators on uppercase-styled controls move to
  case-insensitive regex names during reconciliation — verified locator-by-locator against
  the JSX (the games-legibility lesson).

  **Correction (dated 2026-08-02, round-plays-a-nine whole-branch review Finding 8):** the
  Chromium half of that claim does not hold. Two independent reads of the pinned
  `playwright-core@1.61.1` bundle's accessible-name computation
  (`getElementAccessibleName`) found `text-transform` referenced **zero** times in that path
  — it accumulates raw `textContent`, uppercase or not. The belief was never falsified by the
  gate that motivated it, because a case-insensitive regex passes identically whether or not
  `text-transform` affects the accname — the fix worked, but not for the stated reason, and
  it has since propagated as guidance to other work. This correction leaves the happy-dom
  half of the original claim ("does not [apply `text-transform`]") **un-re-examined** — it was
  not the part checked here, and this note makes no claim about it either way.
- `pnpm validate` green at every commit. Close-out is controller-run: whole-branch review →
  `publish:web:beta` (no backend deploy) → `pnpm e2e:beta` ×2 (backend-regression sanity) →
  full `pnpm e2e:field` → an **adversarial USE pass** on the deployed beta.swng.golf in a
  phone viewport, signed-out door first, driving data that makes the design exist (a birdie
  for the oxblood ink, a stale session for the 401 fix).

## 9. Non-goals

Dark mode (tokens make it a later flip). The marketing site itself (it should eventually
adopt the system font — recorded, not scheduled). Any game/scoring/handicap behavior. Copy
outside the door. PWA/manifest work. The two papercut-18 `oauth2/token` 400s beyond what §7
removes.
