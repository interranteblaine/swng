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

**Architecture:** A **direct** type change through domain → contracts → application → adapters →
web. **There are no users and no data to protect** (beta is disposable, no prod pool exists), so
there is **NO migration shim, NO dual-carry, NO tolerate-legacy fold.** `declared` becomes
`indexSource` in one coherent change; the golfer store simply defaults a missing/old stored
source to `{ kind: "swng" }` (a one-line sane default, not a value-preserving migration — old
beta rows lose a declared value nobody will miss). Because the domain type is imported everywhere,
the change lands as ONE atomic task (Task 1) to stay `pnpm validate`-green; e2e is Task 2.

**Tech Stack:** TypeScript ESM monorepo (pnpm), Zod wire schemas, React 19, Vitest, Playwright.

## Global Constraints

- **The invariant (spec §2):** never store a computed number. The profile stores a *choice of
  source* plus at most one *asserted* number. swng and WHS resolve live from `metrics` on every
  read; nothing caches them.
- **The type (spec §3):**
  ```ts
  export type IndexSource =
    | { readonly kind: "swng" }
    | { readonly kind: "whs" }
    | { readonly kind: "declared"; readonly value: number };
  ```
  Default for any golfer is `{ kind: "swng" }`. `declared` is a **permanent** peer (owner call).
- **The resolver (spec §4):** `resolveIndex(source, metrics)` is a pure domain function; `swng`/
  `whs` → `metrics.swngIndex?.value`/`metrics.whsIndex?.value` (**`undefined` is first-class,
  never `0`**), `declared` → its value; a missing source defaults to swng. It REPLACES
  `effectiveIndex` — which is deleted, not kept.
- **No shim, no legacy machinery:** `declared`, `effectiveIndex`, and the store's `official`
  fold are DELETED, not phased out. The store reads `indexSource` with a `{kind:"swng"}` default
  for absent/malformed; it does not read old `declared`/`official` attrs.
- `pnpm validate` GREEN at the end of each task; `pnpm test:contract` green after Task 1.
- Conditional-spread optional keys — never an explicit `undefined`. Handicap math stays in
  `@swng/domain` (the `/2` 9-hole halving is the only inline UI arithmetic, already commented).
- If a node/pnpm command dies with a `MODULE_NOT_FOUND` cmux/NODE_OPTIONS preload error, re-run
  prefixed with `NODE_OPTIONS=`.
- Commit per task; `feat`/`refactor(scope): …` + the Claude Code co-author trailer. Do NOT push.
- Controller-only (not a task): deploy, reseed beta, `publishWeb`, live gates, CLAUDE.md.

---

### Task 1: The index becomes a source (atomic — domain → contracts → application → adapters → web)

One coherent commit: the domain type change and its whole blast radius, so every layer is
consistent and `pnpm validate` is green. Work the layers in order; run `pnpm validate` once at the
end.

**Files:**
- `packages/domain/src/golfer/golfer.ts` (+ `metrics.ts`, + tests)
- `packages/contracts/src/golfers.ts` (+ test)
- `packages/application/src/golfers/golferView.ts`, `updateMyGolfer.ts`, `ensureGolfer.ts` (+ tests)
- `packages/adapters-dynamodb/src/createDynamoGolferStore.ts` (+ contract test)
- `apps/web/src/routes/ProfilePage.tsx`, `CreateRoundPage.tsx`, `JoinRoundPage.tsx` (+ tests)

**Interfaces (Produces):** `IndexSource` (union above); `HandicapProfile.indexSource: IndexSource`
(required; `declared` deleted); `ResolvedIndex = { value: number | undefined; kind: IndexSource["kind"] }`;
`resolveIndex(source: IndexSource | undefined, metrics: { whsIndex?: { value: number }; swngIndex?: { value: number } }): ResolvedIndex`;
`GolferView.indexSource: IndexSource`; `UpdateMeRequest.indexSource?: IndexSource`.

**Domain**

- [ ] **Step 1:** `golfer.ts` — add `IndexSource`, replace `HandicapProfile.declared?` with
  `indexSource`, DELETE `effectiveIndex` (whole export + its doc comment):

```ts
// The index a golfer is ON — a source they choose, resolved live (spec §3). swng/whs are computed
// views (resolveIndex, metrics.ts); declared is the one number a golfer asserts. Never a stored
// computed value — the invariant this type exists to enforce (spec §2).
export type IndexSource =
  | { readonly kind: "swng" }
  | { readonly kind: "whs" }
  | { readonly kind: "declared"; readonly value: number };

export interface HandicapProfile {
  readonly indexSource: IndexSource;
}
```

- [ ] **Step 2:** `metrics.ts` — add `ResolvedIndex` + `resolveIndex` (structural `metrics` param
  so both domain `GolferMetrics` and the wire metrics satisfy it):

```ts
import type { IndexSource } from "./golfer.js";

// "Your index" is never stored — it is resolved every read from the chosen source and the live
// metrics (spec §4). undefined is first-class: a computed source with no data yet resolves to
// undefined, NOT 0. A missing source defaults to swng — the model's default (spec §3).
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

- [ ] **Step 3:** Domain tests in `metrics.test.ts`: each kind resolves to the right member;
  a computed source with no metric → `{ value: undefined, kind }` (not 0); a missing source →
  swng; **no-drift:** the same `{kind:"whs"}` source follows two different metrics snapshots
  (11.2 then 10.6) — a stored copy could not. Verify `resolveIndex`/`IndexSource`/`ResolvedIndex`
  export from `@swng/domain` (add to `src/index.ts` if the wildcard doesn't already surface them).

**Contracts**

- [ ] **Step 4:** `contracts/golfers.ts` — replace `declared` with an `indexSource` discriminated
  union on `GolferView` (required) and `updateMeRequest` (optional). Rewrite the stale header
  comment (it describes the old `declared`/`effectiveIndex` precedence) to the source model:

```ts
import type { IndexSource } from "@swng/domain";

const indexSourceSchema: z.ZodType<IndexSource> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("swng") }),
  z.object({ kind: z.literal("whs") }),
  z.object({ kind: z.literal("declared"), value: z.number() }),
]);
```
  `GolferView`: `readonly indexSource: IndexSource;` (drop `declared`). `golferViewSchema`:
  `indexSource: indexSourceSchema,` (drop `declared`). `updateMeRequestSchema`:
  `indexSource: indexSourceSchema.optional(),` (drop `declared`).
- [ ] **Step 5:** Contract tests: `golferViewSchema` accepts each kind, rejects `{kind:"nope"}`
  and a `declared` source missing `value`; `updateMeRequestSchema` accepts an optional `indexSource`.

**Application**

- [ ] **Step 6:** `golferView.ts` — emit `indexSource` (drop the `declared` spread + its stale
  comment):

```ts
export const toGolferView = (golfer: Golfer): GolferView => ({
  golferId: golfer.id,
  name: golfer.name,
  ...(golfer.homeCourseId !== undefined ? { homeCourseId: golfer.homeCourseId } : {}),
  indexSource: golfer.handicap.indexSource,
  ...(golfer.namePlaceholder === true ? { namePlaceholder: true } : {}),
});
```

- [ ] **Step 7:** `updateMyGolfer.ts` — the handicap is the sent source when present, else the
  stored one (no `declared` branch):

```ts
    const patched: Golfer = {
      ...golferBase,
      ...(command.name !== undefined ? { name: command.name } : {}),
      ...(command.homeCourseId !== undefined ? { homeCourseId: command.homeCourseId } : {}),
      ...(command.name === undefined && wasPlaceholder ? { namePlaceholder: true } : {}),
      handicap: command.indexSource !== undefined ? { indexSource: command.indexSource } : found.golfer.handicap,
    };
```

- [ ] **Step 8:** `ensureGolfer.ts` — the get-or-create mint now sets a source (read the file; the
  minted golfer's `handicap` becomes `{ indexSource: { kind: "swng" } }`). Update any other mint
  site that constructs a `Golfer` with an empty `handicap: {}`.
- [ ] **Step 9:** Application tests: `toGolferView` emits `indexSource`; `updateMyGolfer` with
  `indexSource: {kind:"whs"}` stores that source; a fresh `ensureGolfer` mint has
  `{ indexSource: { kind: "swng" } }`.

**Adapters**

- [ ] **Step 10:** `createDynamoGolferStore.ts` — store `indexSource` as a nested map; read it with
  a `{kind:"swng"}` default; DELETE the `official`/`declared` fold. In `GolferItem`, replace
  `declared?`/`official?` with `readonly indexSource?: { readonly kind: string; readonly value?: number };`.
  `golferOf`:

```ts
  // spec §3/§8: the persisted source of truth is `indexSource` (a small map). No users / no prod,
  // so no legacy migration — an absent or malformed stored source simply defaults to swng (old
  // beta rows lose a declared value nobody will miss); the next put writes a well-formed source.
  handicap: {
    indexSource:
      item.indexSource?.kind === "whs"
        ? { kind: "whs" }
        : item.indexSource?.kind === "declared" && item.indexSource.value !== undefined
          ? { kind: "declared", value: item.indexSource.value }
          : { kind: "swng" },
  },
```
  In `put`, replace the `declared` spread with:
  `...(golfer.handicap.indexSource !== undefined ? { indexSource: golfer.handicap.indexSource } : {}),`
  (it is always defined — the spread is belt-and-suspenders; a plain assignment is fine too).
- [ ] **Step 11:** Golfer-store contract test: a put with `handicap.indexSource = {kind:"whs"}`
  round-trips; a put with `{kind:"declared", value:8}` round-trips its value; the **`getBySub`**
  read path returns the same folded source as `get`/`getMany` (write via `put`+`bindSub`, read via
  `getBySub`) — closing the review's open `getBySub` gap. A stored item with NO `indexSource`
  reads back as `{kind:"swng"}`.

**Web**

- [ ] **Step 12:** `CreateRoundPage.tsx` — swap `effectiveIndex` import → `resolveIndex`; replace
  the `effective`/`suggestion` block (names a WHS source in the note):

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
  (`golfer` is this page's existing `auth.golfer` binding — confirm the local name.)

- [ ] **Step 13:** `JoinRoundPage.tsx` — same swap at the `effective` line (keeps
  `courseHandicapFromRatingSlopePar` + `selectedTee.holes`):

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

- [ ] **Step 14:** `ProfilePage.tsx` — the source-selection UI. Replace the lone `declared` state
  with a computed-choice + override-text pair; hydrate from `indexSource`; compute a `pendingSource`
  + live `resolved`; "Use this" sets the source; Save posts `indexSource`.

  State + hydrate (replace `const [declared, setDeclared] = useState("")` and the
  `setDeclared(...)` hydrate line):
```ts
  const [computedChoice, setComputedChoice] = useState<"swng" | "whs">("swng");
  const [declared, setDeclared] = useState(""); // override text; non-empty ⟺ a declared source
  // ...in the hydrate effect:
    const source = auth.golfer?.indexSource ?? { kind: "swng" as const };
    setComputedChoice(source.kind === "whs" ? "whs" : "swng");
    setDeclared(source.kind === "declared" ? String(source.value) : "");
```
  Pending source + active value (replace the `effectiveIndex(...)` line; import `resolveIndex` +
  the `IndexSource` type, drop `effectiveIndex`):
```ts
  const parsedOverride = declared.trim() === "" ? undefined : Number.parseFloat(declared.trim());
  const pendingSource: IndexSource =
    parsedOverride !== undefined && Number.isFinite(parsedOverride)
      ? { kind: "declared", value: parsedOverride }
      : { kind: computedChoice };
  const resolved = resolveIndex(pendingSource, record?.metrics ?? {});
```
  `INDEX_SOURCES` carries its `kind`:
```ts
const INDEX_SOURCES: readonly { readonly kind: "swng" | "whs"; readonly label: string; readonly description: string; readonly useLabel: string; readonly valueOf: (record: GetMyRecordResponse | undefined) => number | undefined }[] = [
  { kind: "swng", label: "swng index", description: "from all your rounds", useLabel: "Use swng index", valueOf: (record) => record?.metrics?.swngIndex?.value },
  { kind: "whs", label: "WHS index", description: "rated rounds, official rules", useLabel: "Use WHS index", valueOf: (record) => record?.metrics?.whsIndex?.value },
];
```
  Active-value paragraph (three-way label) + sources block ("Use this" sets the source; active row
  shows "in use"):
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
                      <button type="button" aria-label={source.useLabel}
                        onClick={() => { setComputedChoice(source.kind); setDeclared(""); }}
                        className="shrink-0 text-emerald-400 underline">
                        Use this
                      </button>
                    )
                  )}
                </div>
              );
            })}
          </div>
```
  The override input keeps `value={declared} onChange={(e) => setDeclared(e.target.value)}` — typing
  makes `pendingSource` a declared source. Save (replace the `...(parsedDeclared … declared)` spread
  and delete the now-dead `trimmedDeclared`/`parsedDeclared` guard atop `submit`):
```ts
      await auth.withAuth((token) =>
        updateMe(token, {
          name: name.trim(),
          ...(homeCourse ? { homeCourseId: homeCourse.id } : {}),
          indexSource: pendingSource,
        }),
      );
```

- [ ] **Step 15:** Web tests:
  - Create/Join: golfer `indexSource:{kind:"declared",value:12.4}`, rated tee (slope 130/rating
    71/par 72) → seeds `13`, note `from your index (12.4) on this course`; `{kind:"whs"}` +
    `metrics.whsIndex.value=10` on an unrated 9-hole tee → seeds `5`, note `from your WHS index
    (10.0), adjusted for 9 holes`; a typed value survives a re-seed.
  - ProfilePage: golfer on `{kind:"swng"}`, `swngIndex.value=12.4`/`whsIndex.value=11.2` → active
    `12.4` "from all your rounds", swng row "in use", WHS row has a "Use WHS index" button. Click
    "Use WHS index" → active `11.2` "your WHS index" (**override box still empty — not a copy**),
    Save posts `indexSource:{kind:"whs"}`. **This is the anti-drift test.** Type `8` → active `8.0`
    "your own", Save posts `{kind:"declared",value:8}`. Golfer on `{kind:"whs"}` with no whsIndex →
    "No WHS index yet" copy.

- [ ] **Step 16:** `pnpm validate` + `pnpm test:contract` — GREEN. Grep confirms zero remaining
  `effectiveIndex`/`.declared` in non-test source (`grep -rn "effectiveIndex\|\.declared" packages apps | grep -viE "dist|\.test\."`).
  Commit: `feat(domain,contracts,application,adapters,web): the index is a source you choose, resolved live — adopting WHS tracks WHS, no stored copy`.

---

### Task 2: E2E — the new source UI + copy

**Files:** `apps/web/e2e/unratedCourse.spec.ts`, `apps/web/e2e/identityRecord.spec.ts`, and any
spec touching the profile index surface or the create/join derivation note.

- [ ] **Step 1:** Grep the e2e dir for `declared`, `Use this`, `Your index`, `from your index`,
  `Use WHS` and reconcile each to the source model: a spec setting an index by typing the override
  still works (typing → declared source); a spec asserting the WHS row uses the new "in use" /
  "Use WHS index" DOM; the derivation-note assertion stays `from your index (X)` for a
  swng/declared golfer, and only a WHS-source golfer sees `from your WHS index (X)`.
- [ ] **Step 2:** `pnpm validate` (typecheck/lint the specs — live runs are the controller's gate).
  Commit: `test(e2e): index-source UI + WHS-named strokes derivation`.

## Self-Review (performed while writing)
- **Spec coverage:** §2 invariant → `resolveIndex` reads metrics live + the store never persists a
  computed number (Task 1 Steps 2, 10); §3 the type + permanent declared → Steps 1, 4; §4 resolver
  + undefined-first-class → Steps 2–3; §5 provenance → Step 14 (label) + 12/13 (note); §6 UX (Use
  this sets source) → Step 14; §7 sealed round untouched → no round/snapshot file touched; §8 blast
  radius, **no migration** → the store default (Step 10), golfer rows disposable; §9 tests incl.
  no-drift + getBySub → Steps 3, 11, 15.
- **No machinery:** `declared`/`effectiveIndex`/`official` deleted outright (Steps 1, 4, 6, 7, 10);
  no dual-carry, no tolerate-legacy — only a one-line `{kind:"swng"}` store default.
- **Green-per-commit:** Task 1 is atomic BECAUSE the domain type is imported everywhere — one
  commit keeps every layer consistent; splitting would require the shim this plan deliberately omits.
- **Type consistency:** `IndexSource` is the SAME union in domain, `indexSourceSchema`, the store
  map, and the web `pendingSource`; `resolveIndex(source, metrics)` identical at all three web sites;
  `ResolvedIndex.kind` drives the note noun (12/13) and the profile label (14).
- **Stays untouched:** `golferMetrics`/`swngIndex`/`whsIndex`, the strokes conversion + `/2`
  halving, `par`/`courseHandicap` on the line, the sealed round/snapshot.
