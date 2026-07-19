# Brand Reskin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `apps/web` adopts the marketing site's identity end to end (cream/forest/gold/oxblood, system font, square corners), the signed-out home becomes the landing page, and the stale-session 401-on-load dies.

**Architecture:** One Tailwind 4 `@theme` token block + one shared class-idiom module, then a surface-by-surface presentational sweep under a strict "recolor, never re-behave" invariant. Two behavior exceptions, each its own task: the signed-out door (spec §3) and the auth polish (spec §7). Whole-tree grep gates make legacy styling unrepresentable.

**Tech Stack:** React 19, Tailwind 4 (CSS-first `@theme`), Vitest + happy-dom, Playwright e2e (reconciled, not run, inside tasks).

**Spec:** `docs/superpowers/specs/2026-07-19-brand-reskin-design.md` — binding on every task. Mockups: https://claude.ai/code/artifact/ff994673-e55b-4bb9-a892-ec59186121c6

## Global Constraints

- **Recolor, retype, re-shape — never re-behave.** Outside Task 2 (door) and Task 7 (auth), component logic, props, handlers, routes, roles, aria attributes, and user-facing copy are byte-unchanged. A sweep task that edits a string literal shown to users (other than `className`) is out of spec.
- **Tokens are the only hexes.** All color values live in `apps/web/src/styles.css`'s `@theme`. Components use token classes (`bg-cream`, `text-forest`, …). SVG uses `currentColor` + a token text class.
- **Idioms are one copy.** Buttons/cards/inputs/eyebrows compose from `apps/web/src/ui/classes.ts`. Re-typing an idiom's class string inline is a review defect.
- **Gold once per screen** — the primary action or the current-hole wash, never data ink, never text on cream.
- **Oxblood's jobs only** (spec §2): under-par scores, picked-up/conceded glyphs, input placeholders, careful actions, error text.
- **Square corners:** every `rounded*` class is deleted, no exceptions (the two `rounded-full` badges become square chips).
- **Uppercase is CSS** (`uppercase tracking-widest` on button idioms) — JSX copy stays sentence-case. Unit tests (happy-dom reads `textContent`) keep sentence-case matchers. Playwright accnames DO uppercase (Chromium applies text-transform) — e2e reconciliation is Task 8, not run inside sweep tasks.
- **Class mapping table** (mechanical swaps; per-site judgment where marked):

  | old | new |
  |-----|-----|
  | `bg-slate-950` | `bg-cream` |
  | `bg-slate-900` (panels/sheets) | `bg-card` + `border border-hairline`; bottom sheets get `border-t-2 border-forest` |
  | `bg-slate-800` (boxes) | `cardBox` idiom (`bg-card border border-hairline`); as filled badge → `bg-fairway text-cream` (judgment) |
  | `bg-slate-700` / `bg-slate-600` | `bg-fairway text-cream` |
  | `text-slate-50/100/200` | `text-forest` on cream/card; `text-cream` on forest/oxblood fills (judgment) |
  | `text-slate-300` / `text-slate-400` | `text-fairway` |
  | `text-slate-500` | `text-fairway/70` |
  | `border-slate-800` | `border-hairline` (header rule: `border-forest`) |
  | `decoration-slate-*` | `decoration-gold` on identity/name links; else `decoration-fairway` |
  | `bg-emerald-600` (buttons) | `btnPrimary` iff the screen's ONE primary action, else `btnSecondary` (judgment) |
  | `text-emerald-400` (links) | `text-forest underline decoration-gold decoration-2` |
  | `text-emerald-400` (status/accent) | `text-fairway` |
  | `bg-emerald-950` (current-hole row) | `bg-goldwash` |
  | `bg-emerald-700` / `border-emerald-500` (active/selected) | `bg-forest text-cream` / `border-forest` |
  | `text-red-*` (errors) | `text-oxblood` |
  | `bg-red-700/800/900` (danger buttons) | `btnDangerSolid` (confirm commit) or `btnDanger` (trigger) (judgment) |
  | `bg-red-950`-style alert boxes | `border border-oxblood bg-card text-oxblood` |
  | `text-amber-*` (score glyphs) | `text-oxblood` |
  | `bg-amber-950/900` (warning banners) | `bg-goldwash border border-gold text-forest` |
  | any `rounded*` | delete |

- **Per-task hygiene:** `pnpm validate` green before every commit; each sweep task updates its own surfaces' co-located tests (class/copy assertions) in the same commit.
- Run all commands from the repo root. Never push.

---

### Task 1: Foundation — tokens and idioms

**Files:**
- Modify: `apps/web/src/styles.css`
- Create: `apps/web/src/ui/classes.ts`
- Modify: `apps/web/index.html`

**Interfaces:**
- Produces: token utility classes (`bg-cream`, `text-forest`, `bg-card`, `border-hairline`, `bg-gold`, `bg-goldwash`, `text-oxblood`, `text-fairway`, `bg-forest`, `text-cream`, …) and the named idiom exports below, consumed by every later task.

- [ ] **Step 1: Replace `apps/web/src/styles.css` with the theme**

```css
@import "tailwindcss";

/* The brand tokens — the ONE place hex values live (spec §2). Light-only by owner call;
   a dark variant later is a token flip, not a redesign. */
@theme {
  --color-forest: #1c2b22;
  --color-fairway: #3d5a45;
  --color-cream: #f7f5ef;
  --color-card: #fffdf8;
  --color-hairline: #ddd8c9;
  --color-gold: #c9a356;
  --color-goldwash: #f3e9d2;
  --color-oxblood: #8b3a3a;
  --font-serif: Georgia, "Iowan Old Style", serif;
  --font-mono: "Courier New", Courier, monospace;
}

@layer base {
  body {
    background-color: var(--color-cream);
    color: var(--color-forest);
  }
}
```

(No `--font-sans` override — Tailwind's default IS the system stack, spec §1.)

- [ ] **Step 2: Create `apps/web/src/ui/classes.ts`**

```ts
// The shared visual idioms (spec §6) — class-string constants so <button>, <Link>, and
// <input> can all wear them. One copy: composing surfaces import these; re-typing an
// idiom inline is a review defect. Uppercase is CSS — JSX copy stays sentence-case.
export const btnPrimary =
  "bg-gold px-6 py-4 text-center text-sm font-bold tracking-widest text-forest uppercase";
export const btnSecondary =
  "border border-forest px-6 py-3.5 text-center text-sm font-semibold tracking-widest text-forest uppercase";
export const btnCreamOutline =
  "border border-cream/55 px-6 py-3 text-center text-sm font-semibold tracking-widest text-cream uppercase";
export const btnDanger =
  "border border-oxblood px-4 py-3 text-center text-sm font-semibold tracking-widest text-oxblood uppercase";
export const btnDangerSolid =
  "bg-oxblood px-4 py-3 text-center text-sm font-semibold tracking-widest text-cream uppercase";
export const cardBox = "border border-hairline bg-card";
export const eyebrow = "font-mono text-[11px] tracking-[2px] text-fairway uppercase";
export const inputBox =
  "border border-hairline bg-card px-3 py-3 text-forest placeholder:text-oxblood";
export const inputCode =
  "border border-hairline bg-card px-3 py-3 font-mono tracking-[2px] text-forest placeholder:text-oxblood";
```

- [ ] **Step 3: Add the theme-color meta to `apps/web/index.html`** — inside `<head>`, after the viewport meta:

```html
    <meta name="theme-color" content="#f7f5ef" />
```

- [ ] **Step 4: `pnpm validate` (expect green — nothing consumes the tokens yet), commit**

```bash
git add apps/web/src/styles.css apps/web/src/ui/classes.ts apps/web/index.html
git commit -m "feat(web): brand theme tokens + shared class idioms (reskin foundation)"
```

---

### Task 2: The doors — landing page, signed-in home, header chrome

**Files:**
- Modify: `apps/web/src/App.tsx` (Layout header suppression + header restyle)
- Modify: `apps/web/src/routes/HomePage.tsx` (signed-out door + signed-in reskin)
- Modify: `apps/web/src/auth/SignInButton.tsx`, `apps/web/src/auth/SignInCta.tsx` (restyle only)
- Test: `apps/web/src/App.test.tsx`, `apps/web/src/routes/HomePage.test.tsx`, `apps/web/src/auth/SignInButton.test.tsx`, `apps/web/src/auth/SignInCta.test.tsx`

**Interfaces:**
- Consumes: Task 1 idioms; existing `useAuth()` (`signedIn`, `signIn`), `useNavigate`, `SignInCtaProps` (unchanged).
- Produces: the door DOM later tasks/e2e see — hero `h1`, one `button "Sign in"`, `input` aria-label `"Round code"`, `button "Join"`; header absent iff signed out on `/`.

Spec §3 copy is verbatim and binding. The signed-out door replaces BOTH `SignInCta`s on
HomePage and the "Your rounds" signed-out branch; signed-in HomePage keeps every piece of
existing logic (`isIdentityLoading`, `enterLiveRound`, `handleLiveRoundClick`, collision
labels) byte-identical — classNames and layout only.

- [ ] **Step 1: Failing tests first** — in `HomePage.test.tsx` add (adapting the file's existing render/auth harness):

```tsx
it("signed out: the door has exactly one sign-in button and no rounds section", () => {
  renderSignedOut(<HomePage />);
  expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(1);
  expect(screen.getByText("swng is the app for the golf you actually play.")).toBeTruthy();
  expect(screen.queryByText("Your rounds")).toBeNull();
  expect(screen.queryByText("Sign in to see your rounds.")).toBeNull();
});

it("signed out: the door's code input routes into the join funnel with the code", () => {
  renderSignedOut(<HomePage />);
  fireEvent.change(screen.getByLabelText("Round code"), { target: { value: "  qk7m2a " } });
  fireEvent.click(screen.getByRole("button", { name: "Join" }));
  expect(navigateSpy).toHaveBeenCalledWith("/join?code=qk7m2a");
});

it("signed out: an empty code input routes to the bare join page", () => {
  renderSignedOut(<HomePage />);
  fireEvent.click(screen.getByRole("button", { name: "Join" }));
  expect(navigateSpy).toHaveBeenCalledWith("/join");
});
```

  In `App.test.tsx`: replace the "shows the Sign in header chrome when signed out" test with two — signed out on `/` renders NO `banner`; signed out on `/join` renders the banner with its compact Sign in.

- [ ] **Step 2: Run them, watch them fail** (`pnpm -F @swng/web vitest run src/routes/HomePage.test.tsx src/App.test.tsx`)

- [ ] **Step 3: Implement the door.** HomePage's signed-out return becomes (structure binding, exact classes may flex within the idioms):

```tsx
if (!signedIn) {
  return (
    <main className="flex min-h-screen flex-col bg-cream">
      <section className="flex flex-1 flex-col gap-4 p-7 pt-11">
        <h1 className="text-3xl font-extrabold tracking-tight text-forest text-balance">
          swng is the app for the golf you actually play.
        </h1>
        <p className="font-serif text-lg text-fairway">Fair matches, layered games, a record that lasts.</p>
        <button type="button" onClick={() => signIn()} className={`${btnPrimary} mt-3`}>
          Sign in
        </button>
        <p className="font-serif text-sm text-fairway">New here? Signing in creates your account.</p>
      </section>
      <section className="flex flex-col gap-2.5 bg-forest p-7">
        <h2 className="text-xl font-bold text-cream">Playing today?</h2>
        <p className="font-serif text-sm text-cream/70">Join a round with the code from your group.</p>
        <form
          className="mt-2 flex gap-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = doorCode.trim();
            navigate(trimmed ? `/join?code=${encodeURIComponent(trimmed)}` : "/join");
          }}
        >
          <input
            aria-label="Round code"
            placeholder="ROUND CODE"
            value={doorCode}
            onChange={(event) => setDoorCode(event.target.value)}
            className={`${inputCode} min-w-0 flex-1`}
          />
          <button type="submit" className={btnCreamOutline}>
            Join
          </button>
        </form>
        <p className="mt-4 font-mono text-[11px] text-cream/45">swng &copy; 2026</p>
      </section>
    </main>
  );
}
```

  (`doorCode` is a new `useState("")` — the only new state; `useAuth` gains no surface.) The signed-in return keeps ALL current branches, reskinned per the mapping table: `btnPrimary` Link "Start a round", `btnSecondary` Link "Join by code", `eyebrow` "Your rounds", round rows `cardBox border-l-[3px] border-l-fairway` with `font-serif` course line + `font-mono text-fairway` date line; `enterError` → `text-oxblood`.

- [ ] **Step 4: Layout suppression in `App.tsx`** — Layout learns exactly one condition:

```tsx
function Layout() {
  const { signedIn } = useAuth();
  const { pathname } = useLocation();
  // The signed-out home IS the landing page (spec §3): no app header — the hero's first
  // word is the wordmark. Every other route, signed out or in, keeps the chrome.
  if (!signedIn && pathname === "/") return <Outlet />;
  return (
    <div className="min-h-screen bg-cream">
      <header className="flex items-center justify-between gap-4 border-b-[1.5px] border-forest px-4 py-3 text-forest">
        <Link to="/" className="text-lg font-extrabold tracking-tight">swng</Link>
        <AuthChrome />
      </header>
      <Outlet />
    </div>
  );
}
```

  AuthChrome signed-in: name link `font-mono text-xs text-fairway underline decoration-gold decoration-2 underline-offset-3`, Sign out `font-mono text-xs text-fairway`. `SignInButton`: `btnPrimary` at compact padding (`px-3 py-2 text-xs`). `SignInCta`: `cardBox p-4 flex flex-col gap-3`, message `font-serif text-fairway`, button `btnPrimary` — copy and `returnTo` seam untouched.

- [ ] **Step 5: Update the remaining existing tests** in the four test files whose assertions name old copy/structure (e.g. HomePage's old "Sign in to start a round." branch) — behavior assertions stay, dead-branch assertions die.

- [ ] **Step 6: `pnpm validate`, commit** — `feat(web): the doors — landing page signed out, brand chrome everywhere`

---

### Task 3: Sweep — funnel, create, setup

**Files (modify + their co-located tests):**
- `apps/web/src/routes/JoinRoundPage.tsx`, `apps/web/src/routes/CreateRoundPage.tsx`, `apps/web/src/routes/AuthCallbackPage.tsx`, `apps/web/src/round/SetupPanel.tsx`

**Interfaces:** Task 1 idioms only. No copy, logic, or DOM-role change (Global Constraints).

- [ ] **Step 1:** Apply the mapping table + idioms to each file. Judgment notes: each page's submit ("Join round", "Create round") is its screen's `btnPrimary`; tee pickers/selected states use `border-forest`/`bg-forest text-cream` for selection; form inputs → `inputBox`; join-code display/copy affordances → `font-mono`; SetupPanel's share-the-code panel → `cardBox` with the code in `font-mono` (placeholder-red only for placeholders, not the code itself); roster lines (`name — tee — CH X`) → name sans, `tee — CH` segment `font-mono text-fairway`.
- [ ] **Step 2:** Update these surfaces' tests where they assert old classes (they mostly assert roles/copy — expect few edits).
- [ ] **Step 3:** `pnpm validate`, commit — `feat(web): reskin — join/create funnel and setup`

---

### Task 4: Sweep — the round (grid, pad, chips, panels, results) + the under-par ink

**Files:**
- Modify: `packages/domain/src/scoring/present.ts` (+ its test) — add `underPar`
- Modify (+ co-located tests): `apps/web/src/routes/RoundPage.tsx`, `apps/web/src/round/ScorecardGrid.tsx`, `apps/web/src/round/ScorePad.tsx`, `apps/web/src/round/StandingsHeader.tsx`, `apps/web/src/games/GamePanel.tsx`, `apps/web/src/round/AddGameForm.tsx`, `apps/web/src/round/ResultsView.tsx` and the finalize dialog (wherever it lives in `round/`)

**Interfaces:**
- Produces: `export const underPar = (score: number, par: number): boolean => score < par;` in `@swng/domain` `scoring/present.ts` (barrel-exported beside `gameKindLabel` — a presentation helper, fence-ALLOWED, do NOT add it to the eslint banlist).

- [ ] **Step 1: `underPar` first, TDD** — in `packages/domain/src/scoring/present.test.ts` (or the file's existing test home):

```ts
it("underPar is golf's red-numbers convention: strictly below par", () => {
  expect(underPar(3, 4)).toBe(true);
  expect(underPar(4, 4)).toBe(false);
  expect(underPar(5, 4)).toBe(false);
});
```

  Run (fail) → implement → run (pass).
- [ ] **Step 2: ScorecardGrid** — mapping table plus, specifically: grid container `cardBox`; header row `bg-forest` with `font-mono text-[10px] uppercase tracking-wide text-cream` column labels and sans `font-bold` player names; hole/par/SI cells `font-mono text-fairway`; score cells sans `font-semibold tabular-nums text-forest`; current-hole row `bg-goldwash` (replacing `bg-emerald-950`); picked-up/conceded glyphs `text-oxblood` (replacing amber); dots keep `text-forest`. Apply oxblood ink: gross `className` gains `text-oxblood` iff `underPar(gross, hole.par)`, the net sub-line iff `underPar(net, hole.par)` (import `underPar` from `@swng/domain`).
- [ ] **Step 3: ScorePad** — number keys as `cardBox` squares with sans semibold numerals; picked-up/conceded keys `text-oxblood`; "Clear score" → `btnDanger`.
- [ ] **Step 4: StandingsHeader + GamePanel + AddGameForm** — chips: `border border-forest px-3 py-1 text-left` (inactive `text-forest bg-transparent`, active/expanded `bg-forest text-cream`, "Ended" badge `bg-fairway text-cream px-1`); the "+ Add game" affordance `border-dashed border-fairway text-fairway`; the End-game confirm sheet: `bg-card border-t-2 border-forest` with `btnDangerSolid` commit + `btnSecondary` cancel; GamePanel region `cardBox`; AddGameForm radio-cards `cardBox` with `border-forest` selection; "End game…" trigger → `btnDanger`.
- [ ] **Step 5: RoundPage shell + offline chrome + ResultsView/finalize** — mapping table; offline/queue banner → `bg-goldwash border border-gold text-forest`; finalize dialog commit is that screen's `btnPrimary`, "End unfinished games & finalize" variant `btnDangerSolid`; "Scrap round" → `btnDanger`.
- [ ] **Step 6:** Update co-located tests (ScorecardGrid's class regression test from the standard-card arc — `text-slate-100` — moves to the new token class; glyph-color assertions to oxblood).
- [ ] **Step 7:** `pnpm validate`, commit — `feat(domain,web): reskin — the round wears the card; under-par ink is domain truth`

---

### Task 5: Sweep — the record (profile, archive, watch)

**Files (modify + co-located tests):**
- `apps/web/src/routes/ProfilePage.tsx`, `apps/web/src/round/ArchivedRoundPage.tsx`, `apps/web/src/watch/WatchPage.tsx`

- [ ] **Step 1:** Mapping table throughout. ProfilePage specifics: the index-over-time chart recolors via existing `className`s on the SVG elements — swng polyline + dots `text-forest` (was `text-emerald-400`), WHS dashed polyline + hollow dots `text-fairway` (was `text-slate-400`); chart canvas `cardBox`; **gold is never data ink** (spec §5). "Use this" / Save = the screen's primary judgment: Save is `btnPrimary`, "Use this" links `text-forest underline decoration-gold`. History rows `cardBox` with mono dates/differentials. WatchPage/ArchivedRoundPage inherit the grid's Task-4 look automatically (shared components) — this task sweeps only their own chrome.
- [ ] **Step 2:** Update co-located tests (ProfilePage asserts chart testids, not colors — expect few edits).
- [ ] **Step 3:** `pnpm validate`, commit — `feat(web): reskin — profile record, archive, watch`

---

### Task 6: Sweep — courses and crews

**Files (modify + co-located tests):**
- `apps/web/src/courses/CourseSearch.tsx`, `CourseSummaryCard.tsx`, `CoursePage.tsx`, `AddCoursePage.tsx`, `EditCoursePage.tsx`, `HoleGrid.tsx`
- `apps/web/src/crews/CrewPage.tsx`, `CrewCreatePage.tsx`, `SeasonPanel.tsx`, `apps/web/src/routes/CrewJoinPage.tsx`

- [ ] **Step 1:** Mapping table throughout. Judgment notes: HoleGrid's editable 18-hole entry grid → `cardBox` cells with `inputBox`-style fields (keyboard-first tab order untouched); course cards in search results → `cardBox`; CrewPage's two `rounded-full` badges ("account", "organizer") → square `bg-fairway text-cream px-1.5 py-0.5 font-mono text-[10px] uppercase` chips; organizer remove/transfer controls → `btnDanger`/`btnSecondary`; the season ledger table gets `font-mono tabular-nums` numerals with `hairline` rules.
- [ ] **Step 2:** Update co-located tests.
- [ ] **Step 3:** `pnpm validate`, commit — `feat(web): reskin — courses and crews`

---

### Task 7: Auth polish — proactive refresh, background degrade

**Files:**
- Modify: `apps/web/src/auth/useAuth.ts`
- Test: `apps/web/src/auth/useAuth.test.tsx`

**Interfaces:** `AuthContextValue` is UNCHANGED. `signOut` keeps the Cognito `/logout` redirect; a new private `clearLocalSession` does tokens+golfer clearing with NO redirect.

- [ ] **Step 1: Failing tests first** (adapt to the file's existing fetch/tokenStore mocking harness):

```tsx
it("withAuth refreshes FIRST when the stored token is at/past expiry — the callee never sees the stale token", async () => {
  // tokens with expiresAt = Date.now() - 1000 in the store; refresh endpoint returns a fresh id_token
  const seen: string[] = [];
  await result.current.withAuth(async (token) => { seen.push(token); });
  expect(seen).toEqual(["fresh-id-token"]); // exactly one call, already fresh — no 401 round trip
  expect(fetchMock).toHaveBeenCalledWith(tokenEndpoint(), expect.anything()); // the refresh
});

it("withAuth refreshes proactively inside the 60s skew window", async () => {
  // expiresAt = Date.now() + 30_000 → still refreshes first
});

it("withAuth does NOT refresh a comfortably-valid token", async () => {
  // expiresAt = Date.now() + 3_600_000 → fn called with stored token, no token-endpoint fetch
});

it("a failed background refresh degrades in place: session cleared, golfer undefined, NO redirect", async () => {
  // expired tokens + refresh endpoint 400 → withAuth rejects, tokenStore.clear() called,
  // golfer === undefined, window.location.assign NOT called
});

it("explicit signOut still redirects through Cognito /logout", () => {
  // unchanged behavior — pins the split
});
```

- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement.** In `useAuth.ts`: extract `clearLocalSession` (the body of today's `signOut` minus `window.location.assign`); `signOut` = `clearLocalSession` + the redirect. In `withAuth`: before the first `fn` call, `if (current.expiresAt <= Date.now() + 60_000)` → `requestTokenRefresh` first (on success save/apply the refreshed tokens then call `fn` once; on failure `clearLocalSession()` and throw the original-style `ApiError("not-signed-in", …)`-adjacent error — rethrow semantics preserved for callers). Replace BOTH existing `signOut()` calls inside `withAuth`'s failure paths with `clearLocalSession()` — the redirect now belongs to the button alone. Keep the reactive 401→refresh→retry net intact.
- [ ] **Step 4: Run the full auth suite** (`pnpm -F @swng/web vitest run src/auth`), then `pnpm validate`, commit — `fix(web): stale sessions refresh before they 401; background auth failure never navigates`

---

### Task 8: Reconciliation — gates, stragglers, e2e locators

**Files:** whatever the gates surface; `apps/web/e2e/*.spec.ts`, `apps/web/e2e/support.ts` (locators only); any missed `apps/web/src` file.

- [ ] **Step 1: Run the whole-tree gates; fix every hit:**

```bash
grep -rE '(slate|emerald|amber|zinc|gray|stone|neutral|sky|blue|red)-[0-9]' apps/web/src   # expect empty
grep -rE '\brounded(-[a-z0-9]+)?\b' apps/web/src                                            # expect empty
find apps/web -name '*.woff*' -o -name '*.ttf' -o -name '*.otf'                             # expect empty
grep -rE '#[0-9a-fA-F]{6}\b' apps/web/src --include='*.tsx'                                 # expect empty
```

- [ ] **Step 2: e2e locator sweep, verified locator-by-locator against the JSX** (the games-legibility lesson — string breakage is typecheck-invisible). Known breakage classes to check: (a) uppercase-styled controls — any `getByRole(…, { name: "…", exact: true })` on a button/link that now wears an `uppercase` idiom moves to a case-insensitive regex (`{ name: /start a round/i }`); (b) `App.test`-style assumptions that a header exists on the signed-out home (fieldTest's funnel CTA is on `/join` — unaffected — but verify); (c) any locator touching removed home copy ("Sign in to start a round." etc.). Do NOT run the live suites here (they need the deployed bundle); static verification + typecheck only.
- [ ] **Step 3:** `pnpm validate`, commit — `test(e2e): reconcile locators with the reskin (uppercase accnames, the new door)`

---

### Close-out (controller-run, NOT a subagent task)

1. Whole-branch review (most capable model) with the review package over the full arc range.
2. `pnpm validate` at HEAD.
3. `node scripts/publishWeb.mjs` (beta) — web-only arc: NO `deploy:beta`, no data change.
4. `pnpm e2e:beta` ×2 (backend-regression sanity — should be untouched by a web arc).
5. Full `pnpm e2e:field` against beta (all specs); fix stale oracles as controller if the product is right and the pin is stale — re-derive, never loosen.
6. **Adversarial USE pass** on deployed beta.swng.golf, phone viewport, as a player: the signed-out door (one sign-in, code input into the funnel), sign-in round trip, a round with a real birdie (the oxblood ink), a mis-tap cleared, chips/panels/pad in the new skin, profile chart forest/fairway, and the 401 check — a stale-`expiresAt` session must load with a clean console and no redirect.
7. Docs sweep: CLAUDE.md arc paragraph + ledger close + memory updates if earned.
