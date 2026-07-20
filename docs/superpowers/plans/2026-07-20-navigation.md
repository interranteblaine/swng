# Navigation — the nouns are the map: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every noun gets a canonical address and every rendered noun-name becomes a link — one new API route (`GET /golfers/{golferId}`), two new pages (`/courses` hub, `/golfers/:golferId`), one resolved round address (`/rounds/:roundId`), a link sweep over every existing surface, and the navigation infrastructure (404, titles, scroll, sign-in-surviving deep links).

**Architecture:** Backend adds exactly one read route plus an authorization relaxation on archive reads; everything else is `apps/web`. Record rendering moves from ProfilePage into shared components by EXTRACTION (byte-identical relocation, the domain-boundary lesson) so the golfer page and home reuse one rendering. Links are additive presentation — no surface changes what it computes, no wire changes beyond the one new response.

**Tech Stack:** Existing stack throughout — Zod contracts, application use cases + ports, lambda declarative dispatcher, React 19 + react-router 7 (declarative `<BrowserRouter>`) + Tailwind 4, Vitest/RTL under happy-dom.

**Binding spec:** `docs/superpowers/specs/2026-07-20-navigation-design.md` — section references below are to it.

## Global Constraints

- **The link rule and its carve-outs are spec §2/§4 verbatim.** Carve-outs (binding): `ScorecardGrid`/`ScorePad` never import `react-router` (pinned structurally); WatchPage renders golfer names PLAIN via `PlainNamesContext` (course link allowed); CoursePage `enteredBy` stays plain text; StatusChrome stays plain.
- **Links are additive.** No task changes what any surface computes, no existing wire shape changes; the only wire addition is `GetGolferResponse`. The settled/live round wires are byte-untouched.
- **The web computes no golf result** (the ESLint compute fence stays green). Record rendering moves by extraction; Home's recent rounds reuse the SAME extracted history-row component — never a second score/vs-par composition.
- **One link idiom.** `linkEntity = "underline decoration-gold decoration-2 underline-offset-2"` added to `apps/web/src/ui/classes.ts`; every new entity link wears it (it is AuthChrome's existing name-link treatment, promoted to an idiom).
- **No nested anchors** anywhere (profile/home history rows split into sibling links).
- **Optional `courseId` → plain text fallback**, never a dead link (`GolferRoundLine.courseId?`, `card.source?.courseId`).
- **Gold once per screen** (reskin spec) — the header `Courses` link and all entity links are NOT gold-filled; gold underline decoration is the link idiom, not a button.
- New route: `GET /golfers/{golferId}`, auth tier `golfer`, HTTP routes 36→37 (38→39 total), **NOT** in the tightened anonymous throttle set.
- `/rounds/:roundId/archive` keeps working forever via redirect.
- Copy is spec-verbatim where quoted: `This page doesn't exist.`, `This golfer isn't available`, `This round isn't available. If someone sent you a code, join here`, `This is you · your profile`, third-person source phrases `from all their rounds` / `their WHS index` / `their own`.
- **`pnpm validate` green at every commit.** Task 1 also runs `pnpm test:contract` if it touches any adapter (it shouldn't need to — no port changes).

---

### Task 1: Backend — `GET /golfers/{golferId}` + archive reads relax to signed-in

**Files:**
- Modify: `packages/contracts/src/golfers.ts` (add `GetGolferResponse` + schema)
- Create: `packages/application/src/golfers/recordOf.ts` (the shared lines→record fold)
- Create: `packages/application/src/golfers/getGolfer.ts`, `getGolfer.test.ts`
- Modify: `packages/application/src/golfers/getMyRecord.ts` (consume `recordOf`)
- Modify: `packages/application/src/rounds/getRoundArchive.ts`, `getRoundArchive.test.ts` (drop the participant/crew arms)
- Modify: `packages/lambda/src/http/routes.ts` (+ the composition site that wires `getMyRecord`'s deps — same file or the entry that builds them; follow that wiring exactly)
- Modify: whatever stack/route tests pin the route count (grep `apps/infra-cdk` + `packages/lambda` tests for the current `36`/route-list pins)

**Interfaces:**
- Consumes: `GolferStore.getMany`, `ProjectionStore.listLines`, the existing `sortLines`/`golferMetrics`/`toWireLine` chain inside `getMyRecord.ts`, the error idiom `getRoundArchive` already uses for 404.
- Produces: `GetGolferResponse = { name: string; indexSource: IndexSource; metrics: GolferMetrics; history: readonly GolferRoundLine[] }` (exported from contracts); `getGolfer(deps: { golferStore; projectionStore })(request: { golferId: GolferId }): Promise<GetGolferResponse>` throwing the app-error code `golfer-not-found` (404); route `GET /golfers/{golferId}` auth `golfer`; `recordOf(lines): { metrics, history }`.

- [ ] **Step 1: Contracts.** In `contracts/golfers.ts`, add `GetGolferResponse` + `getGolferResponseSchema` composing the file's EXISTING schema constants (the ones `GolferView`/`GetMyRecordResponse` already use for `indexSource`, `metrics`, and the round line — reuse those identifiers verbatim, never re-declare shapes):

```ts
export interface GetGolferResponse {
  readonly name: string;
  readonly indexSource: IndexSource;
  readonly metrics: GolferMetrics;
  readonly history: readonly GolferRoundLine[];
}
```

- [ ] **Step 2: Extract the shared fold (tests stay green = the extraction pin).** Move `getMyRecord.ts`'s lines→`{metrics, history}` block (its `sortLines` → `golferMetrics` → `sorted.reverse().map(toWireLine)` chain, including the empty-lines default) into `recordOf.ts` as `export const recordOf = (lines) => ({ metrics, history })`; `getMyRecord` calls it. Run `pnpm -F @swng/application vitest run src/golfers` — every existing getMyRecord test passes unchanged. Byte-identical relocation: no logic edits.

- [ ] **Step 3: Failing tests for `getGolfer`.** In `getGolfer.test.ts` (mirror `getMyRecord`'s test harness/fakes): (a) a stored golfer with lines returns `{name, indexSource, metrics, history}` where metrics/history equal `recordOf(lines)`'s output exactly; (b) an unknown golferId rejects with the 404 app-error code `golfer-not-found`; (c) a placeholder-named golfer (`namePlaceholder: true`) serves its stored placeholder name as-is. Run: fails (module missing).

- [ ] **Step 4: Implement `getGolfer.ts`** per the Produces signature: `const [found] = await deps.golferStore.getMany([request.golferId])`; absent → throw `golfer-not-found` via the same error class/mapping `getRoundArchive`'s 404 uses; else `recordOf(await deps.projectionStore.listLines(found.golfer.id))` + name/indexSource off `found.golfer`. Tests pass.

- [ ] **Step 5: Relax `getRoundArchive` (spec §6b).** Flip its tests first: the existing 403 non-participant/non-crew cases now expect the archive (200); keep missing-snapshot → 404 and add one explicit test named for the spec: "any signed-in golfer reads any finalized archive". Then delete the `isParticipant`/crew-counts arms and the now-unused `golferStore`/`crewStore` deps (fix the composition site accordingly). Tests pass.

- [ ] **Step 6: Route.** Add `GET /golfers/{golferId}` to `routes.ts` with `auth: "golfer"`, path-param extraction and request/response schema wiring exactly in the shape of `GET /courses/{courseId}`'s entry (but golfer-tier); wire `getGolfer` where the other golfer use cases are composed. Update any route-count/route-list pins (36→37 HTTP). Confirm the anonymous throttle set is UNTOUCHED.

- [ ] **Step 7: Validate & commit.**

```bash
pnpm validate   # expect green
git add -A && git commit -m "feat(api): GET /golfers/{golferId} — the golfer page's read; archive reads relax to any signed-in golfer"
```

---

### Task 2: Web nav primitives + infrastructure (GolferLink, titles, scroll, 404)

**Files:**
- Modify: `apps/web/src/ui/classes.ts` (add `linkEntity`)
- Create: `apps/web/src/ui/GolferLink.tsx`, `GolferLink.test.tsx`
- Create: `apps/web/src/ui/usePageTitle.ts`, `usePageTitle.test.tsx`
- Create: `apps/web/src/ui/ScrollToTop.tsx`
- Create: `apps/web/src/routes/NotFoundPage.tsx`, `NotFoundPage.test.tsx`
- Modify: `apps/web/src/App.tsx` (mount `ScrollToTop` inside `BrowserRouter`; add `path="*"` inside Layout)
- Modify (titles only): every existing page — HomePage (no arg), JoinRoundPage `Join a round`, CreateRoundPage `Start a round`, ProfilePage `Your profile`, CoursePage (course name once loaded), AddCoursePage `Add a course`, EditCoursePage (course name), CrewCreatePage `New crew`, CrewJoinPage (crew name from peek, else `Join a crew`), CrewPage (crew name), RoundPage + ArchivedRoundPage + WatchPage (`roundLabel(...)` they already compute)

**Interfaces:**
- Produces: `linkEntity` idiom string; `PlainNamesContext` (React context, default `false`) and `GolferLink({ golferId, name, className? })` — renders `<Link to={`/golfers/${golferId}`}>` wearing `linkEntity`, or a plain `<span>` when the context is `true`; `usePageTitle(title?: string)` — `document.title = title ? `${title} · swng` : "swng"`, resets to `swng` on unmount; `ScrollToTop` — null-rendering component; `NotFoundPage`.

- [ ] **Step 1: Idiom + GolferLink, test-first.** Tests: renders an anchor with `href="/golfers/g1"` and the name; inside `<PlainNamesContext.Provider value={true}>` renders a span, NO anchor. Implementation:

```tsx
import { createContext, useContext } from "react";
import { Link } from "react-router";
import { linkEntity } from "./classes";

// WatchPage's spectator tree turns every golfer link off at the root (spec §4c.2) — a context,
// not a prop threaded through four component layers.
export const PlainNamesContext = createContext(false);

export function GolferLink({ golferId, name, className }: { golferId: string; name: string; className?: string }) {
  if (useContext(PlainNamesContext)) return <span className={className}>{name}</span>;
  return (
    <Link to={`/golfers/${golferId}`} className={className ? `${linkEntity} ${className}` : linkEntity}>
      {name}
    </Link>
  );
}
```

- [ ] **Step 2: usePageTitle, test-first.** Tests (happy-dom): mounting sets `document.title` to `X · swng`; no-arg sets `swng`; unmount resets to `swng`; title-prop change updates.

```ts
import { useEffect } from "react";

export function usePageTitle(title?: string) {
  useEffect(() => {
    document.title = title ? `${title} · swng` : "swng";
    return () => {
      document.title = "swng";
    };
  }, [title]);
}
```

- [ ] **Step 3: ScrollToTop.**

```tsx
import { useEffect } from "react";
import { useLocation, useNavigationType } from "react-router";

// PUSH/REPLACE start a new page at the top; POP (back/forward) is left to the browser.
// react-router's own <ScrollRestoration> needs a data router — deliberately deferred (spec §8).
export function ScrollToTop() {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  useEffect(() => {
    if (navigationType !== "POP") window.scrollTo(0, 0);
  }, [pathname, navigationType]);
  return null;
}
```

Mount it as the first child of `<BrowserRouter>` in App.tsx.

- [ ] **Step 4: NotFoundPage + route, test-first.** Test: rendering an unknown path through the app's routes shows `This page doesn't exist.` and a link home. Page: `usePageTitle("Not found")`, the copy, `<Link to="/">` in the app's secondary idiom. Route: `<Route path="*" element={<NotFoundPage />} />` LAST inside the Layout route group.

- [ ] **Step 5: Titles across existing pages.** One `usePageTitle(...)` call per page listed above (dynamic pages pass the loaded name — the hook re-runs when it arrives). Add one RTL assertion in an existing test per DYNAMIC page (course/crew/round) that `document.title` lands; static pages are covered by the hook's own tests.

- [ ] **Step 6: Validate & commit** (`pnpm validate` green): `feat(web): nav primitives — GolferLink+PlainNames, page titles, scroll-to-top, a real 404`.

---

### Task 3: `/courses` hub + the header's Courses destination

**Files:**
- Create: `packages/domain/src/golfer/coursesPlayed.ts`, `coursesPlayed.test.ts` (export from the domain barrel like its `golfer/` siblings)
- Create: `apps/web/src/courses/CoursesHubPage.tsx`, `CoursesHubPage.test.tsx`
- Modify: `apps/web/src/App.tsx` (route `/courses` ahead of `/courses/:courseId`; header gains the Courses link)
- Modify: `apps/web/src/api.ts` ONLY IF `getMyRounds` (GET /me/rounds, parsing `getMyRoundsResponseSchema`) is not already there — grep first, add in the file's existing fetch idiom if missing
- Modify: `apps/web/src/App.test.tsx` (header assertions)

**Interfaces:**
- Consumes: `CourseSearch` UNCHANGED (its existing `onSelect(courseId, name)` callback — the hub navigates; form-filling callers keep their behavior); public `getCourse` from api.ts; `useAuth` (`golfer.homeCourseId`); `withAuth` + `getMyRounds`.
- Produces: `coursesPlayed(lines: readonly { courseId?: string; courseName: string }[]): readonly { courseId: string; name: string; rounds: number }[]` (a pure domain fold — structural param typing so wire lines pass straight in; input order is the lines' own newest-first, output preserves first-seen order = most-recent first); route `/courses`; header nav link.

- [ ] **Step 1: `coursesPlayed`, test-first in the domain.** Tests: two courses interleaved newest-first → grouped with correct counts in first-seen order; lines without `courseId` skipped; empty input → empty. Implement as a small pure fold in `domain/golfer/coursesPlayed.ts` (the `gameMembers` precedent — derivations over round lines are domain truth, never inline view logic), barrel-exported.

- [ ] **Step 2: Hub page, test-first.** Tests: (a) renders the `Courses` heading + `CourseSearch`; (b) selecting a search result navigates to `/courses/{id}` (MemoryRouter + a stubbed search selection); (c) signed in with `homeCourseId`: a "Your home course" card shows the fetched course name linking to its page; (d) signed in with rounds lines: "Courses you've played" renders `coursesPlayed`'s output as `name · N round(s)` rows each linking to the course page — pin one fixture with two courses and one courseId-less line; (e) signed out: heading + search + "Add a course" only. Implementation per spec §5: `usePageTitle("Courses")`; sections in spec order; the page maps lines through `coursesPlayed` and renders — no inline grouping; "Add a course" wears the secondary idiom (`btnSecondary`-class link) — NO gold on this page; names/course rows wear `linkEntity`.

- [ ] **Step 3: Routes + header.** `<Route path="/courses" element={<CoursesHubPage />} />` above `/courses/new` (react-router ranks exact over dynamic; keep declaration order readable as the file's comments already do). Header (Layout): between the wordmark and `AuthChrome`, on the right cluster:

```tsx
<nav className="flex items-center gap-3">
  <Link to="/courses" className="text-xs font-semibold tracking-widest text-forest uppercase">
    Courses
  </Link>
  <AuthChrome />
</nav>
```

Shown signed in AND signed out (course reads are public). The signed-out `/` landing keeps suppressing the whole header — untouched. Update App.test.tsx: header shows `Courses` in both auth states; landing page still has no header.

- [ ] **Step 4: Validate & commit**: `feat(domain,web): /courses hub — coursesPlayed in the domain, search that navigates, one header destination`.

---

### Task 4: The Golfer page + record extraction + person-parameterized source phrases

**Files:**
- Create: `apps/web/src/golfers/RecordSections.tsx`, `RecordSections.test.tsx` (extracted from ProfilePage: the index-over-time chart, typical-18, history list)
- Modify: `packages/domain/src/handicap/present.ts` + its test file (add `indexSourcePhrase` — the model owns the convention's words, the `formatHandicapIndex`/`strokesNote` precedent)
- Create: `apps/web/src/golfers/GolferPage.tsx`, `GolferPage.test.tsx`
- Modify: `apps/web/src/routes/ProfilePage.tsx` (consume both; render-identical)
- Modify: `apps/web/src/api.ts` (`getGolfer(token, golferId)` parsing `getGolferResponseSchema`)
- Modify: `apps/web/src/App.tsx` (route `/golfers/:golferId`)

**Interfaces:**
- Consumes: Task 1's wire (`GetGolferResponse`); Task 2's `GolferLink`/`usePageTitle`; the SignInCta funnel (`returnTo` = current path — the JoinRoundPage idiom); ProfilePage's existing `resolveIndex`/`formatHandicapIndex` imports.
- Produces: `RecordSections({ metrics, history, historyLimit? })` — renders chart + typical-18 + history rows; each history row is TWO SIBLING LINKS (no nesting): course name → `/courses/{courseId}` when present (plain text when absent), the score/remainder text → the round (this task: the existing `/rounds/{roundId}/archive` path; Task 5 retargets). `indexSourcePhrase(kind: IndexSource["kind"], person: "your" | "their"): string` in `@swng/domain` `handicap/present.ts` — the EXACT current ProfilePage strings for `your` (copy from the JSX, never retype), third-person variants `from all their rounds` / `their WHS index` / `their own`.

- [ ] **Step 1: Extract RecordSections (ProfilePage tests are the pin).** Move the chart/typical-18/history JSX out of ProfilePage byte-identically except: (a) props instead of closure state; (b) the history row's course-name span becomes its own `<Link>` when `line.courseId` is present (sibling of the row's round link — restructure the row so the anchors never nest, keeping the rendered text identical). Run the full ProfilePage test file — every existing assertion passes; add one new row assertion: course name has `href="/courses/{id}"`, the score half has the round href, and a courseId-less line renders the name as plain text.

- [ ] **Step 2: `indexSourcePhrase`, test-first in the domain.** In `handicap/present.ts` (alongside `formatHandicapIndex` — one-copy presentation truth): extract ProfilePage's three source-copy strings VERBATIM as the `"your"` arm (do not retype them — copy from the JSX); `"their"` arm per Global Constraints. Domain tests pin all six strings. ProfilePage switches to `indexSourcePhrase(kind, "your")`; its tests still pass unchanged (string-identical).

- [ ] **Step 3: api + page, test-first.** `GolferPage` tests: (a) signed out → SignInCta with `returnTo` the current `/golfers/{id}` path; (b) loaded: name `h1`, `plays off {formatted} · {indexSourcePhrase(kind, "their")}` (an unresolvable index renders the `—` treatment exactly as ProfilePage does), RecordSections rendered with the response's metrics/history; (c) API 404 → `This golfer isn't available` + a link home, no crash; (d) viewing yourself (golferId === auth.golfer.golferId) shows `This is you · your profile` linking `/profile`; (e) `usePageTitle` lands the golfer's name. Implement: fetch via `withAuth((t) => getGolfer(t, golferId))`; resolve/format through the SAME imports ProfilePage uses; no controls of any kind on this page.

- [ ] **Step 4: Route** `/golfers/:golferId` inside Layout. Validate & commit: `feat(domain,web): the Golfer page — any player's record, one extraction, the source phrases in the model`.

---

### Task 5: One address per round + redirect + retargets + home switchboard

**Files:**
- Rename/evolve: `apps/web/src/round/ArchivedRoundPage.tsx` → `apps/web/src/round/RoundRecordPage.tsx` (+ its test file; the archived rendering is absorbed per spec §7)
- Create: `apps/web/src/session/openLiveRound.ts` (extraction of HomePage's existing credential re-mint + navigate path)
- Modify: `apps/web/src/routes/HomePage.tsx` (use the extraction; add Recent rounds; remove the redundant body `h1 "swng"`)
- Modify: `apps/web/src/App.tsx` (`/rounds/:roundId` → RoundRecordPage; `/rounds/:roundId/archive` → param-aware `<Navigate replace>` redirect)
- Modify (retargets): every internal `/rounds/{id}/archive` link → `/rounds/{id}` — grep `apps/web/src` for `"/archive"`; known sites: the Task-4 history row, `SeasonPanel`'s counted rounds

**Interfaces:**
- Consumes: `getMyLiveRounds` + the re-mint call HomePage already makes (extract that exact code — verify it at `HomePage.tsx:93-97` before moving); Task 4's `RecordSections` history row for Home's Recent rounds; the SignInCta funnel.
- Produces: route `/rounds/:roundId` (the permanent address); `openLiveRound(roundId): Promise<void>` (re-mint then navigate — same signature the extracted code implies); the redirect.

- [ ] **Step 1: Extract `openLiveRound`** from HomePage's click handler (byte-identical move; HomePage consumes it; HomePage tests stay green).

- [ ] **Step 2: RoundRecordPage, test-first.** Existing ArchivedRoundPage tests carry over (renaming only). New tests: (a) archive fetch non-200 + the round IS in my live rounds → `openLiveRound` called and navigation to `/round/{id}`; (b) non-200 + not live → `This round isn't available. If someone sent you a code, join here` with a `/join` link; (c) signed out → SignInCta with `returnTo` = `/rounds/{id}`; (d) the redirect: rendering the app at `/rounds/x/archive` lands on `/rounds/x` (MemoryRouter assertion). Implement the resolution exactly in spec §7's order (archive → live-check → honest fallback); title stays `roundLabel(...)`.

- [ ] **Step 3: Redirect + retargets.** App.tsx:

```tsx
function ArchiveRedirect() {
  const { roundId } = useParams();
  return <Navigate to={`/rounds/${roundId}`} replace />;
}
```

Grep-sweep the retargets; assert with each touched file's existing tests (update hrefs).

- [ ] **Step 4: Home switchboard.** Add `Recent rounds` (eyebrow idiom): first 3 of `getMyRounds`, rendered by the SAME history-row component (`RecordSections`' row, exposed or `historyLimit={3}` — whichever keeps ONE row implementation), plus the quiet `all rounds → your profile` pointer (a `/profile` link, `sub`-mono treatment). Remove the redundant body `h1`. Tests: rows render with round hrefs; the pointer links `/profile`; the `h1` is gone (update any test that asserted it).

- [ ] **Step 5: Validate & commit**: `feat(web): one address per round — /rounds/:id resolves live or final; home becomes the switchboard`.

---

### Task 6: The link sweep + carve-out pins

**Files:**
- Modify: `apps/web/src/round/SetupPanel.tsx` (roster names → `GolferLink`)
- Modify: `apps/web/src/games/GamePanel.tsx` (every `nameOf(...)` render site → `GolferLink` with the same resolved name)
- Modify: `apps/web/src/round/ResultsView.tsx` (player names + game-result names → `GolferLink`)
- Modify: `apps/web/src/round/RoundRecordPage.tsx` + `apps/web/src/watch/WatchPage.tsx` (the `roundLabel` heading splits: course-name half → course link when `card.source?.courseId` present, date half plain; `roundLabel(...)` itself stays the title string)
- Modify: `apps/web/src/watch/WatchPage.tsx` (wrap the tree in `<PlainNamesContext.Provider value={true}>`)
- Modify: `apps/web/src/crews/CrewPage.tsx` (roster member names → `GolferLink`; badges/controls untouched)
- Modify: `apps/web/src/crews/SeasonPanel.tsx` (ledger `line.name` + head-to-head names → `GolferLink` via their `golferId`s)
- Modify: `apps/web/src/routes/ProfilePage.tsx` (home-course name → course link; `Change` button stays)
- Create: `apps/web/src/round/scoringSurface.structural.test.ts`

**Interfaces:**
- Consumes: Task 2's `GolferLink`/`PlainNamesContext`; each surface's already-present `golferId`s (`RosterEntry.golferId`, game lines' `golferId`, `SeasonStandingLine.golferId`, `HeadToHeadRecord.a/b`, `CrewMemberView.golferId`).
- Produces: nothing new — links only.

- [ ] **Step 1: Sweep, surface by surface, test-first per surface.** For each file: add/extend an RTL assertion that the name renders as a link with `href="/golfers/{id}"` (or the course href for the heading split), THEN wrap the render site in `GolferLink`. Rendered TEXT must be identical everywhere (the name strings don't change — only their element). GamePanel: keep `nameOf` for compound strings that stay plain sentences (e.g. inside `title` attributes if any); every visible standings/trail/story name becomes a link.

- [ ] **Step 2: The watch pin.** WatchPage provider + test: participant names render with NO anchor while the course-name heading DOES link (when courseId present). One more: WatchPage archived-state (ResultsView) names also plain — the context reaches the whole tree.

- [ ] **Step 3: The scoring-surface pin.** `scoringSurface.structural.test.ts` reads `ScorecardGrid.tsx` and `ScorePad.tsx` sources (node `fs`, same pattern as the repo's other structural tests) and asserts neither contains `react-router` — the mis-tap carve-out enforced against future drift.

- [ ] **Step 4: Validate & commit**: `feat(web): the link sweep — every noun's name is its address; scoring surface pinned linkless`.

---

### Task 7: E2E reconciliation

**Files:**
- Audit + modify as found: `apps/web/e2e/*.spec.ts`, `apps/web/e2e/support.ts`, root `e2e/` — grep for `/archive`, `/rounds/`, `getByRole` on links/headings the sweep or header touched
- Modify: `apps/web/e2e/primaryPath.spec.ts` (+1 beat), `apps/web/e2e/fieldTest.spec.ts` (+1 beat)

**Interfaces:** none — tests only.

- [ ] **Step 1: Locator/URL audit, verified locator-by-locator against the JSX** (the established lesson — string breakage is typecheck-invisible). Known risk sites: any `waitForURL`/assertion on `/rounds/{id}/archive` after an in-app click (now lands `/rounds/{id}` — direct navigations still work via redirect); header link-role queries that now also match `Courses`; profile history-row clicks (rows are now two sibling anchors — click the ROUND half explicitly); SeasonPanel counted-round clicks; any `getByText` that now resolves inside an anchor (RTL/Playwright text matching is element-agnostic — verify, don't assume).
- [ ] **Step 2: primaryPath +1 beat (all-browser):** after the existing profile-history assertion, click the history row's round link → the round record page renders → click the course-name link → the course page shows the course `h1`. **fieldTest +1 beat:** after finalize, browser B opens player A's name from ResultsView → A's golfer page renders A's name and record sections. (Golfer-page API coverage rides the browser beat; no new API-only spec.)
- [ ] **Step 3: Validate & commit**: `test(e2e): navigation reconciliation — round address clicks, golfer-page beat, courses header`. (Live e2e runs are the close-out gate, not this task.)

---

## Close-out (controller-run, not a task)

Deploy **lambda-first** (`pnpm deploy:beta` — new route + archive relaxation; old bundle unaffected) → `publishWeb` → `e2e:beta` ×2 → full `e2e:field` → the adversarial USE pass on deployed beta.swng.golf per spec §10 (two accounts; another golfer's page opened from a live round's panel; hub → course; a signed-out round link funneling through sign-in back to the round) → docs sweep (CLAUDE.md paragraph, route counts).
