# swng — Engineering Conventions

> How the code should read. `product.md` says *why*, `architecture.md` says *what*; this doc
> is only about *how* — naming, layout, layering, and habits. It deliberately contains no
> architecture: anything about what to build lives in `architecture.md`.
>
> Re-derived 2026-07-07 from the validated architecture, replacing the prior-session
> conventions doc (git history has it; it holds no authority). Enforced by ESLint where
> possible — a lint failure is the source of truth, not prose here.

---

## 0. The one habit: strategic over tactical

When the second instance of something appears, stop and build the general version — don't
copy-paste a third. Accreted copy-paste is how codebases rot without anyone deciding
anything: each instance locally reasonable, collectively boilerplate and drift. Invest the
15%. This rule is the parent of every specific convention below; its counterweight is §3's
ban on premature abstraction — one real case is not a pattern yet.

## 1. Naming — names must tell the truth

A name is the cheapest documentation and the cheapest bug-prevention; a name that lies is
worse than no name.

- **Don't borrow a pattern's vocabulary unless you honor the pattern.** Our persistence
  interfaces are thin key-value/table stores, so they are named `<Thing>Store`. `Repository`
  is not a banned word — it is a name that must be *earned*: if a genuine Repository
  (collection semantics, unit-of-work) is ever built, `Repository` is exactly the honest
  name for it. What's forbidden is calling a thin store `Repository` — promising a pattern
  the code doesn't deliver.
- **Ports are capabilities; adapters are technologies.** The hard rule: an *adapter*
  (implementation, in `adapters-*`) named `…Port` is a category error — adapters are named
  `create<Technology><Capability>` (e.g. `createDynamoRoundStore`,
  `createCognitoIdentityProvider`). As house style (not law), port *interfaces* are named
  for the capability without a `Port` suffix — `Broadcast`, `Clock` — because the `ports/`
  folder already carries the role.
- **Naming rules are review-enforced, not lint-enforced.** Whether a name tells the truth
  is a judgment about the code behind it; lint can only match strings, which bans honest
  names and permits lying ones. Lint enforces the import graph; reviewers enforce names.
- **Fields hold what their names say.** A tee-set field is `tee`, not a color; a per-hole
  difficulty ranking is `strokeIndex`, never "handicap" — the row's printed name on a paper
  card is not its name in the model. What a player asserts about their game is a
  `StrokeBasis`; what the fold gives them for a round is `strokes`; what their record
  measures is their `average`. Domain vocabulary follows `architecture.md` (`Golfer` not
  "user", `Competition` not "event"), and "handicap"/"index" are not in it at all
  (spec 2026-07-29 §7/§9).
- **No state smuggled into nullable unions.** A lifecycle is an explicit enum; `| null` is
  not a state.

## 2. Package & directory layout

- **A package must earn its boundary** — a distinct consumer, runtime, or release cadence,
  never size or tidiness. Default to a folder in an existing package. Shallow packages
  (interface and build-graph cost, no isolation payoff) don't ship.
- **Flat `src/`** — no `src/<pkgname>/` double-nesting.
- **Group by concept, not technical kind** — `scoring/`, `golfer/`, `round/`; never a
  `types/` or `utils/` dumping ground.
- **One public barrel per package** (`src/index.ts`) is the package's interface. Consumers
  import `@swng/domain`, never a deep path; internal files use relative imports.
- **Tests co-locate** as `*.test.ts` beside their subject.
- **The layer direction is law**: `domain → application → adapters → entry points`, inner
  never importing outer; `domain` imports nothing; `contracts` is shared wire vocabulary;
  the browser side imports `domain`/`contracts`/`client` only. The concrete package graph is
  `architecture.md`'s to define; ESLint `no-restricted-imports` allow-lists enforce it, and
  AWS SDKs are importable only inside adapters.

## 3. Simplicity — few deep modules, not many shallow ones

- **Derive, don't store.** Persist only irreducible facts; compute everything else. Less
  stored state is less state to keep consistent — the deepest simplification available.
- **Do each cross-cutting thing once.** One declarative dispatcher (routing, parsing,
  validation, error-mapping in one place), one generic `parse(schema, input)`, one
  composition root that builds dependencies from env — never re-instantiated per handler.
- **No shallow modules.** A module must hide real complexity to justify its interface;
  pass-through wrappers get deleted.
- **Resist premature abstraction** — until the second real case exists (§0). Simplicity is
  the balance of these two, not either alone.

## 4. Explicitness — say what you mean

- **Facts over inference.** Store the fact (`hostGolferId`, an explicit `ScoringPolicy`, an
  explicit `opId`); never re-derive intent from incidental structure or dedupe implicitly.
- **Two clocks, two jobs — and never a third.** Canonical order and sync cursors come from
  server-assigned `seq`; concurrent-write resolution comes from the authoring-time `hlc`.
  Naive wall-clock comparison (ISO-string `updatedAt` ordering and kin) appears nowhere.
- **Invariants live at a known layer.** `domain` enforces domain invariants; `application`
  enforces authorization and orchestration; the view layer computes nothing it can import.
  Golf logic exists exactly once, in `domain`: the server runs it behind the API for reads and
  finalize, and the web runs it **on-device** for the offline round only through `@swng/client`
  (the one sanctioned client-side compute seam — `foldAndScore` plus the round-compute
  re-exports), never re-deriving a golf result in a view. See `architecture.md`'s "Where golf
  logic lives"; a lint fence (§6) makes it enforceable.
- **Typed errors, mapped once.** `DomainError`/`ApplicationError` with codes; code → HTTP
  status in one boundary module.
- **Comment the why, never the what.** Non-obvious decisions get a short why-comment;
  obvious code gets none.

## 5. Testing

- **Weight tests toward the deep modules** — the scoring engines, the stroke rule, the
  golfer's own folds, and the merge logic, not another router happy-path. Test where the
  complexity hides.
- **The architecture's test benches are binding**, and the list is exactly
  `architecture.md` §4's: golden cards, property tests, the multi-device convergence
  simulation, settlement determinism (including projection-rebuild equivalence). Nothing may
  be declared binding here that §4 does not list — a doc-declared gate nobody can satisfy is
  worse than a stale sentence.
- **Pure-domain tests use no mocks** — that's the payoff of a pure `domain`.
- **Every fixed bug gets a test that fails without the fix.** Scoring bugs become golden
  cards.

## 6. The enforceable subset

The rules an agent can violate silently, checked mechanically (lint) or held as hard
constraints at review:

1. Layer direction is lint-enforced; `domain` imports nothing; AWS SDKs only in adapters;
   browser-shared packages (`domain`, `contracts`, `client`) use no Node built-ins. The web
   imports golf **compute** only from `@swng/client`, never `@swng/domain` directly — the
   compute fence (`@typescript-eslint/no-restricted-imports` on `apps/web/src`) fails `pnpm lint`
   on any domain-compute import; presentation formatters, id constructors, pure accessors
   (`cellKey`/`findTeeSet`/`gameMembers`), and `import type`s stay allowed.
2. Review-enforced naming: thin stores are `…Store` (`Repository` only for the real
   pattern); adapters are `create<Tech><Capability>`, never `…Port`; no misleading field
   names; no `| null` state unions — explicit enums.
3. Flat `src/`; group by concept; co-located `*.test.ts`; one barrel per package.
4. Ordering by `seq`, conflict resolution by `hlc`, wall-clock comparison never.
5. Second instance of a pattern → extract the general version.
6. Comment the why, never the what.
7. Tests are typechecked: each package's `tsconfig.json` includes tests (`pnpm typecheck`),
   while `tsconfig.build.json` excludes them from emit.
