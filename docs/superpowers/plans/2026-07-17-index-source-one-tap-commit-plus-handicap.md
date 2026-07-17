# Index source: one-tap commit + domain-owned plus-handicap display — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Make picking an index source commit on tap (one PUT, no staged state, no revert, no
three-request save), and move the plus-handicap convention (`+1.2`, give-vs-receive) into ONE tested
`@swng/domain` place that every surface — profile, create/join, and the scorecard — renders through
thinly, so no view decides a sign's meaning and give-back can't be silently dropped.

**Authority:** `docs/superpowers/specs/2026-07-17-index-source-one-tap-commit-plus-handicap-design.md`
is the source of truth. Read it first. It supersedes §6 of the index-source-model spec; the
`IndexSource` model, `resolveIndex`, the wire, and the handicap engine are unchanged and must not be
touched.

**Architecture:** `@swng/domain` gains two pure presentation functions (consumed only by the web —
no backend change); `@swng/web` renders through them and fixes the commit interaction. `updateMe`
already returns the updated `GolferView` and already accepts an `indexSource`-only body. No wire /
schema / storage change → no `deploy:beta`, no migration; the close-out is `publishWeb` + gates + a
real walk.

**Tech Stack:** TypeScript ESM, React 19, Vitest + happy-dom, Playwright.

## Global Constraints

- **One tap commits (spec §2).** "Use this" / "Use this number" each issue exactly ONE `PUT /me`
  with `{ indexSource }` and update `auth.golfer` from the response — no staged `pendingSource`, no
  separate Save for the index, no `refetch`. The active source is `auth.golfer.indexSource`.
- **Name + home course keep their own Save** (PUT /me `{ name, homeCourseId }`, NO `indexSource`),
  also via `applyGolfer`, not `refetch`.
- **Golf convention lives in the domain (spec §3), never in a view.** `formatHandicapIndex(value)`
  (the `+` convention) and `strokeGrant(signed)` (`receives`/`gives`/`none`) are the ONE place a
  sign becomes meaning. Every index/stroke surface renders through them. Raw differentials stay
  signed. The stored/wire number is unchanged.
- **Scorecard give-back is rendered, not hidden:** `●` received, `○` given, net whenever dots ≠ 0.
- Conditional-spread optional keys — never an explicit `undefined` value (ESLint-enforced).
- `pnpm validate` GREEN at the end of each task.
- If a node/pnpm command dies with a `MODULE_NOT_FOUND` cmux/NODE_OPTIONS preload error, re-run
  prefixed with `NODE_OPTIONS=`.
- Commit per task; `feat`/`fix(web|domain): …` + the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer. Do NOT push.
- Controller-only (not a task): `publishWeb`, live gates, the browser walk, CLAUDE.md.

---

### Task 1: One tap commits the source (kills the revert + the three-request save)

**Files:**
- Modify: `apps/web/src/auth/useAuth.ts` (add `applyGolfer`)
- Modify: `apps/web/src/routes/ProfilePage.tsx` (the "Your index" section + the name/home Save)
- Test: `apps/web/src/auth/useAuth.test.tsx`, `apps/web/src/routes/ProfilePage.test.tsx`

**Interfaces (Produces):** `AuthContextValue.applyGolfer(view: GolferView): void` — sets the auth
golfer in place (no network), for a caller holding a fresh view (a `PUT /me` response).

- [ ] **Step 1:** In `useAuth.ts`, add to `AuthContextValue` (beside `refetch`, ~line 24):

```ts
  // Replace `golfer` from a view the caller already holds (a PUT /me response) — no network.
  // The one-request counterpart to `refetch` for a caller that just wrote the row itself.
  readonly applyGolfer: (view: GolferView) => void;
```

- [ ] **Step 2:** Implement near `refetch` (~line 128) and add to the `value` object (~line 170):

```ts
  const applyGolfer = useCallback((view: GolferView) => setGolfer(view), []);
```
  and `applyGolfer,` beside `refetch,` in `value`.

- [ ] **Step 3:** Test (`useAuth.test.tsx`): after `applyGolfer(view)`, `auth.golfer === view` and
  the `getMe` mock call count is unchanged across the call (no refetch).

- [ ] **Step 4:** Run: `NODE_OPTIONS= pnpm -F @swng/web vitest run src/auth/useAuth.test.tsx` — PASS.

- [ ] **Step 5:** `ProfilePage.tsx` — replace the source state. Delete `const [computedChoice, …] =
  useState<"swng" | "whs">("swng")` and the `pendingSource` block (`:175-178`). Add:

```ts
  const [declaredDraft, setDeclaredDraft] = useState(""); // the override text buffer (not a staged source)
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | undefined>(undefined);

  // The active source is the COMMITTED one — auth.golfer.indexSource — resolved live. No pending
  // copy: tapping a source SAVES it (commit, below), so there is nothing to stage or revert.
  const activeSource = auth.golfer?.indexSource ?? { kind: "swng" as const };
  const resolved = resolveIndex(activeSource, record?.metrics ?? {});
```

- [ ] **Step 6:** In the hydrate effect (`:136-153`), replace the two source-setters with the draft
  seed only:

```ts
    const source = auth.golfer?.indexSource ?? { kind: "swng" as const };
    setDeclaredDraft(source.kind === "declared" ? String(source.value) : "");
```

- [ ] **Step 7:** Add `commit` near `submit` — one PUT, apply the response, no refetch:

```ts
  const commit = async (source: IndexSource) => {
    setCommitting(true);
    setCommitError(undefined);
    try {
      const response = await withAuth((token) => updateMe(token, { indexSource: source }));
      auth.applyGolfer(response.golfer); // one request: the PUT's own response updates the client
      setDeclaredDraft(source.kind === "declared" ? String(source.value) : "");
    } catch {
      setCommitError("Couldn't save your index — try again."); // active source unchanged (applied only on success)
    } finally {
      setCommitting(false);
    }
  };
```

- [ ] **Step 8:** Rewrite the name/home Save (`submit`, `:180-204`) to drop `indexSource` and use
  `applyGolfer`:

```ts
      const response = await auth.withAuth((token) =>
        updateMe(token, {
          name: name.trim(),
          ...(homeCourse ? { homeCourseId: homeCourse.id } : {}),
        }),
      );
      auth.applyGolfer(response.golfer);
      setSaved(true);
```

- [ ] **Step 9:** Rewrite the source rows + override JSX (index numbers stay `.toFixed(1)` here — Task 3
  swaps them to `formatHandicapIndex`):

```tsx
          <div className="flex flex-col gap-2" aria-label="Index sources">
            {INDEX_SOURCES.map((source) => {
              const value = source.valueOf(record);
              const active = activeSource.kind === source.kind;
              return (
                <div key={source.label} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-slate-300">
                    {source.label} · {value !== undefined ? value.toFixed(1) : "—"}
                    <span className="block text-xs text-slate-500">{source.description}</span>
                  </span>
                  {active ? (
                    <span className="shrink-0 text-xs text-emerald-400">in use</span>
                  ) : (
                    value !== undefined && (
                      <button type="button" aria-label={source.useLabel} disabled={committing}
                        onClick={() => void commit({ kind: source.kind })}
                        className="shrink-0 text-emerald-400 underline disabled:opacity-50">
                        Use this
                      </button>
                    )
                  )}
                </div>
              );
            })}
          </div>

          <label className="flex flex-col gap-1">
            Your own number
            <input value={declaredDraft} onChange={(event) => setDeclaredDraft(event.target.value)} inputMode="decimal" className="rounded-lg bg-slate-800 p-3 text-lg" />
          </label>
          {(() => {
            const parsed = declaredDraft.trim() === "" ? undefined : Number.parseFloat(declaredDraft.trim());
            const valid = parsed !== undefined && Number.isFinite(parsed);
            const declaredActive = activeSource.kind === "declared";
            return (
              <div className="flex items-center justify-between gap-2 text-sm">
                {declaredActive && <span className="text-xs text-emerald-400">your own number — in use</span>}
                {valid && (
                  <button type="button" disabled={committing}
                    onClick={() => void commit({ kind: "declared", value: parsed })}
                    className="ml-auto shrink-0 text-emerald-400 underline disabled:opacity-50">
                    Use this number
                  </button>
                )}
              </div>
            );
          })()}
          {commitError && <p role="alert" className="text-sm text-red-400">{commitError}</p>}
```
  Remove the old standalone override `<label>` at `:320-323` (it now lives in this block). Keep the
  `import type { IndexSource }` (used by `commit`). The active-value paragraph (`:262-279`) stays; its
  source is now `activeSource`.

- [ ] **Step 10:** Rewrite `ProfilePage.test.tsx` to the one-tap model:
  - golfer on `{kind:"swng"}`, `swngIndex.value=12.4`/`whsIndex.value=11.2`; `updateMe` mock returns
    `{ golfer: { ...golfer, indexSource:{kind:"whs"} } }`. Click "Use WHS index" → **exactly one**
    `updateMe({ indexSource:{kind:"whs"} })`, **no `getMe`**; active becomes `11.2` "your WHS index",
    WHS row "in use"; a re-render with the applied golfer still shows WHS (**no revert**).
  - Type `8` → "Use this number" appears → click → one `updateMe({ indexSource:{kind:"declared",
    value:8} })`; active `8.0` "your own".
  - `updateMe` rejects → "Couldn't save your index — try again."; active source unchanged.
  - name/home Save posts `{ name, homeCourseId }` with **no `indexSource`**.

- [ ] **Step 11:** `NODE_OPTIONS= pnpm -F @swng/web vitest run src/routes/ProfilePage.test.tsx` — PASS;
  then `NODE_OPTIONS= pnpm validate` — GREEN. Commit:
  `fix(web): picking an index source commits on tap — one request, no staged revert, no three-call save`.

---

### Task 2: Domain owns the plus-handicap convention

**Files:**
- Create: `packages/domain/src/handicap/present.ts` + `present.test.ts`
- Modify: `packages/domain/src/index.ts` (barrel export)

**Interfaces (Produces):** `formatHandicapIndex(value: number): string`;
`type StrokeGrant = { readonly kind: "receives" | "gives" | "none"; readonly count: number }`;
`strokeGrant(signed: number): StrokeGrant`.

- [ ] **Step 1:** Write the failing test `packages/domain/src/handicap/present.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatHandicapIndex, strokeGrant } from "./present.js";

describe("formatHandicapIndex", () => {
  it("renders a normal index plainly, scratch as 0.0", () => {
    expect(formatHandicapIndex(12.4)).toBe("12.4");
    expect(formatHandicapIndex(0)).toBe("0.0");
  });
  it("renders a plus handicap (below 0) with a + and no minus", () => {
    expect(formatHandicapIndex(-1.2)).toBe("+1.2");
    expect(formatHandicapIndex(-0.4)).toBe("+0.4");
  });
});

describe("strokeGrant", () => {
  it("positive receives, negative gives, zero none", () => {
    expect(strokeGrant(2)).toEqual({ kind: "receives", count: 2 });
    expect(strokeGrant(-2)).toEqual({ kind: "gives", count: 2 });
    expect(strokeGrant(0)).toEqual({ kind: "none", count: 0 });
  });
});
```

- [ ] **Step 2:** Run: `NODE_OPTIONS= pnpm -F @swng/domain vitest run src/handicap/present.test.ts` —
  FAIL (module missing).

- [ ] **Step 3:** Create `packages/domain/src/handicap/present.ts`:

```ts
// The golf presentation conventions for a handicap, in ONE place (index-source one-tap + plus-
// handicap spec §3). Views render THROUGH these — never a `value < 0` or a `+` literal in a
// component. The stored/wire numbers are unchanged; this is only how a sign is shown.

// A Handicap Index below 0 is a "plus" handicap (better than scratch): golf writes it "+2.4".
// 0.0 is scratch. Never a bare "-2.4".
export const formatHandicapIndex = (value: number): string =>
  value < 0 ? `+${(-value).toFixed(1)}` : value.toFixed(1);

// A signed stroke count (a course handicap, or a hole's dots) is strokes RECEIVED when positive,
// GIVEN when negative (a plus handicap gives strokes back), none at 0. The ONE place a sign becomes
// give/receive — the strokes note and the scorecard both read this, neither re-decides it.
export interface StrokeGrant {
  readonly kind: "receives" | "gives" | "none";
  readonly count: number;
}
export const strokeGrant = (signed: number): StrokeGrant =>
  signed > 0
    ? { kind: "receives", count: signed }
    : signed < 0
      ? { kind: "gives", count: -signed }
      : { kind: "none", count: 0 };
```

- [ ] **Step 4:** Add to `packages/domain/src/index.ts` (beside the other `handicap/*` export, line 24):
  `export * from "./handicap/present.js";`

- [ ] **Step 5:** Run the test — PASS. Then `NODE_OPTIONS= pnpm -F @swng/domain vitest run` — all
  green. Commit: `feat(domain): the plus-handicap convention lives here — formatHandicapIndex + strokeGrant`.

---

### Task 3: Every surface renders through the domain functions (no view decides a sign)

**Files:**
- Modify: `apps/web/src/routes/ProfilePage.tsx`, `CreateRoundPage.tsx`, `JoinRoundPage.tsx`,
  `round/ScorecardGrid.tsx`
- Test: the three route tests + `round/ScorecardGrid.test.tsx` (or `ResultsView.test.tsx` if that is
  where the Cell is exercised — the implementer confirms which file drives the Cell)

**Interfaces (Consumes):** `formatHandicapIndex`, `strokeGrant` from `@swng/domain` (Task 2).

- [ ] **Step 1:** `ProfilePage.tsx` — import `formatHandicapIndex`; the active number (`:264`, the
  `.toFixed(1)` from Task 1 Step 9) → `{formatHandicapIndex(resolved.value)}`; each source row value
  (`value.toFixed(1)` from Task 1 Step 9) → `{formatHandicapIndex(value)}`. The history-line
  **differential** (`:385`) stays `.toFixed(1)` (a differential is not a handicap).

- [ ] **Step 2:** `CreateRoundPage.tsx` — the derivation note (`:120-134`): `formatHandicapIndex` for
  the index, `strokeGrant` for the lead:

```ts
  const resolved = resolveIndex(golfer?.indexSource, record?.metrics ?? {});
  const selectedTeeSet = courseView?.card.teeSets.find((teeSet) => teeSet.name === tee);
  const suggestion = ((): { readonly value: number; readonly note: string } | undefined => {
    if (resolved.value === undefined || !selectedTeeSet) return undefined;
    const indexText = formatHandicapIndex(resolved.value);
    const sourceNoun = resolved.kind === "whs" ? "WHS index" : "index";
    const lead = (value: number): string => {
      const grant = strokeGrant(value);
      return grant.kind === "gives" ? `You give ${grant.count}` : `${value}`;
    };
    if (selectedTeeSet.rating !== undefined && selectedTeeSet.slope !== undefined) {
      const value = courseHandicapFor(resolved.value, selectedTeeSet);
      return { value, note: `${lead(value)} — from your ${sourceNoun} (${indexText}) on this course` };
    }
    const holeCount = selectedTeeSet.holes.length;
    const value = holeCount === 9 ? Math.round(resolved.value / 2) : Math.round(resolved.value);
    return { value, note: `${lead(value)} — from your ${sourceNoun} (${indexText}), adjusted for ${holeCount} holes; unrated course, adjust if it plays hard/easy` };
  })();
  const suggestedValue = suggestion?.value;
```

- [ ] **Step 3:** `JoinRoundPage.tsx` — same edit at its note (`:120-134`), keeping
  `courseHandicapFromRatingSlopePar` + `selectedTee.holes`/`.rating`/`.slope`/`.par`.

- [ ] **Step 4:** `ScorecardGrid.tsx` — the Cell (`:73-95`). Import `strokeGrant`. Replace the
  `dots > 0` net guard and the dot span:

```tsx
  const net = cell?.result.kind === "strokes" && dots !== 0 ? cell.result.strokes - dots : undefined;
```
  and the dot render (`{dots > 0 && (<span …>{"●".repeat(dots)}</span>)}`) with:

```tsx
      {(() => {
        const grant = strokeGrant(dots);
        if (grant.kind === "none") return null;
        // received strokes are filled ●; GIVEN strokes (a plus handicap) are hollow ○ — on the
        // screen now, not silently dropped. net = gross − dots already reads gross + 1 for a give.
        return (
          <span aria-hidden className="text-[10px] leading-none text-amber-400">
            {(grant.kind === "receives" ? "●" : "○").repeat(grant.count)}
          </span>
        );
      })()}
```

- [ ] **Step 5:** Tests:
  - Route tests: a golfer whose resolved value is `-1.2` shows `+1.2` on ProfilePage (active + any
    negative source row); Create/Join note for a plus golfer shows `(+1.2)` and, when the course
    handicap is negative, `You give N`; a normal `12.4` golfer's note is unchanged.
  - Scorecard test: a cell with `dots = -1` renders one hollow `○` and net = gross + 1; a `dots = 2`
    cell is unchanged (`●●`); `dots = 0` draws no glyph. (Mirror the existing positive-dots Cell test.)

- [ ] **Step 6:** `NODE_OPTIONS= pnpm validate` — GREEN. The no-improvisation grep gate — every index/
  course-handicap render in a view goes through the domain functions:
  `grep -rnE "toFixed\(1\)|\"\\+\"|< 0" apps/web/src/routes/ProfilePage.tsx apps/web/src/routes/CreateRoundPage.tsx apps/web/src/routes/JoinRoundPage.tsx apps/web/src/round/ScorecardGrid.tsx`
  must show ONLY the ProfilePage history-line differential `.toFixed(1)` (the carved-out signed
  number) — no other `.toFixed(1)` on an index/handicap, no `"+"` literal, no sign branch.
  Commit: `fix(web): render plus handicaps through the domain — +1.2, "you give N", and ○ give-back on the scorecard`.

---

### Task 4: E2E reconciliation + validate

**Files:** `apps/web/e2e/identityRecord.spec.ts` and any spec asserting the profile index surface or
the create/join note.

- [ ] **Step 1:** Grep the e2e dir:
  `grep -rn "Use this\|Use WHS\|Use swng\|in use\|Save\|WHS index\|Your own number\|Use this number\|from your index\|You give" apps/web/e2e e2e`.
  Reconcile each real DOM assertion to the one-tap model (adopt = click "Use this", no "Save"; set an
  override = type then "Use this number"). `identityRecord.spec.ts`'s `getByText(/WHS index/)` row
  assertion is unaffected. Leave prose comments alone. If no spec drives these interactions (as in the
  prior arc's reconciliation, likely a zero-diff), record that in the report — do NOT create an empty
  commit.

- [ ] **Step 2:** `NODE_OPTIONS= pnpm validate` (typechecks/lints the specs; live runs are the
  controller's gate). If any spec changed, commit: `test(e2e): profile index adopts on tap`. If
  zero-diff, note it and skip the commit.

## Self-Review (performed while writing)
- **Spec coverage:** §2 one-tap-commit → Task 1 (auth `applyGolfer`, `commit`, rows/override,
  name/home Save drops indexSource + uses applyGolfer); §2 single-request/no-revert → applyGolfer not
  refetch + active source is `auth.golfer.indexSource` + the anti-revert test; §3 domain owns the
  convention → Task 2 (`present.ts`); §3 every surface renders through it incl. scorecard → Task 3
  (profile + create/join + ScorecardGrid) + the no-improvisation grep; §3 differentials stay signed →
  the grep carve-out; §4 model/engine/wire untouched → no domain-model/contracts/application/adapters/
  round-state file touched (only `present.ts` added + web views).
- **No placeholders:** every step has concrete code or an exact command.
- **Type consistency:** `applyGolfer(view: GolferView)` identical across interface/impl/call;
  `formatHandicapIndex(value: number): string` and `strokeGrant(signed: number): StrokeGrant`
  identical across domain and all four web consumers; `commit(source: IndexSource)` matches
  `updateMe(token, { indexSource })` and `GolferResponse.golfer`.
- **Stays untouched:** `resolveIndex`, `IndexSource`, `golferMetrics`, the strokes conversion + `/2`
  halving, `allocateStrokes`/`courseHandicapFor`, the sealed round, the wire/schema.
