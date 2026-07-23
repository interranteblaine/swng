# Crew-page UI papercuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two crew-page UI papercuts by converging on the app's existing shared idioms — the invite URL overflow and the oversized `Remove…`/`Make organizer…` roster buttons.

**Architecture:** Presentation-only. Route the crew invite through the shared `CopiedLinkLine` component (extended with one optional `note` prop) so it inherits the `break-all` wrap fix; add a `btnQuietDanger` sibling to the design-system idioms and apply the row-scale text register to the two roster buttons.

**Tech Stack:** React 19, Tailwind 4, Vitest + @testing-library/react (happy-dom).

**Spec:** `docs/superpowers/specs/2026-07-23-crew-page-ui-papercuts-design.md`

## Global Constraints

- **Presentation only.** No wire/schema/route change, no `deploy:beta`. `publish:web:beta` at close only.
- **The two existing `CopiedLinkLine` callers** (`round/ShareButton.tsx`, `round/SetupPanel.tsx`) pass no `note` and MUST render byte-identical output — the no-`note` branch is unchanged.
- **One-copy idiom discipline** (`ui/classes.ts`): shared class-string constants, never inline idiom strings re-typed at a call site.
- **Web tooling runs under `env -u NODE_OPTIONS`.** Single web test file: `env -u NODE_OPTIONS pnpm -F @swng/web exec vitest run <path>`. Full gate: `env -u NODE_OPTIONS pnpm validate`.
- `pnpm validate` green at every commit and at HEAD.

---

### Task 1: Invite overflow — converge the crew invite onto `CopiedLinkLine`

**Files:**
- Modify: `apps/web/src/ui/CopiedLinkLine.tsx`
- Test: `apps/web/src/ui/CopiedLinkLine.test.tsx`
- Modify: `apps/web/src/crews/CrewPage.tsx` (invite panel, ~377–382; add import)
- Test: `apps/web/src/crews/CrewPage.test.tsx` (two invite-copy assertions, lines 262 & 285)

**Interfaces:**
- Produces: `CopiedLinkLine` now accepts an optional `note?: string`. Rendered output: `` `${label} · ${note} — ` `` + the url span when `note` is set; `` `${label} — ` `` + the url span when it is not (unchanged). `label` is `"Link copied"` (copied) / `"Copy this link"` (not copied).

- [ ] **Step 1: Write the failing tests** — append to `apps/web/src/ui/CopiedLinkLine.test.tsx` (inside the existing `describe("CopiedLinkLine", …)` block):

```tsx
  it("sets an optional note off before the url's em-dash, url intact", () => {
    render(<CopiedLinkLine url={LONG_URL} copied note="good for 7 days" />);
    expect(screen.getByText(/Link copied · good for 7 days/)).toBeTruthy();
    expect(screen.getByText(LONG_URL)).toBeTruthy();
    expect(screen.getByText(LONG_URL).className).toContain("break-all");
  });

  it("omits the note entirely when none is passed — the existing callers render unchanged", () => {
    render(<CopiedLinkLine url={LONG_URL} copied={false} />);
    expect(screen.getByText(/Copy this link —/)).toBeTruthy();
    expect(screen.queryByText(/·/)).toBeNull();
  });
```

- [ ] **Step 2: Run the tests, verify the new note test fails**

Run: `env -u NODE_OPTIONS pnpm -F @swng/web exec vitest run src/ui/CopiedLinkLine.test.tsx`
Expected: the "sets an optional note…" test FAILS (no `note` prop yet — `Link copied · good for 7 days` not found); the "omits the note…" test PASSES already.

- [ ] **Step 3: Implement the `note` prop** — replace the whole `CopiedLinkLine` function body in `apps/web/src/ui/CopiedLinkLine.tsx` with:

```tsx
// The clipboard-fallback line, ONE copy (ShareButton's M9 discipline, shared with SetupPanel's
// invite link since 2026-07-21, and the crew invite since 2026-07-23): after a copy attempt the raw
// url is ALWAYS shown — clipboard access can silently fail, and a link is useless if the only sign of
// success is a toast that already vanished. `break-all` because a url is one unbroken token (a share
// link's token fragment especially) — without it the line is unbounded and runs off narrow screens
// (owner field report, 2026-07-21). An optional `note` states a link-scoped fact set off before the
// em-dash that introduces the url (the crew invite's 7-day expiry); omitted, the output is
// byte-identical for the round-share/round-invite callers.
export function CopiedLinkLine({
  url,
  copied,
  note,
  className,
}: {
  readonly url: string;
  readonly copied: boolean;
  readonly note?: string;
  readonly className?: string;
}) {
  const label = copied ? "Link copied" : "Copy this link";
  const lead = note ? `${label} · ${note} — ` : `${label} — `;
  return (
    <p className={`text-xs text-fairway${className ? ` ${className}` : ""}`}>
      {lead}
      <span className="font-mono break-all select-all">{url}</span>
    </p>
  );
}
```

- [ ] **Step 4: Run the CopiedLinkLine tests, verify all pass**

Run: `env -u NODE_OPTIONS pnpm -F @swng/web exec vitest run src/ui/CopiedLinkLine.test.tsx`
Expected: PASS (all cases, incl. the two existing break-all/label cases — the no-`note` branch is unchanged).

- [ ] **Step 5: Rewire the crew invite panel** — in `apps/web/src/crews/CrewPage.tsx`:

Add the import near the other `../ui/*` imports (e.g. after the `classes` import on line 10):

```tsx
import { CopiedLinkLine } from "../ui/CopiedLinkLine";
```

Replace the hand-rolled invite lines (currently):

```tsx
        {inviteUrl && (
          <>
            <p className="mt-2 text-xs text-fairway">{inviteCopied ? "Link copied — good for 7 days." : "Copy this link — good for 7 days."}</p>
            <p className="mt-1 select-all font-mono text-xs text-fairway/70">{inviteUrl}</p>
          </>
        )}
```

with:

```tsx
        {inviteUrl && <CopiedLinkLine url={inviteUrl} copied={inviteCopied} note="good for 7 days" className="mt-2" />}
```

- [ ] **Step 6: Update the two CrewPage invite-copy assertions** — the invite copy changed, so `apps/web/src/crews/CrewPage.test.tsx`:

Line 262: change
```tsx
    expect(await screen.findByText("Link copied — good for 7 days.")).toBeTruthy();
```
to
```tsx
    expect(await screen.findByText(/Link copied · good for 7 days/)).toBeTruthy();
```

Line 285: change
```tsx
    await waitFor(() => expect(screen.getByText("Copy this link — good for 7 days.")).toBeTruthy());
```
to
```tsx
    await waitFor(() => expect(screen.getByText(/Copy this link · good for 7 days/)).toBeTruthy());
```

(The `getByText(expectedUrl)` assertions on lines 263 & 286 are unchanged — `CopiedLinkLine` still renders the url as its own `<span>` text.)

- [ ] **Step 7: Run the CrewPage tests + full validate**

Run: `env -u NODE_OPTIONS pnpm -F @swng/web exec vitest run src/crews/CrewPage.test.tsx`
Expected: PASS.
Run: `env -u NODE_OPTIONS pnpm validate`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/ui/CopiedLinkLine.tsx apps/web/src/ui/CopiedLinkLine.test.tsx apps/web/src/crews/CrewPage.tsx apps/web/src/crews/CrewPage.test.tsx
git commit -m "fix(web): the crew invite renders through CopiedLinkLine — no more URL overflow

The crew invite panel hand-rolled its own copy-link line and so missed
CopiedLinkLine's break-all fix, overflowing narrow screens (owner field report).
Route it through the shared component instead; an optional note carries the
7-day expiry. All three copy-link surfaces now share one break-all-correct copy.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Oversized roster buttons — apply the row-scale text register

**Files:**
- Modify: `apps/web/src/ui/classes.ts` (add `btnQuietDanger`)
- Modify: `apps/web/src/crews/CrewPage.tsx` (roster buttons ~449 & 459; import line 10)
- Test: `apps/web/src/crews/CrewPage.test.tsx` (add one class-register assertion)

**Interfaces:**
- Consumes: `btnQuiet` (existing). Produces: `btnQuietDanger` — the oxblood text register.

- [ ] **Step 1: Add the `btnQuietDanger` idiom** — in `apps/web/src/ui/classes.ts`, immediately after the `btnQuiet` definition (line 28), add:

```ts
// The destructive sibling of btnQuiet — a row-scale text action that is also a careful one (a
// roster Remove…). Oxblood carries the "careful action" signal (the brand's second ink); the text
// register keeps it row-sized. The heavier oxblood weight (btnDanger's box, btnDangerSolid's fill)
// stays reserved for section-level actions and the confirm step.
export const btnQuietDanger = "text-oxblood underline decoration-oxblood/50 disabled:opacity-50";
```

- [ ] **Step 2: Write the failing test** — append to the `describe("CrewPage — organizer authority", …)` block in `apps/web/src/crews/CrewPage.test.tsx` (mirrors the setup of the existing "organizer sees Remove…/Make organizer…" test at line 310):

```tsx
  it("the row actions wear the quiet text register, not a boxed button (owner field report, 2026-07-23)", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann" } });
    mockedGetCrew.mockResolvedValue({ crew });
    mockedListSeasons.mockResolvedValue(emptySeasons);

    renderPage();
    await waitForLoaded();

    const roster = screen.getByRole("list", { name: /roster/i });
    const items = within(roster).getAllByRole("listitem");
    // happy-dom computes no layout, so the row register is pinned on the class that implements it
    // (the CopiedLinkLine break-all precedent): underline text, never the boxed border/tracking idiom.
    const remove = await within(items[1]!).findByRole("button", { name: /^remove…$/i });
    const makeOrganizer = within(items[1]!).getByRole("button", { name: /^make organizer…$/i });
    expect(remove.className).toContain("underline");
    expect(remove.className).toContain("text-oxblood");
    expect(remove.className).not.toContain("border");
    expect(makeOrganizer.className).toContain("underline");
    expect(makeOrganizer.className).not.toContain("border");
  });
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `env -u NODE_OPTIONS pnpm -F @swng/web exec vitest run src/crews/CrewPage.test.tsx`
Expected: the new test FAILS (buttons still wear `btnDanger`/`btnSecondary` — `border` present, `underline` absent).

- [ ] **Step 4: Swap the roster button idioms** — in `apps/web/src/crews/CrewPage.tsx`:

Extend the `classes` import (line 10) to include `btnQuietDanger`:

```tsx
import { badge, btnDanger, btnDangerSolid, btnPrimary, btnQuiet, btnQuietDanger, btnSecondary, cardBox, inputBox } from "../ui/classes";
```

For the `Remove…` button (currently `className={btnDanger}`, ~line 449), change to:

```tsx
                        className={btnQuietDanger}
```

For the `Make organizer…` button (currently `className={btnSecondary}`, ~line 459), change to:

```tsx
                        className={btnQuiet}
```

(Leave the wrapping `<span className="flex items-center gap-3">`, the confirm-step `btnDangerSolid`/`btnSecondary`, and the section-level `Leave crew` `btnDanger` unchanged — they are correctly boxed per the spec.)

- [ ] **Step 5: Run the CrewPage tests + full validate**

Run: `env -u NODE_OPTIONS pnpm -F @swng/web exec vitest run src/crews/CrewPage.test.tsx`
Expected: PASS (incl. the new register test; the existing name-queried Remove…/Make organizer… tests stay green).
Run: `env -u NODE_OPTIONS pnpm validate`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/ui/classes.ts apps/web/src/crews/CrewPage.tsx apps/web/src/crews/CrewPage.test.tsx
git commit -m "fix(web): roster Remove…/Make organizer… wear the row text register

The two roster-row actions used the oversized boxed btnDanger/btnSecondary
idioms; btnQuiet's own contract reserves boxed buttons for section-level actions.
Add a btnQuietDanger sibling (oxblood text register, keeping the destructive
signal) for Remove… and use btnQuiet for Make organizer… — the register the
crew-name Edit already wears.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** Fix 1 (invite overflow → Task 1), Fix 2 (roster buttons → Task 2), the "stays as-is" set left untouched by construction (only the two named buttons and the invite panel change). Both spec fixes map to a task.
- **Placeholder scan:** none — every step carries its exact code and command.
- **Type consistency:** `note?: string` (Task 1) is the only signature change; consumed only by CrewPage's invite render (Task 1 step 5) with a string literal. `btnQuietDanger` (Task 2) is a `string` const consumed as a className. No cross-task type drift.
- **Note on the spec's testing line:** the spec said existing CrewPage tests "stay green with no edits" — true for the button restyle (Task 2, name-queried), but Fix 1 changes the invite *copy*, so Task 1 step 6 updates the two invite-copy assertions. Called out explicitly so it is not mistaken for a regression.
