# Handicap index-source model — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Replace the golfer's `declared?: number` primitive with a first-class `IndexSource`
system (`swng | whs | declared(value)`) resolved live by `resolveIndex(source, metrics)`, so
adopting WHS puts a golfer *on* WHS (tracks, never a frozen copy) and every index is shown with
its source — no stored computed number, ever.

**Authority:** `docs/superpowers/specs/2026-07-16-handicap-index-source-model-design.md` is the
source of truth. Read it first. It supersedes §3/§8 of the handicap-index-strokes-model spec;
everything else there (the two computed numbers, strokes conversion, sealed round) is unchanged
and must not be touched.

**Architecture:** A vertical type change through domain → contracts → application → adapters →
web. Because removing `declared`/`effectiveIndex` breaks the web's compile, the change lands as
an **additive shim**: Task 1–4 add `indexSource` *alongside* the legacy `declared` (with
`indexSource` authoritative when present), migrating every reader; **Task 5 removes the shim
outright** (deletes `declared`, `effectiveIndex`, `official`-write). Every commit is
`pnpm validate`-green and internally coherent — `indexSource`-when-present always wins, so no
window mis-honors a WHS choice. Nothing ever ships carrying both.

**Tech Stack:** TypeScript ESM monorepo (pnpm), Zod wire schemas, React 19, Vitest, Playwright.

## Global Constraints

- **The invariant (spec §2):** never store a computed number. The profile stores a *choice of
  source* plus at most one *asserted* number (`declared`). swng and WHS are resolved live from
  `metrics` on every read; nothing caches them.
- **The type (spec §3):**
  ```ts
  export type IndexSource =
    | { readonly kind: "swng" }
    | { readonly kind: "whs" }
    | { readonly kind: "declared"; readonly value: number };
  ```
  Default for any golfer is `{ kind: "swng" }`. `declared` is a **permanent** peer (owner call).
- **The resolver (spec §4):** `resolveIndex(source, metrics)` is a pure domain function, `swng`/
  `whs` resolve to `metrics.swngIndex?.value`/`metrics.whsIndex?.value` (**`undefined` is a
  first-class outcome**, never `0`), `declared` to its value. It replaces `effectiveIndex` and
  its hidden `declared ?? computed` precedence.
- `pnpm validate` GREEN at every commit; `pnpm test:contract` green after the adapters task.
- Conditional-spread optional keys — never an explicit `undefined` on the wire or a stored item.
- Handicap math stays in `@swng/domain`; the web calls `resolveIndex`/`courseHandicapFor`/
  `courseHandicapFromRatingSlopePar`, never re-inlines a formula (the `/2` 9-hole halving is the
  only inline UI arithmetic, already commented as presentation).
- If a node/pnpm command dies with a `MODULE_NOT_FOUND` cmux/NODE_OPTIONS preload error, re-run
  prefixed with `NODE_OPTIONS=`.
- Commit per task; `feat`/`refactor(scope): …` + the Claude Code co-author trailer. Do NOT push.
- Controller-only (not a task): deploy, wipe/reseed beta, `publishWeb`, live gates, CLAUDE.md.

---

### Task 1: Domain — `IndexSource` + `resolveIndex` (additive)

**Files:** `packages/domain/src/golfer/golfer.ts` (+ `golfer.test.ts` if present, else new
`golfer.test.ts`), `packages/domain/src/golfer/metrics.ts` (+ `metrics.test.ts`),
`packages/domain/src/index.ts` (verify wildcard export).

**Interfaces (Produces):** `IndexSource` (union above); `HandicapProfile.indexSource?: IndexSource`
(optional this task); `ResolvedIndex = { value: number | undefined; kind: IndexSource["kind"] }`;
`resolveIndex(source: IndexSource | undefined, metrics: { whsIndex?: { value: number }; swngIndex?: { value: number } }): ResolvedIndex`.

This task is purely additive — `declared` and `effectiveIndex` stay. Nothing downstream changes.

- [ ] **Step 1:** In `golfer.ts`, add the `IndexSource` type above the `HandicapProfile`
  interface, and add `readonly indexSource?: IndexSource;` to `HandicapProfile` (leave
  `declared?: number` in place — the shim):

```ts
// The index a golfer is ON — a source they choose, resolved live (spec §3). swng/whs are
// computed views (resolveIndex, metrics.ts); declared is the one number a golfer asserts.
// Never a stored computed value — the invariant this whole type exists to enforce (spec §2).
export type IndexSource =
  | { readonly kind: "swng" }
  | { readonly kind: "whs" }
  | { readonly kind: "declared"; readonly value: number };

export interface HandicapProfile {
  // MIGRATION SHIM (this arc): indexSource is the real model; declared is the legacy primitive,
  // authoritative ONLY when indexSource is absent, removed whole in the final task.
  readonly indexSource?: IndexSource;
  readonly declared?: number;
}
```

- [ ] **Step 2:** In `metrics.ts`, add `ResolvedIndex` + `resolveIndex` after `golferMetrics`.
  The `metrics` param is structural (just needs `.value`), so both domain `GolferMetrics` and the
  wire `GetMyRecordResponse["metrics"]` satisfy it:

```ts
import type { IndexSource } from "./golfer.js";

// "Your index" is never stored — it is resolved on every read from the golfer's chosen source
// and the live metrics (spec §4). undefined is first-class: a computed source with no data yet
// (swng before enough rounds, whs before enough rated rounds) resolves to undefined, NOT 0.
// A missing source defaults to swng — the model's default (spec §3).
export interface ResolvedIndex {
  readonly value: number | undefined;
  readonly kind: IndexSource["kind"];
}

export const resolveIndex = (
  source: IndexSource | undefined,
  metrics: { readonly whsIndex?: { readonly value: number }; readonly swngIndex?: { readonly value: number } },
): ResolvedIndex => {
  const chosen = source ?? { kind: "swng" as const };
  switch (chosen.kind) {
    case "swng":
      return { value: metrics.swngIndex?.value, kind: "swng" };
    case "whs":
      return { value: metrics.whsIndex?.value, kind: "whs" };
    case "declared":
      return { value: chosen.value, kind: "declared" };
  }
};
```

- [ ] **Step 3:** Write failing tests in `metrics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveIndex } from "./metrics.js";

describe("resolveIndex", () => {
  const metrics = { whsIndex: { value: 11.2 }, swngIndex: { value: 12.4 } };

  it("resolves swng to the swng metric", () => {
    expect(resolveIndex({ kind: "swng" }, metrics)).toEqual({ value: 12.4, kind: "swng" });
  });
  it("resolves whs to the whs metric", () => {
    expect(resolveIndex({ kind: "whs" }, metrics)).toEqual({ value: 11.2, kind: "whs" });
  });
  it("resolves declared to its own asserted value", () => {
    expect(resolveIndex({ kind: "declared", value: 8 }, metrics)).toEqual({ value: 8, kind: "declared" });
  });
  it("resolves a computed source with no metric to undefined, not 0", () => {
    expect(resolveIndex({ kind: "whs" }, { swngIndex: { value: 12.4 } })).toEqual({ value: undefined, kind: "whs" });
  });
  it("defaults a missing source to swng", () => {
    expect(resolveIndex(undefined, metrics)).toEqual({ value: 12.4, kind: "swng" });
  });
  it("never stores a computed value — the same source follows changing metrics (no drift)", () => {
    const src = { kind: "whs" } as const;
    expect(resolveIndex(src, { whsIndex: { value: 11.2 } }).value).toBe(11.2);
    expect(resolveIndex(src, { whsIndex: { value: 10.6 } }).value).toBe(10.6); // tracks — a stored copy could not
  });
});
```

- [ ] **Step 4:** Run `pnpm -F @swng/domain vitest run src/golfer/metrics.test.ts` — expect the
  new cases PASS (they test the code just written). Then `pnpm validate` — GREEN (additive; no
  consumer changed).
- [ ] **Step 5:** Verify `resolveIndex`/`IndexSource`/`ResolvedIndex` are exported from
  `@swng/domain` (`node -e "import('@swng/domain').then(m => console.log(typeof m.resolveIndex))"`
  prints `function` after build, or confirm `packages/domain/src/index.ts` re-exports
  `golfer/golfer.js` + `golfer/metrics.js` via `export *`). If not exported, add the export.
- [ ] **Step 6:** Commit: `feat(domain): IndexSource + resolveIndex — the index resolved live from a chosen source, never stored`.

---

### Task 2: Backend wire + persistence — `indexSource` on the golfer (shim beside `declared`)

**Files:** `packages/contracts/src/golfers.ts` (+ `golfers.test.ts`),
`packages/application/src/golfers/golferView.ts`, `packages/application/src/golfers/updateMyGolfer.ts`
(+ their tests), `packages/adapters-dynamodb/src/createDynamoGolferStore.ts` (+ its contract test
under `packages/adapters-dynamodb/test/` or co-located).

**Interfaces (Consumes):** `IndexSource`, `HandicapProfile.indexSource?` (Task 1).
**Interfaces (Produces):** `GolferView.indexSource: IndexSource` (always present on the wire —
`toGolferView` derives it); `UpdateMeRequest.indexSource?: IndexSource`; the golfer store persists
`indexSource` as a nested map and tolerates legacy `declared`/`official` on read.

Shim rules for this task: keep `declared` on the wire, in the request, and in the store — but
`indexSource` is authoritative when present. `toGolferView` ALWAYS emits `indexSource` (derived
from the source of truth). `updateMyGolfer` accepts `indexSource` and, when present, makes it the
stored source of truth (and stops persisting `declared`).

- [ ] **Step 1:** `contracts/golfers.ts` — add the wire schema for `IndexSource` and put it on
  `GolferView` (required) and `updateMeRequest` (optional). Import the domain type:

```ts
import type { IndexSource } from "@swng/domain";

// The wire mirror of domain's IndexSource (spec §3/§8): a discriminated union, so a client can
// only ever propose a well-formed source (kind + value-iff-declared), never a bare number the
// server has to interpret. GolferView carries it ALWAYS (toGolferView derives it); the update
// request takes it optionally (a patch — absent leaves the stored source untouched).
const indexSourceSchema: z.ZodType<IndexSource> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("swng") }),
  z.object({ kind: z.literal("whs") }),
  z.object({ kind: z.literal("declared"), value: z.number() }),
]);
```

  Add `readonly indexSource: IndexSource;` to `GolferView` (keep `declared?` for now); add
  `indexSource: indexSourceSchema,` to `golferViewSchema`; add `indexSource: indexSourceSchema.optional(),`
  to `updateMeRequestSchema` (keep `declared` there too).

- [ ] **Step 2:** `application/golferView.ts` — `toGolferView` derives `indexSource` from the
  source of truth (the domain `indexSource` when set, else the legacy `declared`, else swng), and
  still emits `declared` (shim):

```ts
export const toGolferView = (golfer: Golfer): GolferView => ({
  golferId: golfer.id,
  name: golfer.name,
  ...(golfer.homeCourseId !== undefined ? { homeCourseId: golfer.homeCourseId } : {}),
  // indexSource is ALWAYS on the wire (spec §3 — the golfer is always on some source): the stored
  // source when set, else the legacy declared number as a declared source, else the swng default.
  indexSource:
    golfer.handicap.indexSource ??
    (golfer.handicap.declared !== undefined ? { kind: "declared", value: golfer.handicap.declared } : { kind: "swng" }),
  ...(golfer.handicap.declared !== undefined ? { declared: golfer.handicap.declared } : {}), // SHIM — removed in Task 5
  ...(golfer.namePlaceholder === true ? { namePlaceholder: true } : {}),
});
```

- [ ] **Step 3:** `application/updateMyGolfer.ts` — when `command.indexSource` is present, store it
  as the source of truth and drop the legacy `declared` from the stored handicap (the source now
  carries any asserted value). Keep accepting `command.declared` for back-compat:

```ts
    const { namePlaceholder: wasPlaceholder, ...golferBase } = found.golfer;
    // indexSource is the model; when the client sends one it REPLACES the stored source wholesale
    // (not a nullable patch) and retires the legacy declared. A client still on the old declared
    // path (no indexSource) patches declared as before — the shim, gone in Task 5.
    const handicap: HandicapProfile =
      command.indexSource !== undefined
        ? { indexSource: command.indexSource }
        : { ...found.golfer.handicap, ...(command.declared !== undefined ? { declared: command.declared } : {}) };
    const patched: Golfer = {
      ...golferBase,
      ...(command.name !== undefined ? { name: command.name } : {}),
      ...(command.homeCourseId !== undefined ? { homeCourseId: command.homeCourseId } : {}),
      ...(command.name === undefined && wasPlaceholder ? { namePlaceholder: true } : {}),
      handicap,
    };
```

  (Add `import type { HandicapProfile } from "@swng/domain";` — or inline the type. `Golfer` is
  already imported.)

- [ ] **Step 4:** `adapters-dynamodb/createDynamoGolferStore.ts` — persist `indexSource` as a
  nested map attr and tolerate legacy `declared`/`official` on read. In `GolferItem` add
  `readonly indexSource?: { readonly kind: string; readonly value?: number };`. In `golferOf`,
  replace the `handicap: { ...declared/official fold }` block:

```ts
  // spec §3/§8: the persisted source of truth is `indexSource`. Legacy rows carry only a top-level
  // `declared` number (or the older `official`) and no indexSource — folded up to a declared source
  // on read. Old data tolerates forever, migrates never: the next whole-golfer put writes
  // indexSource and drops the legacy attrs (Task 5's write path no longer emits them).
  handicap: {
    indexSource: (item.indexSource?.kind === "swng"
      ? { kind: "swng" }
      : item.indexSource?.kind === "whs"
        ? { kind: "whs" }
        : item.indexSource?.kind === "declared" && item.indexSource.value !== undefined
          ? { kind: "declared", value: item.indexSource.value }
          : item.declared !== undefined
            ? { kind: "declared", value: item.declared }
            : item.official !== undefined
              ? { kind: "declared", value: item.official }
              : { kind: "swng" }) as IndexSource,
  },
```

  In `put`, replace the `...(golfer.handicap.declared … declared)` spread with the source
  serialization (keep writing `declared` too as the shim, removed in Task 5):

```ts
        ...(golfer.handicap.indexSource !== undefined ? { indexSource: golfer.handicap.indexSource } : {}),
        ...(golfer.handicap.declared !== undefined ? { declared: golfer.handicap.declared } : {}), // SHIM — removed in Task 5
```

  (Add `import type { IndexSource } from "@swng/domain";`.)

- [ ] **Step 5:** Tests. `golfers.test.ts`: `golferViewSchema` accepts each `indexSource` kind and
  rejects a bad kind / a `declared` source missing `value`; `updateMeRequestSchema` accepts an
  optional `indexSource`. Golfer-store contract test: a golfer put with `handicap.indexSource =
  { kind: "whs" }` round-trips to `{ kind: "whs" }`; a **legacy** stored item `{ declared: 8 }`
  with no `indexSource` reads back as `handicap.indexSource = { kind: "declared", value: 8 }`; the
  `getBySub` read path is pinned to the same fold as `get`/`getMany` (write via `put`+`bindSub`,
  read via `getBySub`, assert the folded `indexSource`) — closing the review's open `getBySub` gap.

```ts
// golfers.test.ts additions
it("golferViewSchema accepts each index source and rejects a malformed one", () => {
  for (const indexSource of [{ kind: "swng" }, { kind: "whs" }, { kind: "declared", value: 8 }]) {
    expect(golferViewSchema.parse({ golferId: "g1", name: "A", indexSource })).toMatchObject({ indexSource });
  }
  expect(() => golferViewSchema.parse({ golferId: "g1", name: "A", indexSource: { kind: "nope" } })).toThrow();
  expect(() => golferViewSchema.parse({ golferId: "g1", name: "A", indexSource: { kind: "declared" } })).toThrow();
});
```

- [ ] **Step 6:** Run `pnpm validate` + `pnpm test:contract` — GREEN. Commit:
  `feat(contracts,application,adapters): golfer carries an IndexSource (shim beside declared) — legacy declared/official fold to a declared source, getBySub pinned`.

---

### Task 3: Web create/join — strokes derive from the resolved source

**Files:** `apps/web/src/routes/CreateRoundPage.tsx` (+ test),
`apps/web/src/routes/JoinRoundPage.tsx` (+ test).

**Interfaces (Consumes):** `GolferView.indexSource` (Task 2, always present); `resolveIndex`
(Task 1).

Mechanical swap: `effectiveIndex({ declared, computed })` → `resolveIndex(indexSource, metrics)`.
No UI redesign here. The derivation note names a WHS source.

- [ ] **Step 1:** `CreateRoundPage.tsx` — swap the import (`effectiveIndex` → `resolveIndex`) and
  line 120, and name the source in the note. Replace the `effective`/`suggestion` block:

```ts
  const resolved = resolveIndex(golfer?.indexSource, record?.metrics ?? {});
  const selectedTeeSet = courseView?.card.teeSets.find((teeSet) => teeSet.name === tee);
  const suggestion = ((): { readonly value: number; readonly note: string } | undefined => {
    if (resolved.value === undefined || !selectedTeeSet) return undefined;
    const indexText = resolved.value.toFixed(1);
    const sourceNoun = resolved.kind === "whs" ? "WHS index" : "index"; // spec §6: name a WHS source
    if (selectedTeeSet.rating !== undefined && selectedTeeSet.slope !== undefined) {
      const value = courseHandicapFor(resolved.value, selectedTeeSet);
      return { value, note: `${value} — from your ${sourceNoun} (${indexText}) on this course` };
    }
    const holeCount = selectedTeeSet.holes.length;
    const value = holeCount === 9 ? Math.round(resolved.value / 2) : Math.round(resolved.value);
    return { value, note: `${value} — from your ${sourceNoun} (${indexText}), adjusted for ${holeCount} holes; unrated course, adjust if it plays hard/easy` };
  })();
  const suggestedValue = suggestion?.value;
```

  (`golfer` is the existing `auth.golfer` binding on this page — confirm the local name; if the
  page reads `auth.golfer` directly, use `auth.golfer?.indexSource`.)

- [ ] **Step 2:** `JoinRoundPage.tsx` — same swap at line 119 (uses
  `courseHandicapFromRatingSlopePar` and `selectedTee.holes`; keep those), naming the source:

```ts
  const resolved = resolveIndex(auth.golfer?.indexSource, record?.metrics ?? {});
  const selectedTee = peekTees?.find((peekTee) => peekTee.name === tee);
  const suggestion = ((): { readonly value: number; readonly note: string } | undefined => {
    if (resolved.value === undefined || !selectedTee) return undefined;
    const indexText = resolved.value.toFixed(1);
    const sourceNoun = resolved.kind === "whs" ? "WHS index" : "index";
    if (selectedTee.rating !== undefined && selectedTee.slope !== undefined) {
      const value = courseHandicapFromRatingSlopePar(resolved.value, selectedTee.rating, selectedTee.slope, selectedTee.par);
      return { value, note: `${value} — from your ${sourceNoun} (${indexText}) on this course` };
    }
    const value = selectedTee.holes === 9 ? Math.round(resolved.value / 2) : Math.round(resolved.value);
    return { value, note: `${value} — from your ${sourceNoun} (${indexText}), adjusted for ${selectedTee.holes} holes; unrated course, adjust if it plays hard/easy` };
  })();
  const suggestedValue = suggestion?.value;
```

- [ ] **Step 3:** Tests. In each page's test, set the golfer's `indexSource` and assert the strokes
  seed + note:
  - `indexSource: { kind: "declared", value: 12.4 }`, rated tee (slope 130, rating 71, par 72) →
    field seeds `13`, note contains `from your index (12.4) on this course` (declared → "index").
  - `indexSource: { kind: "whs" }` with `metrics.whsIndex.value = 10` on an unrated 9-hole tee →
    field seeds `5` (`round(10/2)`), note contains `from your WHS index (10.0), adjusted for 9 holes`.
  - a typed value still survives a re-seed (existing `touched` assertion — keep it).

- [ ] **Step 4:** `pnpm validate` — GREEN. Commit:
  `feat(web): create/join strokes derive from the resolved index source (WHS named in the note)`.

---

### Task 4: Web profile — "Use this" sets the SOURCE, not a copied number

**Files:** `apps/web/src/routes/ProfilePage.tsx` (+ test).

**Interfaces (Consumes):** `GolferView.indexSource`, `UpdateMeRequest.indexSource`, `resolveIndex`.

This is the user-visible fix. The page tracks the chosen source in form state; "Use this" sets the
source (no `setDeclared(String(value))` copy); the active value resolves live; Save sends
`indexSource`.

- [ ] **Step 1:** Replace the form state. Remove the lone `const [declared, setDeclared] = useState("")`
  and add a computed-choice + override-text pair (the override non-empty ⟺ the declared source is
  active; `computedChoice` remembers swng-vs-whs while the override is empty):

```ts
  const [computedChoice, setComputedChoice] = useState<"swng" | "whs">("swng");
  const [declared, setDeclared] = useState(""); // override text; non-empty ⟺ a declared source
```

- [ ] **Step 2:** Hydrate from `auth.golfer.indexSource` (replace the `setDeclared(...)` line in the
  hydrate effect):

```ts
    const source = auth.golfer?.indexSource ?? { kind: "swng" as const };
    setComputedChoice(source.kind === "whs" ? "whs" : "swng");
    setDeclared(source.kind === "declared" ? String(source.value) : "");
```

- [ ] **Step 3:** Compute the pending source + active resolved value from form state (replace the
  `effectiveIndex(...)` line ~204):

```ts
  const parsedOverride = declared.trim() === "" ? undefined : Number.parseFloat(declared.trim());
  const pendingSource: IndexSource =
    parsedOverride !== undefined && Number.isFinite(parsedOverride)
      ? { kind: "declared", value: parsedOverride }
      : { kind: computedChoice };
  const resolved = resolveIndex(pendingSource, record?.metrics ?? {});
```

  Import `resolveIndex` and the `IndexSource` type from `@swng/domain` (drop the `effectiveIndex`
  import).

- [ ] **Step 4:** Rework the active-value display (source label three-way) and the sources block so
  "Use this" sets the source and the active one is marked "in use". Replace the `{effective ? …}`
  paragraph and the `INDEX_SOURCES.map(...)` block:

```tsx
          {resolved.value !== undefined ? (
            <p className="flex items-baseline gap-2">
              <span className="text-3xl font-bold">{resolved.value.toFixed(1)}</span>
              <span className="text-sm text-slate-400">
                {resolved.kind === "declared" ? "your own" : resolved.kind === "whs" ? "your WHS index" : "from all your rounds"}
              </span>
            </p>
          ) : (
            <p className="text-sm text-slate-400">
              {resolved.kind === "whs"
                ? "No WHS index yet — play a few rated rounds, or pick another source below."
                : "No index yet — play a few rounds and swng will compute one, or set your own below."}
            </p>
          )}

          <div className="flex flex-col gap-2" aria-label="Index sources">
            {INDEX_SOURCES.map((source) => {
              const value = source.valueOf(record);
              const active = declared.trim() === "" && computedChoice === source.kind;
              return (
                <div key={source.label} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-slate-300">
                    {source.label} · {value !== undefined ? value : "—"}
                    <span className="block text-xs text-slate-500">{source.description}</span>
                  </span>
                  {active ? (
                    <span className="shrink-0 text-xs text-emerald-400">in use</span>
                  ) : (
                    value !== undefined && (
                      <button
                        type="button"
                        aria-label={source.useLabel}
                        onClick={() => {
                          setComputedChoice(source.kind);
                          setDeclared(""); // choosing a computed source leaves the override empty (spec §6)
                        }}
                        className="shrink-0 text-emerald-400 underline"
                      >
                        Use this
                      </button>
                    )
                  )}
                </div>
              );
            })}
          </div>
```

  Update `INDEX_SOURCES` to carry the `kind` so a row knows its source (and its `valueOf` reads
  the right metric):

```ts
const INDEX_SOURCES: readonly { readonly kind: "swng" | "whs"; readonly label: string; readonly description: string; readonly useLabel: string; readonly valueOf: (record: GetMyRecordResponse | undefined) => number | undefined }[] = [
  { kind: "swng", label: "swng index", description: "from all your rounds", useLabel: "Use swng index", valueOf: (record) => record?.metrics?.swngIndex?.value },
  { kind: "whs", label: "WHS index", description: "rated rounds, official rules", useLabel: "Use WHS index", valueOf: (record) => record?.metrics?.whsIndex?.value },
];
```

  The override input keeps `value={declared} onChange={(e) => setDeclared(e.target.value)}` — typing
  a value makes `pendingSource` a declared source automatically (Step 3), and the active mark flips
  to the override.

- [ ] **Step 5:** Save sends `indexSource` (replace the `...(parsedDeclared … declared)` spread in
  `submit`). Reuse `pendingSource`:

```ts
      await auth.withAuth((token) =>
        updateMe(token, {
          name: name.trim(),
          ...(homeCourse ? { homeCourseId: homeCourse.id } : {}),
          indexSource: pendingSource,
        }),
      );
```

  (Delete the now-dead `trimmedDeclared`/`parsedDeclared` guard at the top of `submit` — the parse
  moved to `parsedOverride` in Step 3; an invalid override simply resolves to the computed source.)

- [ ] **Step 6:** Tests. `ProfilePage.test.tsx`:
  - golfer `indexSource: { kind: "swng" }`, `metrics.swngIndex.value = 12.4`, `whsIndex.value = 11.2`
    → active shows `12.4` + "from all your rounds"; the swng row shows "in use", the WHS row shows a
    "Use WHS index" button.
  - clicking "Use WHS index" → active shows `11.2` + "your WHS index" (NOT copied into the override
    box — the override input is still empty), and Save posts `updateMe` with
    `indexSource: { kind: "whs" }` (assert the mock call arg). **This is the anti-drift test: adopting
    WHS puts the golfer ON whs, it is not a frozen copy labeled "your own".**
  - typing `8` in the override → active shows `8.0` + "your own"; Save posts `indexSource: { kind:
    "declared", value: 8 }`.
  - golfer on `{ kind: "whs" }` with no `whsIndex` metric → active shows the "No WHS index yet" copy.

- [ ] **Step 7:** `pnpm validate` — GREEN. Commit:
  `feat(web): profile "Use this" sets the index SOURCE (live), not a copied number — adopting WHS tracks WHS`.

---

### Task 5: Remove the shim — delete `declared`, `effectiveIndex`, `official`-write

**Files:** `packages/domain/src/golfer/golfer.ts`, `packages/contracts/src/golfers.ts`,
`packages/application/src/golfers/golferView.ts` + `updateMyGolfer.ts`,
`packages/adapters-dynamodb/src/createDynamoGolferStore.ts` (+ touched tests). Grep-driven.

The primitive is gone from every reader (Tasks 2–4). This task deletes it and makes `indexSource`
required. Beta is wiped and no prod pool exists, so the store's read-tolerate (legacy
`declared`/`official` → declared source) STAYS as pure defense; only the WRITE of `declared`/
`official` and the domain/wire `declared` field are removed.

- [ ] **Step 1:** `domain/golfer.ts` — make `indexSource` required and delete `declared` +
  `effectiveIndex`:

```ts
export interface HandicapProfile {
  readonly indexSource: IndexSource;
}
```
  Delete the entire `effectiveIndex` export and its doc comment.

- [ ] **Step 2:** Grep for `effectiveIndex` and `\.declared` across `packages` + `apps` (non-test,
  non-`dist`):
  `grep -rn "effectiveIndex\|\.declared\|declared:" packages apps | grep -viE "dist|\.test\."`.
  Expect ZERO domain/contracts/app/web source hits except the store's read-tolerate mapping and
  legacy-item comments. If any real reader remains, it was missed in Tasks 2–4 — fix it here.

- [ ] **Step 3:** `contracts/golfers.ts` — remove `declared?` from `GolferView` + `golferViewSchema`,
  and `declared` from `updateMeRequestSchema`. Rewrite the stale header comment (it describes the
  old `declared`/`effectiveIndex` precedence) to the source model.

- [ ] **Step 4:** `application/golferView.ts` — drop the `declared` shim spread (keep the derived
  `indexSource`, which is now `golfer.handicap.indexSource` directly since the field is required):

```ts
  indexSource: golfer.handicap.indexSource,
```
  `updateMyGolfer.ts` — drop the `command.declared` branch; the handicap is just
  `command.indexSource !== undefined ? { indexSource: command.indexSource } : found.golfer.handicap`.

- [ ] **Step 5:** `adapters-dynamodb/createDynamoGolferStore.ts` — drop the `declared` write spread
  in `put` (Task 2's SHIM line) and remove `declared`/`official` from the write path. KEEP `declared`
  + `official` in `GolferItem` and the `golferOf` read-tolerate (defensive; comment says why). The
  put now writes only `indexSource`.

- [ ] **Step 6:** Fix any test still asserting `declared` on the wire/store (they should assert
  `indexSource`). Run `pnpm validate` + `pnpm test:contract` — GREEN, and the Step-2 grep clean.
- [ ] **Step 7:** Commit: `refactor(domain,contracts,application,adapters): remove the declared primitive — IndexSource is the model; legacy read-tolerate stays`.

---

### Task 6: E2E — the new source UI + copy

**Files:** `apps/web/e2e/unratedCourse.spec.ts`, `apps/web/e2e/identityRecord.spec.ts`, and any
spec touching the profile index surface / the create-join derivation note (grep the e2e dir for
`declared`, `Use this`, `Your index`, `from your index`, `Use WHS`).

- [ ] **Step 1:** Update any profile-index interaction: a spec that set a declared index by typing
  the override still works (typing → declared source). A spec asserting the WHS row now asserts the
  three-way active label / the "in use" mark / "Use WHS index" button per Task 4's DOM. Any create/
  join derivation-note assertion that pinned `from your index (X)` stays for a swng/declared golfer;
  add coverage or adjust for the WHS-named note only where a spec drives a WHS-source golfer.
- [ ] **Step 2:** Grep the e2e dir for `effectiveIndex`/`declared` string references and reconcile
  each to the source model. `pnpm validate` (typecheck/lint the specs — live runs are the
  controller's gate). Commit: `test(e2e): index-source UI + WHS-named strokes derivation`.

## Self-Review (performed while writing)
- **Spec coverage:** §2 invariant (never store computed) → resolveIndex reads metrics live (T1) +
  the store never persists a computed number, only `indexSource`/`declared`-value (T2/T5); §3 the
  `IndexSource` type + permanent declared → T1/T2; §4 resolveIndex + undefined-first-class → T1;
  §5 provenance on screen → T4 (active label) + T3 (note names source); §6 UX (Use this sets
  source) → T4, strokes → T3; §7 sealed round untouched → no round/snapshot file in any task; §8
  blast radius → T1–T5; §9 tests incl. no-drift + getBySub → T1/T2/T4.
- **Green-per-commit:** additive shim (T1 optional field, T2 wire+store beside declared, T3/T4
  readers migrate) → T5 removes the shim once nothing reads it; every task ends `pnpm validate`
  green. The transient dual-carry never mis-honors a source (indexSource-when-present wins from T2
  on) and is deleted in T5.
- **Type consistency:** `IndexSource` (T1) is the SAME union in contracts' `indexSourceSchema`
  (T2), the store map (T2), and the web `pendingSource` (T3/T4); `resolveIndex(source, metrics)`
  signature identical at all three web call sites; `ResolvedIndex.kind` drives the note noun (T3)
  and the profile label (T4).
- **Stays untouched:** the two computed metrics (`golferMetrics`, `swngIndex`, `whsIndex`), the
  strokes conversion (`courseHandicapFor`/`courseHandicapFromRatingSlopePar`, the `/2` halving),
  `par`/`courseHandicap` on the line, the sealed round/snapshot.
