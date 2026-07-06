# swng — Engineering Conventions

> How we write the code this time. The [backend design](./backend-design.md) says *what* to build and
> the [product design](./product-design.md) says *why*; this says *how the code should read*. These are
> the rules for the rebuild, informed by what the proof-of-concept accreted.
>
> Two audiences: humans, and the coding agent. The enforceable subset is mirrored as a tight block in
> `CLAUDE.md` so it binds future work directly.

---

## 0. The one habit: strategic over tactical

Almost every quality problem in the POC is **accreted copy-paste** — each instance locally reasonable,
collectively boilerplate and drift. Seven near-identical `parseX` wrappers. A ~230-line router repeating
the same six steps per route. `coursePar` reimplemented in the web app. None of these were *decisions*;
they were the path of least resistance, taken twice.

**The rule that prevents all of them:** when the second instance of something appears, stop and build the
general version. Invest the 15%. This is Ousterhout's "design it twice" and strategic programming — it is
the parent of every specific convention below.

**Keep what the POC got right:** dependency-injection factory functions, ports defined by the application
layer, a pure `domain`, typed errors mapped to HTTP status *once* at the boundary, co-located tests, and
the tested reconnection logic. Don't reinvent these.

---

## 1. Naming — names must tell the truth

A name is the cheapest documentation and the cheapest bug-prevention. A name that lies is worse than no
name. Two rules the POC broke that we will not:

### 1a. Don't borrow a pattern's vocabulary unless you honor the pattern

- **Stores, not repositories.** Our persistence interfaces are thin key-value/table stores, not DDD
  aggregate *Repositories* (no unit-of-work, no aggregate roots, no collection semantics). Calling them
  `Repository` promises a pattern we don't implement. Name them `<Aggregate>Store`.

  | Don't | Do |
  | --- | --- |
  | `RoundRepository`, `createRoundRepository` | `RoundStore` (interface), `createDynamoRoundStore` (impl) |
  | `packages/…/repositories/` | `packages/…/stores/` |

- **Adapters are not ports.** The **port** is the interface (owned by `application`); the **adapter** is
  the concrete implementation (in `adapters-*`). An adapter named `…Port` is a category error.

  | Don't | Do |
  | --- | --- |
  | `createApiGatewayBroadcastPort` | `createApiGatewayBroadcast` |
  | `BroadcastPort` (interface, redundant suffix) | `Broadcast` (interface) |

  **Ports (interfaces)** are named for the *capability*, no `Port` suffix — the `ports/` folder already
  says it: `Broadcast`, `IdentityProvider`, `EventJournal`, `RoundStore`, `Clock`, `IdGenerator`,
  `Logger`. **Adapters (implementations)** are named `create<Technology><Capability>`:
  `createDynamoRoundStore`, `createApiGatewayBroadcast`, `createCognitoIdentityProvider`,
  `createPowertoolsLogger`.

### 1b. Fields and types must be true

The POC had three names that actively misled; none survive:

- `Player.color` held a *tee-set name* → `Participant.tee`. (Display color is a UI concern; it leaves
  the domain.)
- `TeeHole.handicapIndex` is a per-hole *difficulty ranking* → `strokeIndex`. ("Handicap index" is a
  player's rating; it lives on `User.profile`.)
- `RoundStatus = … | null` smuggled a fourth state that was never set → an explicit lifecycle enum, no
  `null`.

**Rule:** no field whose name misleads about what it holds; no state smuggled into a nullable union —
model states explicitly.

---

## 2. Package & directory layout

### 2a. A package must earn its boundary

A separate npm package is justified only by a **distinct consumer, runtime, or release cadence** — not by
size or tidiness. Default to a *folder in an existing package*. Applying this drops the repo from 13
packages to ~10 while the system grows:

- The four POC lambda packages (`lambda-http-handler` + three `lambda-ws-*`) plus the new stream/claim
  handlers → **one `lambda` package** with per-trigger entry points and one shared composition root.
  Each entry still deploys as its own function (esbuild tree-shakes per entry); they just stop being
  packages and finally share their wiring.
- `domain` stays **one** package. Scoring, handicap, policy, and identity are large but share domain
  types and the same two consumers (client + server); splitting them would create *shallow* packages —
  interface and build-graph cost with no isolation payoff.

### 2b. Directory conventions

- **Flat `src/`** — no `src/<pkgname>/` double-nesting. The POC repeats the package name as a folder in
  all 13 packages; it only lengthens imports.
- **Group by concept, not by technical kind.** `scoring/`, `handicap/`, `identity/` — never a `types/`
  or `utils/` dumping ground. Organize around information, not around layer-within-layer.
- **One public barrel per package (`src/index.ts`) is the package's interface.** Consumers import
  `@swng/domain`, never a deep path. Internal files use relative imports.
- **Tests co-locate as `*.test.ts` beside their subject** — not in a separate `__tests__/` tree. A test
  sits next to the thing it tests.

### 2c. The dependency direction is law, and it is enforced

`domain → application → adapters → lambda`, inner never importing outer. `domain` depends on nothing.
Ports live in `application`; adapters implement them; lambdas wire them. This is **enforced in
`eslint.config.js`** (`import/no-restricted-paths` or dependency-cruiser), not left to discipline — the
POC's layering is correct but one careless import from eroding.

---

## 3. Simplicity — few deep modules, not many shallow ones

- **Derive, don't store.** Persist only irreducible facts (`strokes`); compute everything else. Less
  stored state is less state to keep consistent — the deepest simplification available.
- **One dispatcher, not a per-route if-ladder.** HTTP routing is a declarative table
  `(method, pattern, schema, handler)`; session-check, body-parse, validation, and error-mapping happen
  *once* in the dispatcher, not copy-pasted into every branch. ~30 lines replace ~180.
- **One generic `parse(schema, input)`**, not one wrapper per schema.
- **One composition root.** `lambda/composition/container.ts` builds stores and services from env once;
  handlers receive them. No handler re-instantiates its dependencies.
- **No shallow modules.** A module must hide real complexity to justify its interface. Delete
  pass-through wrappers (a method that only forwards to one store call earns nothing).
- **Resist premature abstraction** — but the moment the *second* real case exists, build the deep module
  (§0). Simplicity is the balance of these two, not either alone.

---

## 4. Explicitness — say what you mean

- **Facts over inference.** Store `hostUserId`; don't re-derive the host by sorting players. Store an
  explicit `ScoringPolicy`; don't let "anyone can edit any score" be an accident. Carry an explicit
  `opId` idempotency key; don't dedupe implicitly.
- **Order explicitly.** Reconcile by an explicit `seq`, never by comparing wall-clock `updatedAt`
  strings lexicographically (the POC's fragile `scores[idx].updatedAt > score.updatedAt`).
- **Validate invariants at a known layer, consistently.** `domain` enforces domain invariants;
  `application` enforces authorization and orchestration. The POC's `updateScore` not checking the
  target participant exists is what "implicit" produces. No business logic in the view layer — the
  scoring math lives in `domain` and is imported, never reimplemented in the web app.
- **Typed errors, mapped once.** Throw `DomainError` / `ApplicationError` (with codes), never raw
  `Error` with a string; map code → HTTP status in one place at the boundary (keep the POC's
  `httpError.ts` pattern).
- **Comment the *why*, not the *what*.** Non-obvious decisions — sliding-window session refresh, why
  `seq` is assigned off the stream, match-relative stroke allocation — get a short why-comment. Obvious
  code gets none. A comment restates nothing the code already says.

---

## 5. Testing

- **Weight tests toward the deep modules.** The scoring engine deserves the most: property tests
  (`net ≤ gross`, countback determinism, client-result == server-result parity), not another router
  happy-path. Test where the complexity hides.
- **Co-located, one behavior per test**, pure-domain tests need no mocks (that's the payoff of a pure
  `domain`).
- **Every fixed bug gets a test that fails without the fix** (the missing-participant score write, the
  wall-clock tiebreak).

---

## 6. The enforceable subset (mirrored in `CLAUDE.md`)

The rules an agent can violate silently, so they are checked mechanically or stated as hard constraints:

1. Persistence interfaces are `…Store`; never `…Repository`.
2. Adapters are `create<Tech><Capability>`; never `…Port`. Port interfaces carry no `Port` suffix.
3. No field name that misleads (`tee` not `color`, `strokeIndex` not a "handicap index"); no `| null`
   state unions — use an explicit enum.
4. Flat `src/`; group by concept; tests co-located as `*.test.ts`; one `index.ts` barrel per package.
5. Respect the layer direction (`domain → application → adapters → lambda`); it is lint-enforced.
6. Second instance of a pattern → extract the general version; don't copy-paste a third.
7. Comment the *why*, never the *what*.
