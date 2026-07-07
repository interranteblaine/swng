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
  interfaces are thin key-value/table stores, not DDD Repositories (no unit-of-work, no
  collection semantics) — so they are `<Thing>Store`, never `<Thing>Repository`.
- **Ports are capabilities; adapters are technologies.** A port (interface, owned by
  `application`) is named for its capability with no `Port` suffix — the `ports/` folder
  already says it. An adapter (implementation, in `adapters-*`) is named
  `create<Technology><Capability>` — e.g. `createDynamoRoundStore`,
  `createCognitoIdentityProvider`. An adapter named `…Port` is a category error.
- **Fields hold what their names say.** A tee-set field is `tee`, not a color; a per-hole
  difficulty ranking is `strokeIndex` — "handicap index" is a golfer's rating and may only
  ever mean that. Domain vocabulary follows `architecture.md` (`Golfer` not "user",
  `Competition` not "event").
- **No state smuggled into nullable unions.** A lifecycle is an explicit enum; `| null` is
  not a state.

## 2. Package & directory layout

- **A package must earn its boundary** — a distinct consumer, runtime, or release cadence,
  never size or tidiness. Default to a folder in an existing package. Shallow packages
  (interface and build-graph cost, no isolation payoff) don't ship.
- **Flat `src/`** — no `src/<pkgname>/` double-nesting.
- **Group by concept, not technical kind** — `scoring/`, `handicap/`, `sync/`; never a
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
  Scoring math exists exactly once, in `domain`.
- **Typed errors, mapped once.** `DomainError`/`ApplicationError` with codes; code → HTTP
  status in one boundary module.
- **Comment the why, never the what.** Non-obvious decisions get a short why-comment;
  obvious code gets none.

## 5. Testing

- **Weight tests toward the deep modules** — the scoring and handicap engines and the merge
  logic, not another router happy-path. Test where the complexity hides.
- **The architecture's test benches are binding**: golden scorecards, WHS published-example
  conformance, property tests, the multi-device convergence simulation, settlement
  determinism, projection-rebuild equivalence (`architecture.md` §4).
- **Pure-domain tests use no mocks** — that's the payoff of a pure `domain`.
- **Every fixed bug gets a test that fails without the fix.** Scoring bugs become golden
  cards.

## 6. The enforceable subset

The rules an agent can violate silently, checked mechanically or stated as hard constraints:

1. Persistence interfaces are `…Store`, never `…Repository`.
2. Adapters are `create<Tech><Capability>`; port interfaces carry no `Port` suffix.
3. No misleading field names; no `| null` state unions — explicit enums.
4. Flat `src/`; group by concept; co-located `*.test.ts`; one barrel per package.
5. Layer direction is lint-enforced; `domain` imports nothing; AWS SDKs only in adapters.
6. Ordering by `seq`, conflict resolution by `hlc`, wall-clock comparison never.
7. Second instance of a pattern → extract the general version.
8. Comment the why, never the what.
