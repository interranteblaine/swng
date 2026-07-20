# Navigation — the nouns are the map (design)

**Date:** 2026-07-20
**Status:** Approved by owner (design presented with rendered mockups, artifact `67c6e427`; owner: "write the spec and plan").
**Origin:** Owner field report: "Users can't nav through the application well. Navigation needs to be a thoughtful feature and right now it isn't" — no way to reach a course outside the start-round flow, no way to see another player's profile, "I'm sure there are other navigation considerations that I'm not thinking about."

---

## 1. The problem

The app was built flow by flow, so navigation is flow-shaped: every screen is a step in the
round funnel, and entities exist as pages only where a flow happened to need one. The audit
(2026-07-20, full route/link inventory):

- The header has exactly two destinations in the whole app: wordmark → `/`, your name → `/profile`.
- `/courses/:courseId` exists but the only link into it anywhere is the "View course" card
  inside the create-round flow (plus post-save navigation from add/edit). There is no
  `/courses` index. `CourseSearch` only fills forms; it never navigates.
- Player names render as plain text on every surface (live roster, game panels, results,
  archived round, crew roster, season ledger), and there is no golfer page to link to:
  every golfer read on the API is `/me*`. You cannot look at another player at all.
- Profile history rows link to the round archive but the course name inside them links nowhere.
- No 404 route (unmatched URLs render an empty page), no per-page `document.title`, no
  scroll handling, and `ArchivedRoundPage` errors on a signed-out hit instead of running
  the sign-in funnel.

## 2. The principle (binding)

**The product is four nouns; navigation is the nouns.** `product.md` §3: swng is the Round,
the Golfer, the Crew, the Event. The architecture references the round inbound by id — a URL
is the UI's inbound reference. Therefore:

> **Every noun has a canonical address. Every time a noun's name appears on screen, it is a
> link to that address** — subject only to the enumerated carve-outs in §4.

Consequences: future features land at addresses that already exist (course & tee analytics →
the course page; player comparison → the golfer page; the crew feed → the crew page; v2
Events → `/events/:id`). Navigation stops being re-solved per feature.

Addresses after this arc:

| Noun / surface | Address | Status |
|---|---|---|
| Round (permanent) | `/rounds/:roundId` | NEW — resolves by state (§7); `/rounds/:roundId/archive` redirects to it |
| Round (live scoring session) | `/round/:roundId` | exists, unchanged — a mode, not an address |
| Round (spectator capability) | `/watch/:roundId#token` | exists, unchanged — a mode, not an address |
| Course | `/courses/:courseId` | exists — becomes reachable |
| Courses hub | `/courses` | NEW |
| Golfer | `/golfers/:golferId` | NEW (+ new API, §6) |
| Crew | `/crews/:crewId` | exists, unchanged |
| You | `/profile` | exists — your golfer page plus controls |
| Not found | `*` | NEW — real 404 |

## 3. Global chrome

The shared header (`App.tsx` `Layout`) gains ONE destination:

- Signed in: `swng` wordmark (→ `/`) left; right side `Courses` (→ `/courses`) · name
  (→ `/profile`) · `Sign out`.
- Signed out (inner pages): `swng` · right side `Courses` · compact `Sign in`.
- The signed-out `/` landing page is UNCHANGED — it keeps suppressing the header entirely
  (the door stays the door; no nav dilution).

The `Courses` link wears the small uppercase nav idiom (forest text; NOT gold — gold remains
the one primary action per screen, reskin spec).

**Decision — header links, not a bottom tab bar.** Three destinations don't earn permanent
chrome; the scorecard screen is the core activity and must not lose screen height; a tab bar
is app-furniture against the paper-scorecard brand. *Alternative recorded:* bottom tab bar
(Home / Courses / Profile) — better thumb ergonomics; the right call if the destination
count grows. Revisit when Events (v2) lands.

## 4. The link rule, applied

### 4a. New shared pieces

- **`GolferLink`** (`apps/web/src/ui/GolferLink.tsx`): renders `<Link to={`/golfers/${golferId}`}>{name}</Link>`
  in the app's link idiom (gold-underline, forest text). It reads a **`PlainNamesContext`**
  (same file, default `false`): when a provider sets `plain`, it renders a plain `<span>`
  instead — this is how WatchPage (§4c) turns the whole tree's golfer links off without
  threading props through four layers.
- Course links use ordinary `<Link to={`/courses/${courseId}`}>` — courseId is optional on
  several wires (`GolferRoundLine.courseId?`, `card.source?.courseId`); **when absent the
  name renders as today's plain text** (never a dead link).

### 4b. The sweep (enumerated, binding)

| Surface | Change |
|---|---|
| HomePage (signed-in) | NEW "Recent rounds" section: latest 3 from `GET /me/rounds`, each row → `/rounds/:roundId`, rendered by the SAME history-row component §6c.3 extracts from ProfilePage (one rendering, no second vs-par/score composition web-side — the compute fence); a quiet "all rounds → your profile" pointer. Live-rounds list unchanged (already links). The redundant body `h1 "swng"` under the header wordmark is removed (recorded papercut). |
| ProfilePage history rows | Row splits into two links, NO nested anchors: course name → `/courses/:courseId` (when courseId present); the score/date remainder → `/rounds/:roundId`. |
| ProfilePage home course | Course name → course link (the "Change" button stays). |
| SetupPanel roster | Names → `GolferLink`. |
| GamePanel (standings tables, skins story, match trail labels) | Names → `GolferLink` via the existing `nameOf` sites. |
| ResultsView (players, game results) | Names → `GolferLink`. |
| ArchivedRoundPage / round record | `roundLabel`'s course-name half → course link when the archive's `card.source?.courseId` is present (date half stays plain text); all names via the shared components above. |
| RoundPage (live, finalized in-session view) | Gets the same links through the shared components (SetupPanel/GamePanel/ResultsView). |
| CrewPage roster | Member names → `GolferLink` (badges/controls unchanged). |
| SeasonPanel | Ledger row names and head-to-head names → `GolferLink` (`SeasonStandingLine.golferId` and `HeadToHeadRecord.a/b` are already on the wire); counted-round links retarget to `/rounds/:roundId`. |
| Crew counted rounds, any other `/rounds/:id/archive` link | Retarget to `/rounds/:roundId`. |

### 4c. Carve-outs (binding — the rule does NOT apply here)

1. **The scoring surface never links.** `ScorecardGrid` and `ScorePad` contain no navigation:
   a mis-tap that navigates away mid-scoring is hostile. Pinned structurally: a test asserts
   neither module imports `react-router`. Roster links live in SetupPanel, GamePanel, ResultsView.
2. **WatchPage links courses, not golfers.** Spectators are anonymous by design; golfer pages
   require sign-in; a wall behind every name on a deliberately auth-free page is worse than
   plain text. WatchPage wraps its tree in the `PlainNamesContext` provider; its course-name
   link (public read) stands. Pinned by an RTL test: watch renders participant names with no anchor.
3. **CoursePage `enteredBy` stays plain text.** The wire deliberately carries a display name
   only ("golferId stays server-side", `contracts/courses.ts`) — course reads are `auth: none`
   and golferIds don't belong on an anonymous wire. (Deviation from mockup frame 3, accepted.)
4. **StatusChrome stays plain.** It is connection telemetry, not a roster surface.

## 5. `/courses` — the hub (new page)

Route `/courses` (static segment ahead of `/courses/:courseId`). Public (course reads are
`auth: none`). Content, top to bottom:

1. `Courses` heading.
2. `CourseSearch` — the EXISTING component, no changes: the hub's `onSelect(courseId)`
   callback navigates to `/courses/:courseId` (in create-round and the profile home-course
   picker it keeps filling the form as today). The empty-state "Add a course" link inside
   CourseSearch already exists.
3. Signed in, when `auth.golfer.homeCourseId` is set: a "Your home course" card — name
   fetched via the public `GET /courses/{courseId}` — linking to the course page.
4. Signed in: "Courses you've played" — derived client-side from `GET /me/rounds`: group
   lines by `courseId` (skip lines without one), order by most-recent round, render
   `name · N round(s)`, each → the course page. Course name comes from the lines'
   `courseName` (no extra fetches).
5. An "Add a course" secondary action → `/courses/new`.

Signed out, the hub shows heading + search + Add a course (the add flow's own funnel
handles sign-in). AddCoursePage's success navigation (→ the new course's page) is unchanged.

## 6. `/golfers/:golferId` — the Golfer page (new page + new API)

### 6a. API

One new route: **`GET /golfers/{golferId}`, auth tier `golfer`** (HTTP routes 36→37; total
38→39). Response (new `GetGolferResponse` in `contracts/golfers.ts`):

```ts
{ name: string; indexSource: IndexSource; metrics: GolferMetrics; history: GolferRoundLine[] }
```

— exactly the shapes `GET /me` + `GET /me/record` already serve, deliberately minus
`homeCourseId`/`namePlaceholder` (the page doesn't render them; serve only what renders).
Use case `getGolfer` (`application/golfers/getGolfer.ts`): `golferStore.getMany([golferId])`
→ 404 `golfer-not-found` when absent; then the SAME lines-to-`{metrics, history}` fold
`getMyRecord` runs (`listLines` → `sortLines` → `golferMetrics` → newest-first wire lines),
**extracted to one shared helper both use cases call** — never a second implementation. A
placeholder-named golfer serves its placeholder name as-is.

**Decision — visibility: any signed-in golfer can view any golfer.** Golf culture: handicaps
are posted in every clubhouse and GHIN is publicly queryable; the record is scores, not
messages; one legible rule beats a visibility calculus. *Alternative recorded:*
connections-only (shared a round or crew) — more private and covers the main compare case,
but adds a server-side connection check per view, creates a "why can't I see them" state,
and protects data golf treats as public. **Tripwire:** if any user asks for privacy here,
the lever is a per-golfer visibility toggle; the endpoint design doesn't change.

### 6b. Archive reads relax to match (binding)

`GET /rounds/{roundId}/archive` currently authorizes participants or members of a crew that
counts the round, else 403. The golfer page links every history row to its round; under the
old rule most of those links would 403 for the viewer. **The archive read relaxes to any
signed-in golfer** (the route's `golfer` tier; the use case keeps 404 for a missing
snapshot and drops the participant/crew arms — `crewStore` leaves its deps). Rationale: a
finalized scorecard is the same class of fact §6a already makes visible on every
participant's record; the capability model still gates LIVE reads (participant/spectator
tokens) and all writes. *Alternative recorded:* keep the restriction and let links 403 with
an honest message — rejected: a navigation system whose links dead-end by design teaches
users not to tap links.

### 6c. Page

Route `/golfers/:golferId`, signed-out hit → the `SignInCta` funnel (`returnTo` = current
path). Renders:

1. Name `h1`.
2. The index line with its source named: `plays off 12.4 · computed from their rounds` —
   resolved exactly as ProfilePage does (`resolveIndex(indexSource, metrics)` +
   `formatHandicapIndex`), with the source phrases extracted to ONE shared helper
   parameterized by person (`your`/`their` — ProfilePage's copy strings move there; one
   copy, two persons). `—` when unresolved, per the index-model spec.
3. The record sections ProfilePage already renders — index-over-time chart, typical 18,
   history rows — extracted into shared components (`apps/web/src/golfers/RecordSections.tsx`)
   consumed by BOTH pages. History rows link to rounds and courses exactly as on Profile (§4b).
4. If the viewed golfer is you: a quiet `This is you · your profile` link. ProfilePage keeps
   the controls (name/home Save, index-source picker) — controls never render on `/golfers/:id`.
5. 404 from the API → the honest empty state ("This golfer isn't available") with a link home.

## 7. One address per round: `/rounds/:roundId`

New route; `/rounds/:roundId/archive` becomes a `<Navigate replace>` redirect to it (old
links keep working; internal links retarget per §4b). The page resolves by state, signed-in:

1. `GET /rounds/{roundId}/archive` → 200: render the archived card (today's
   ArchivedRoundPage content — this page absorbs it).
2. Any non-200 → check the caller's live rounds (`GET /me/rounds/live`) for this roundId:
   present → re-mint the device credential via the existing `POST /rounds/{roundId}/token`
   path (HomePage's own re-mint precedent) → navigate to `/round/:roundId`.
3. Otherwise: the honest fallback — "This round isn't available. If someone sent you a
   code, join here" → `/join`. (No new API: a live round you're not in and a nonexistent id
   are indistinguishable without a new read, and the distinction isn't worth an endpoint.)

Signed out → the `SignInCta` funnel (`returnTo` = current path) — a texted round link
becomes a sign-in funnel that lands on the round.

*Why:* every stored link (profile history, crew counted-rounds, a link you text someone)
should outlive the round's lifecycle state; a URL that encodes "archive" was wrong while
the round was live. *Alternative recorded:* keep the three URLs as-is (zero churn, honest
suffix) — rejected: addresses are the spine of this whole design, and the round most of all
deserves one.

## 8. Navigation infrastructure

- **Deep links survive sign-in.** `returnToStore` already stores arbitrary in-app paths and
  `SignInCta` is shared. Every auth-gated destination page uses the same funnel:
  `/golfers/:golferId` and `/rounds/:roundId` (new), joining the existing flow pages.
- **A real 404.** `path="*"` inside Layout: "This page doesn't exist." + a link home.
- **Page titles.** A `usePageTitle(title?: string)` hook (`apps/web/src/ui/usePageTitle.ts`):
  sets `document.title` to `` `${title} · swng` `` (bare `swng` when no title), resets to
  `swng` on unmount. Applied: home (none), `Courses`, course name, golfer name,
  `roundLabel(...)` on round record and watch, `Your profile`, crew name, `Join a round`,
  `Start a round`, `Not found`.
- **Scroll to top on navigation.** A small `ScrollToTop` component (mounted once in App):
  on pathname change with navigation type PUSH or REPLACE, `window.scrollTo(0, 0)`; POP
  (back/forward) is left to the browser. *Alternative recorded:* react-router's
  `<ScrollRestoration>` — requires migrating `<BrowserRouter>` to a data router; deferred
  as churn this arc doesn't need.

## 9. Out of scope (deliberate)

Breadcrumbs and hamburger menus (context links + browser back cover a three-level app);
golfer search (golfers are found through rounds and crews, not discovery-by-search); crews
back on the home page (the owner's move to profile stands); the course book itself (the
course page is its future address — frame 3's "Your record here" section is NOT built now;
no empty placeholder sections); head-to-head-vs-you on the golfer page (future, recorded);
an `enteredBy` golfer link (§4c.3); the data-router migration (§8).

## 10. Verification & deploy shape

- Structural pins: the §4c carve-outs (no `react-router` import in ScorecardGrid/ScorePad;
  watch renders plain names); per-surface RTL assertions that each §4b surface renders its
  entity names as links with the right `href`; the ProfilePage/GolferPage shared-component
  extraction pinned by both pages' render tests.
- Backend: contract/application tests for `getGolfer` (found, 404, placeholder name) and
  the relaxed `getRoundArchive` (any signed-in golfer; 404 intact). Route-count stack test
  updates.
- **Deploy lambda-first** (a new route + an authz relaxation; the old bundle is unaffected
  by either), then `publishWeb`. No data changes, no wipe, no migrations.
- E2E: reconciliation task for locator/URL drift (`/rounds/:id/archive` redirect keeps old
  waits working; new header link changes no accnames of existing controls); the close-out
  walk MUST include the adversarial USE pass viewing ANOTHER golfer's page from a live
  round's panel (two accounts), the hub → course page path, and a signed-out round link
  funneling through sign-in back to the round.
