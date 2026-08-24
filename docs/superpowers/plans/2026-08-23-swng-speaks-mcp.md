# swng speaks MCP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose swng over the Model Context Protocol at `mcp.beta.swng.golf` — but only after the refactor that makes a second consumer safe.

**Architecture:** Two phases. **Phase 1 contains no MCP.** It ends the drift a second consumer would otherwise institutionalize: the golf presentation vocabulary moves out of `apps/web` into `@swng/domain/scoring/present.ts` (where half of it already lives), the fold moves out of `@swng/client` into `@swng/domain`, one shared compute fence replaces the per-consumer ones, the dispatcher is decoupled from API Gateway, and the API finally serves a folded round. **Phase 2** adds MCP as a thin renderer at `packages/lambda/src/mcp/`, plus an OAuth authorization server that mediates rather than issues — Cognito stays the only token issuer.

**Tech Stack:** TypeScript ESM, pnpm workspaces, Vitest, `@modelcontextprotocol/server@2.0.0` (+ `client@2.0.0` for tests), `zod@4`, `aws-jwt-verify@5.2.1`, AWS CDK v2, DynamoDB, Cognito with managed login, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-swng-speaks-mcp-design.md`. Read **§1.1** before Task 1 — it is the reason this plan is shaped the way it is. §4.2's measured Cognito findings are not re-derivable from AWS documentation.

## Global Constraints

- **The Phase 1 test:** every task in Phase 1 must be worth doing if the MCP arc were cancelled tomorrow. A task that fails that test is MCP scaffolding wearing a refactor's clothes and does not belong in Phase 1.
- **Every Phase 1 task is a MOVE.** No golf rule is written, changed, or reimplemented. If a move tempts you to "improve" the logic, don't — land the move, then propose the improvement separately.
- **A changed component-test assertion is a STOP condition, not a fix.** A moved unit test can drift along with its moved implementation and stay green; a test that stays behind cannot. **Find the tests that stay behind before you move anything**, per task:
  ```bash
  grep -rn "describeGame\|inParens\|roundLabel\|roundDayKey\|dayCollisionChecker\|strokesSummary\|unresolvedGames" apps/web/src --include="*.test.tsx"
  ```
  The one confirmed hard pin on `describeGame` is `ResultsView.test.tsx:121-122` (`"Ann & Bo win 1 up"`, `"Bo 5 · Dee 10 · 3 carried out"`) — hardcoded strings, not recomputed. Note that the *same file* at :113-117 calls `describeGame` inside the test and asserts the render matches it; that assertion is circular and proves nothing about a move. **Do not count a test that recomputes its own expectation.** `GamePanel.test.tsx` is not a pin on `describeGame` at all — `GamePanel.tsx:8` imports only `inParens`, and its match wording is its own.
  If a genuine pin goes red during Tasks 1–4, the move changed behaviour: revert and find out why. Editing the assertion to match the new output destroys the check.
- **Beta only.** `swng-prod` is not deployed in this arc. Every *MCP* resource hangs off a new optional `mcp` stack prop. The one unconditional infra change is `GET /rounds/{roundId}/view`, an ordinary additive route; Task 7 updates the infra tests that pin the route list and the `UseCases` literals the new member breaks.
- **Prod data is never wiped.**
- `CANONICAL` for beta is exactly `https://mcp.beta.swng.golf/mcp` — the MCP endpoint URL, the Cognito resource server identifier, and the PRM `resource`, one string. Scopes are `…/mcp/read` and `…/mcp/write`.
- Tests are Vitest, co-located `*.test.ts`, importing from `vitest` explicitly. One file: `pnpm -F <package> exec vitest run <file>` — `exec` is load-bearing.
- `pnpm validate` is the gate before any task is done.
- Node 20+, ESM. Relative imports carry `.js`.

### Verified foundation

Every row below was confirmed on 2026-08-24 by reading the named file at the named line or by
running the named command. **They are still worth spot-checking** — an earlier revision of this
plan shipped a table with two false rows under a heading telling engineers not to check.

| Fact | Evidence |
|---|---|
| `present.ts` exports exactly: `gameKindLabel`, `gameKindBlurb`, `gameKindFits`, `holeSelectionLabel`, `HOLE_SELECTION_ORDER`, `gameTreatment`, `strokesNote`, `underPar`, `formatOverPar`, `formatScoreVsPar` | `present.ts:18,34,49,73,107,142,194,216,223,243` |
| `present.ts`'s header states the invariant: "Pure formatters — **no golf RESULT is computed here**, which is why the web may import them directly", and names `gameStrokeAllocation`'s per-hole rule — "the only thing that needs a CourseCard" — as what does not belong | `present.ts:1-17` |
| `describeGame.ts` imports only `@swng/domain`; declares `nameOf(participants, golfer)` at :43; exports `GameDescription`, `describeGame`, `inParens`; five private `describe*` helpers + `sideNames` | `describeGame.ts:1-2,43,50` |
| `describeGame.test.ts` imports **8 values + 5 types** from `@swng/domain` (`fieldDeck18`, `fixtureLinks`, `fixtureLinks18`, `gameId`, `golferId`, `playGoldenRoundLog`, `reduceRound`, `scoreGame`) | `describeGame.test.ts:1-3` |
| `roundLabel.test.ts` imports **nothing** from `@swng/domain` — only `./roundLabel` — and already pins `timeZone: "UTC"` | `roundLabel.test.ts:1-6` |
| `finalizeReadiness.ts:1` imports `unresolvedGames` from **`@swng/client`**, not `@swng/domain`; declares `nameOf(state, golfer)` at :11 | `finalizeReadiness.ts:1,11` |
| `finalizeReadiness.test.ts` imports **8 values + 5 types** (`GameConfig`, `GameState`, `RosterEntry`, `RoundState`, `ScoreCell`) from `@swng/domain` | `finalizeReadiness.test.ts:1-4` |
| `dots.ts:1` imports `gameStrokeAllocation, totalDots` from **`@swng/client`**; `strokesSummary` takes a `CourseCard` and runs the allocation | `dots.ts:1` and body |
| `dots.test.ts` imports 4 values + 2 types from `@swng/domain`, and `gameDots, strokesSummary, totalDots` from `./dots` | `dots.test.ts:1-4` |
| `client/scoring.ts` declares `KNOWN_GAME_KINDS_BY_KIND`:19, `KNOWN_GAME_KINDS`:31, `foldAndScore`:40; everything from :86 is re-export | `scoring.ts:19,31,40,86` |
| `client/scoring.test.ts` has `buildLog()` producing **properly enveloped** events (hlc/opId/deviceId), and an existing test filtering an unknown game kind | `scoring.test.ts:1-20,~66` |
| `reduceRound` sorts by `compareHlc`, which dereferences `hlc.wallMs` — a bare `{kind,…}` literal cast to `RoundEvent[]` throws `TypeError` before any assertion | `round/state.ts:145`, `round/hlc.ts:11-15` |
| `GameState` has 5 arms carrying `ScoredStrokePlayLine[]`, `MatchHole[]`, `StablefordLine[]`, `SkinsLine[]`, `SkinsHole[]`, `dormie`, `carrying`, `carriedOut`, `holesDecided`, `leaders`, `thru`, `remaining` | `game.ts:98-160` |
| `GameResult` is settled-only: "there is no partial GameResult, only the live GameState for in-progress views" | `scoring/result.ts:22-24` |
| Contracts **already has** `matchOutcomeSchema`:251, `fourballOutcomeSchema`:253, `strokePlayLineSchema`:244 (the *settled* line). It has **no** schema for `GameState`, `MatchHole`, `StablefordLine`, `SkinsLine`, `SkinsHole`, or the scored stroke-play line | `contracts/src/round.ts` |
| The contracts idiom is `…SchemaImpl` (unannotated) + `…Schema: z.ZodType<T>` (annotated alias), and `round.test.ts:211` diffs `z.infer<typeof …Impl>` against the domain type **in both directions** — deliberately against the Impl, because the annotated alias makes the check a tautology | `round.ts:257-274`, `round.test.ts:211-236` |
| `RoundStatus` is `"setup" \| "live" \| "final" \| "abandoned"`; `RoundState.terminatedGameIds` is a **`ReadonlySet`** (not JSON-serializable as-is; the archive schema stores it as an array) | `round/state.ts:16,36-42` |
| **Three** object literals are typed `UseCases` | `compositionRoot.ts:308`, `dispatch.test.ts:175`, `routesParity.test.ts:9` |
| `dispatch.test.ts` is ~2331 lines with one `makeEvent` builder:106 and `asStructured`:138 typed on `APIGatewayProxyStructuredResultV2` | measured |
| `createDispatcher` touches the API Gateway event in exactly 5 places | `dispatch.ts:48,53-54,68-69,155` |
| `@typescript-eslint/no-unused-vars` is `"error"` in an **unscoped** block (repo-wide) | `eslint.config.mjs:194` |
| The golf-arithmetic fence is `files: ["apps/web/src/**/*.{ts,tsx}"]`, `ignores: [".../*.test.ts(x)"]` | `eslint.config.mjs:264-265` |
| `layer("packages/domain")` bans all `@swng/*` with **no** test exemption; domain tests use relative `.js` imports | `eslint.config.mjs`, `present.test.ts:1-9` |
| `ResultsView.test.tsx:121-122` hardcodes `describeGame` output (`"Ann & Bo win 1 up"`, `"Bo 5 · Dee 10 · 3 carried out"`) — a real pin. The same file at :113-117 **recomputes** its expectation by calling `describeGame`, which is circular. `GamePanel.tsx:8` imports only `inParens`, so `GamePanel.test.tsx` does **not** pin `describeGame` | read 2026-08-24 |
| `vitest run` does **not** typecheck: contracts' script is bare `vitest run` and only `apps/web` and `adapters-dynamodb` have a `vitest.config.*`. A compile-time assertion is only checked by `pnpm -F <pkg> typecheck` / `pnpm validate` | `contracts/package.json:17-18`; `find . -name vitest.config.*` |
| Exactly **three** routes read `ctx.query`: peek (`code`), events (`since`), courses (`query`, `limit`) | `routes.ts:378,389,461` |
| `recordScoreRequestSchema` requires caller-supplied `opId` and `hlc`; `createHlcSource` — the generator — lives in `@swng/client`, while `compareHlc` lives in `@swng/domain` | `commands.ts:180-187`, `recordScore.ts:8-12`, `client/src/hlc.ts:11` |
| `mintParticipantToken` throws `round-final` for a finalized round | `mintParticipantToken.ts:46` |
| The dispatcher's `AccountVerifier` is `createCognitoVerifier` — `tokenUse: "id"`, web client id | `compositionRoot.ts:300` |
| `GET /me/rounds` parses no query params; `GET /courses` requires `?query=`, takes `?limit=` | `routes.ts:501-504,458-461` |
| `swngStack.test.ts` pins a 41-key route list (~740) and `resourceCountIs(…Route, 43)` (~823) | `apps/infra-cdk/test` |
| `createMcpHandler` returns `McpHttpHandler` `{fetch,…}`; `AuthInfo` is `{token,clientId,scopes}` and the SDK throws without numeric `expiresAt`; `verifier` is an object with `verifyAccessToken`; `authInfo` arrives only via `handler.fetch(req,{authInfo})` | SDK `dist/*.d.mts`, `index.mjs:1408` |
| `aws-jwt-verify@5.2.1` checks `client_id` for access tokens and never reads `aud` | `dist/cjs/cognito-verifier.js:34-45` |
| Cognito: `resource` binds `aud` only for a **registered** resource server; identifier may carry a path; `aud` survives refresh; scopes must belong to the requested resource; an app client with no managed-login branding has **no login page** | measured against beta 2026-08-23, spec §4.2 |
| `Match.objectLike` rejects `expect.anything()` (`failCount 1`); use `Match.anyValue()` | measured |

---

# PHASE 1 — The refactor (no MCP)

### Task 1: One fence, shared — and the fold moves down

Two moves that belong together, because the second is unsafe without the first: adding exports to `@swng/domain` silently widens the web's fence, since that fence is a name banlist.

**Files:**
- Create: `packages/domain/src/scoring/fold.ts`, `packages/domain/src/scoring/fold.test.ts`
- Modify: `packages/domain/src/index.ts`, `packages/client/src/scoring.ts`, `eslint.config.mjs`

**Interfaces:**
- Produces from `@swng/domain`: `KNOWN_GAME_KINDS: ReadonlySet<GameConfig["kind"]>`, `foldAndScore(events): { state: RoundState; games: readonly GameState[] }`. Still re-exported by `@swng/client`.
- Produces in `eslint.config.mjs`: `DOMAIN_COMPUTE_BANLIST`, a single exported constant applied to every consumer.

- [ ] **Step 1: Read the shapes**

```bash
sed -n '35,60p' packages/domain/src/round/events.ts   # discriminant is `kind`, not `type`
grep -n "export type GameState" -A 15 packages/domain/src/scoring/game.ts   # flat union: members carry `id`
ls packages/domain/src/round packages/domain/src/scoring
```

- [ ] **Step 2: Move the test that already exists — do not write a new one**

`packages/client/src/scoring.test.ts` already has the exact test this move needs: *"filters an unknown/future game kind out of the scored games rather than throwing"* (~line 66). It builds its log through a `buildLog()` helper that produces **properly enveloped** events.

That envelope is not optional. `reduceRound` sorts by `byCanonicalOrder` → `compareHlc` → `a.hlc.wallMs`, so a hand-rolled `{ kind, config }` literal cast through `as unknown as RoundEvent[]` throws `TypeError: Cannot read properties of undefined (reading 'wallMs')` before any assertion runs — a failure that looks nothing like the one you want.

```bash
sed -n '1,40p'  packages/client/src/scoring.test.ts   # buildLog(): properly enveloped events
sed -n '55,80p' packages/client/src/scoring.test.ts   # the unknown-kind test itself
```

`buildLog` stamps `hlc`/`opId`/`deviceId` on every event. That envelope is load-bearing: `reduceRound` sorts through `compareHlc`, which dereferences `hlc.wallMs`.

Move that test (and whatever `buildLog` it depends on) into `packages/domain/src/scoring/fold.test.ts`, rewriting **every** import to a relative domain path with a `.js` extension — `layer("packages/domain")` bans all `@swng/*` with no test exemption, and existing domain tests (`present.test.ts`) import `../ids.js`, `./game.js`. Do **not** assert `KNOWN_GAME_KINDS.has("wolf") === false`: true by construction, cannot fail.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm -F @swng/domain exec vitest run src/scoring/fold.test.ts`
Expected: FAIL — `Failed to resolve import "./fold.js"`.

- [ ] **Step 4: Move it**

Move `KNOWN_GAME_KINDS_BY_KIND`, `KNOWN_GAME_KINDS`, `foldAndScore` verbatim from `packages/client/src/scoring.ts` into `packages/domain/src/scoring/fold.ts`, **comments included** — they explain the `satisfies Record<GameConfig["kind"], true>` guard. Import `reduceRound` from `../round/state.js`, `scoreGame` from `./game.js`. Export both from `packages/domain/src/index.ts`.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm -F @swng/domain exec vitest run src/scoring/fold.test.ts`
Expected: PASS. `games === []` means the fixture used `type` instead of `kind`.

- [ ] **Step 6: Re-export from the client**

Delete the three symbols from `packages/client/src/scoring.ts`, replace with:

```ts
// Moved to @swng/domain (2026-08-24, MCP arc Phase 1): the server folds rounds too, and
// @swng/application may not import this package. Re-exported here because the web reaches
// on-device compute through @swng/client, not through @swng/domain.
export { foldAndScore, KNOWN_GAME_KINDS } from "@swng/domain";
```

`session.ts` imports from `./scoring.js` and needs no edit.

- [ ] **Step 7: Prove the fence hole, then close it by extracting the banlist**

The probe has two traps, both measured:

- A **bare** import fails lint on `@typescript-eslint/no-unused-vars` (`"error"`, repo-wide, unscoped) — a red result that has nothing to do with the fence and will convince you the fence already bites. The probe must *use* the symbol.
- The compute-fence block `ignores: ["apps/web/src/**/*.test.ts", "apps/web/src/**/*.test.tsx"]`. Probe in a **non-test** file, or it passes identically before and after the fix.

So, in a non-test file under `apps/web/src`:

```ts
import { foldAndScore } from "@swng/domain";
export const __probe = (events: never[]) => foldAndScore(events).games.length;
```

Run: `pnpm lint` → **PASS**. That is the bug: the fence enumerates names, and new domain exports are not on the list.

Now, in `eslint.config.mjs`, lift the existing `@swng/domain` banlist out of the `apps/web` block into a module-level constant:

```js
// The domain-compute banlist. Compute is banned; the PRESENTATION vocabulary in
// scoring/present.ts is deliberately NOT on this list — a consumer that may not say a golf fact
// in words is a consumer that will write its own second wording of it (spec §1.1). Shared by
// every non-domain consumer so a new one inherits the rule instead of inventing a weaker or a
// blanket-stricter one.
const DOMAIN_COMPUTE_BANLIST = { group: ["@swng/domain"], importNames: [ /* the existing list */ ], message: /* the existing message */ };
```

Add `"foldAndScore"` and `"KNOWN_GAME_KINDS"` to it, and reference the constant from the `apps/web` block.

Re-run `pnpm lint`: expected FAIL on the probe. Delete the probe.

- [ ] **Step 8: Gate and commit**

```bash
pnpm validate
git add packages/domain packages/client eslint.config.mjs
git commit -m "refactor(domain): the fold moves down; one shared compute banlist"
```

---

### Task 2: The game vocabulary moves to `present.ts`

`describeGame` names and describes a game. `present.ts` already owns `gameKindLabel`, `gameKindBlurb`, `gameKindFits`, `gameTreatment` and `strokesNote` — this is the other half of the same job, sitting in `apps/web` where nothing server-side can reach it.

**Files:**
- Modify: `packages/domain/src/scoring/present.ts`, `packages/domain/src/index.ts`
- Delete: `apps/web/src/games/describeGame.ts` (+ move its test to the domain)
- Modify: every web importer of `describeGame` / `inParens`

**Interfaces:**
- Produces from `@swng/domain`: `describeGame(game: GameState, round: RoundState): GameDescription`, `inParens(relative: number): string`, and the `GameDescription` type.

- [ ] **Step 1: Find every consumer first**

```bash
grep -rn "describeGame\|inParens" apps/web/src --include=*.ts --include=*.tsx | grep -v "games/describeGame"
ls apps/web/src/games/
```

- [ ] **Step 2: Move the test first, and watch it fail**

Move `apps/web/src/games/describeGame.test.ts` (confirm it exists) to `packages/domain/src/scoring/describeGame.test.ts`. This is **not** a one-line import change: the test imports **8 values and 5 types** from `@swng/domain` (`fieldDeck18`, `fixtureLinks`, `fixtureLinks18`, `gameId`, `golferId`, `playGoldenRoundLog`, `reduceRound`, `scoreGame`; types `CourseCard`, `GameConfig`, `GameState`, `Participant`, `RoundState`), and `layer("packages/domain")` bans every `@swng/*` with no test exemption. Every one becomes a relative path with a `.js` extension — mirror `present.test.ts`, which imports `../ids.js`, `./game.js`, `../round/participant.js`.

Rewriting a test's imports is mechanical and safe; rewriting its *assertions* is not. If an assertion has to change, the move became a rewrite — stop and say so.

Run: `pnpm -F @swng/domain exec vitest run src/scoring/describeGame.test.ts`
Expected: FAIL — `describeGame` is not exported from `present.js`.

- [ ] **Step 3: Move the implementation, and resolve the helper collision**

Append `GameDescription`, `describeGame` and `inParens` to `present.ts`, dropping the now-local imports of `formatOverPar`/`gameKindLabel`.

**`describeGame.ts:43` declares a module-level `const nameOf(participants, golfer)`. `present.ts` already has `strokesOn(participants, id)`, and Task 4 will bring a second, differently-signatured `nameOf(state, golfer)` from `finalizeReadiness.ts`.** Two `const nameOf` in one module is a TS2451. Rename this one on arrival — `nameOfParticipant` — and leave Task 4's to arrive as `nameOfInRound`. Renaming a module-private helper preserves behaviour; merging the two into one "better" helper does not, and the Global Constraints forbid it mid-move.

Export from `packages/domain/src/index.ts`. Delete `apps/web/src/games/describeGame.ts`.

- [ ] **Step 4: Run the domain test**

Run: `pnpm -F @swng/domain exec vitest run src/scoring/describeGame.test.ts`
Expected: PASS

- [ ] **Step 5: Redirect the web's imports**

Point every consumer found in Step 1 at `@swng/domain`. `describeGame` is presentation, so it is **not** on the compute banlist and this import is legal — that is the point of Task 1 Step 7.

- [ ] **Step 6: Gate and commit**

Run: `pnpm validate` — the web's own component tests are the regression net here.

```bash
git add packages/domain apps/web
git commit -m "refactor(domain): describeGame joins the presentation vocabulary it belongs to"
```

---

### Task 3: The round designation moves to the domain

`roundLabel` is how a round is *named*, everywhere — "Casa Verde GC · Sat, Jul 12", with the tee time appended only when two rounds collide on course and day. Its own doc comment calls it a pure function with timezone as an explicit input. An agent answering "how did I play at Casa Verde?" needs the identical naming, and today it cannot have it.

**Files:**
- Create: `packages/domain/src/round/designation.ts` (+ move its test)
- Modify: `packages/domain/src/index.ts`
- Delete: `apps/web/src/roundLabel.ts`
- Modify: every web importer

**Interfaces:**
- Produces from `@swng/domain`: `RoundDesignation`, `RoundLabelOptions`, `RoundDayKeyOptions`, `roundLabel`, `roundDayKey`, `dayCollisionChecker`.

- [ ] **Step 1: Find consumers and the existing test**

```bash
grep -rln "roundLabel\|roundDayKey\|dayCollisionChecker" apps/web/src
ls apps/web/src/roundLabel.test.ts
```

- [ ] **Step 2: Move the test first, watch it fail**

Move `roundLabel.test.ts` to `packages/domain/src/round/designation.test.ts`, changing only the import path.

Run: `pnpm -F @swng/domain exec vitest run src/round/designation.test.ts`
Expected: FAIL — module not found.

**This is the one genuinely one-line test move in Phase 1.** `roundLabel.test.ts` imports nothing from `@swng/domain` — only `./roundLabel` — so the domain layer rule has nothing to relativize. It also already pins `timeZone: "UTC"` on its format assertions and compares its one local-zone case against `Intl.DateTimeFormat().resolvedOptions().timeZone` rather than a hardcoded string, so it is already CI-zone-safe. Change the import path and nothing else.

- [ ] **Step 3: Move verbatim, run, redirect the web**

`Intl.DateTimeFormat` exists in Node 20 and browsers, so the domain's zero-dependency, two-runtime contract holds. Do not "improve" the formatting.

- [ ] **Step 4: Gate and commit**

```bash
pnpm validate
git commit -am "refactor(domain): the round designation moves to the domain"
```

---

### Task 4: The readiness prose moves; the strokes line splits

Two functions in the web read as prose. **Only one of them is.**

- `finalizeReadiness.ts` → "holes 2–4 unscored for Pat". Pure formatting over the domain's own `unresolvedGames(state)`. It moves.
- `dots.ts#strokesSummary` → "Pat 5 dots · Alex 1 dot". Reads like prose, but takes a `CourseCard` and **runs `gameStrokeAllocation`**. It does not move — it splits.

`present.ts`'s header states the invariant this task must not break: *"Pure formatters — no golf RESULT is computed here, which is why the web may import them directly (they are not in the compute-fence banlist)"* — and it names *"gameStrokeAllocation's per-hole placement rule, which is the only thing that needs a CourseCard"* as the thing that doesn't belong. Dropping `strokesSummary` into `present.ts` would falsify that comment and silently let the web reach on-device allocation without going through `@swng/client`, inside a commit labelled a pure move. **Compute-then-format is compute.**

**Files:**
- Modify: `packages/domain/src/scoring/present.ts`, `packages/domain/src/index.ts`, `apps/web/src/round/dots.ts`
- Delete: `apps/web/src/round/finalizeReadiness.ts`
- Modify: web importers

**Interfaces:**
- Produces from `@swng/domain`: `describeUnresolvedGames(state, games): readonly UnresolvedGameDescription[]`, and `strokesLine(entries: readonly { name: string; dots: number }[]): string` — a formatter over already-computed dots.
- `apps/web/src/round/dots.ts` keeps `strokesSummary`, now three lines: allocate through `@swng/client`, total, hand the pairs to `strokesLine`.

- [ ] **Step 1: Resolve two name collisions before writing anything**

`finalizeReadiness.ts` exports `unresolvedGames`; the domain **already** exports a different `unresolvedGames` (the structured one it consumes). Rename the prose one **`describeUnresolvedGames`**, result type `UnresolvedGameDescription`.

Its module-private `nameOf(state, golfer)` collides with the `nameOf(participants, golfer)` Task 2 moved. Bring it in as **`nameOfInRound`**. (Task 2 renamed its own to `nameOfParticipant`.) Both are behaviour-preserving renames of private helpers; call them out in the commit message rather than burying them.

- [ ] **Step 2: Move the readiness test first, watch it fail**

Move `apps/web/src/round/finalizeReadiness.test.ts` to `packages/domain/src/scoring/`. As in Task 2, **every** `@swng/domain` import becomes relative with `.js` — 8 values (`cellKey`, `deviceId`, `fixtureLinks18`, `gameId`, `golferId`, `opId`, `roundId`, `scoreGame`) and 6 types (`GameConfig`, `GameState`, `RosterEntry`, `RoundState`, `ScoreCell`, …). The domain layer rule has no test exemption.

Run it: expected FAIL, not-exported.

- [ ] **Step 3: Move `describeUnresolvedGames`**

Append to `present.ts`. Its import of `unresolvedGames` currently comes from **`@swng/client`** (`finalizeReadiness.ts:1` — not `@swng/domain`, whatever an earlier revision of this plan's fact table said); inside the domain it becomes `../round/archive.js`. `describeGame` becomes local. `formatHoleRanges` and `describeMissing` stay module-private.

Run: expected PASS.

- [ ] **Step 4: Split `strokesSummary`**

Extract only the sentence into `present.ts`:

```ts
// "Pat 5 dots · Alex 1 dot" over ALREADY-COMPUTED dots — a formatter, which is why it may live
// here. Allocation is not: it needs a CourseCard, and this module computes no golf result.
// Members with no strokes are omitted; a game where nobody receives says so in words, because
// "everyone plays off 0" would be false for a match, where zero dots means the members are EQUAL
// at whatever level, not scratch (spec 2026-07-30 §3).
export const strokesLine = (entries: readonly { readonly name: string; readonly dots: number }[]): string => { … }
```

Move the existing "no strokes" comment with it verbatim — it carries a spec ruling.

`apps/web/src/round/dots.ts` keeps `strokesSummary` and its gross-game early return, and now ends `return strokesLine(pairs)`. Its `@swng/client` imports stay: that is the web's sanctioned compute seam and this task must not route around it.

Move `dots.test.ts`'s assertions accordingly — the sentence cases follow `strokesLine` into the domain; the allocation and gross-game cases stay in the web.

- [ ] **Step 5: Gate and commit**

```bash
pnpm validate
git commit -am "refactor(domain): readiness prose moves; the strokes line splits from its allocation"
```

---

### Task 5: Decouple the dispatcher from API Gateway

`createDispatcher` takes an `APIGatewayProxyEventV2`, but touches it in five places. That weld is why an earlier draft of this plan invented a look-alike request type for a second consumer instead of sharing the real one.

**Files:**
- Create: `packages/lambda/src/http/httpRequest.ts` (the transport-agnostic types), `packages/lambda/src/http/apiGatewayAdapter.ts` + test
- Modify: `packages/lambda/src/http/dispatch.ts`, `packages/lambda/src/entries/http.ts`, `packages/lambda/src/index.ts`

**Interfaces:**
- Produces: `HttpRequest { method, path, headers, query, body }`, `HttpResponse { statusCode, headers, body }` — **`statusCode`, matching the existing result shape**, so `dispatch.test.ts`'s 137 assertions stand unchanged (Step 3), `createDispatcher(...): (request: HttpRequest) => Promise<HttpResponse>`, and `fromApiGatewayEvent(event) => HttpRequest` / `toApiGatewayResult(response) => APIGatewayProxyResultV2`.

- [ ] **Step 1: Write the failing adapter test**

```ts
// packages/lambda/src/http/apiGatewayAdapter.test.ts
it("lifts the bearer header regardless of case", () => {
  expect(fromApiGatewayEvent(eventWith({ Authorization: "Bearer x" })).headers.authorization).toBe("Bearer x");
});
it("decodes a base64 body", () => { /* isBase64Encoded */ });
it("carries query parameters across", () => { /* queryStringParameters */ });
it("uppercases the method and takes the path from rawPath", () => { /* … */ });
```

These four assertions are exactly the five event touchpoints `dispatch.ts` has today — that is how you know the extraction is complete.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -F @swng/lambda exec vitest run src/http/apiGatewayAdapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Extract**

Move the five reads out of `dispatch.ts` into `fromApiGatewayEvent`, and change `createDispatcher`'s signature to take `HttpRequest`. `entries/http.ts` composes `toApiGatewayResult(await dispatch(fromApiGatewayEvent(event)))`.

**`dispatch.ts`'s existing tests are the regression net for this task, and they are large.** `dispatch.test.ts` is ~2300 lines with roughly **137** `statusCode` references and an `asStructured` helper typed on `APIGatewayProxyStructuredResultV2`.

The request half is genuinely one edit — the single `makeEvent` builder at :106 becomes a `makeRequest`, and `asStructured` at :138 (typed on `APIGatewayProxyStructuredResultV2`) is the only other type-coupled helper. The **response** half is not: renaming `statusCode` → `status` touches all 137 sites. Budget for that, or keep `HttpResponse` field-compatible (`statusCode`, `body`, `headers`) so the existing assertions stand unchanged. **Prefer the second** — a 137-site rename inside a refactor whose whole claim is "no behaviour changes" is a large diff that buys nothing, and `statusCode` is a perfectly good name.

If a test needs a *semantic* change, the extraction changed behaviour: stop and find out why.

- [ ] **Step 4: Run the whole lambda suite**

Run: `pnpm -F @swng/lambda test`
Expected: PASS

- [ ] **Step 5: Gate and commit**

```bash
pnpm validate
git commit -am "refactor(lambda): a transport-agnostic dispatcher with an API Gateway adapter"
```

---

### Task 6: The live scoring shape goes on the wire

`@swng/contracts` can serialize a **settled** game (`gameResultSchema`) and cannot serialize a game **in progress**. `resultOf` says so itself: *"there is no partial `GameResult`, only the live `GameState` for in-progress views."* So the live scoring shape — totals, thru, leader, dormie, carrying — has never left the browser, and Task 7's read cannot exist without it.

This is the sharpest instance of the drift in §1.1, and it stands alone with MCP cancelled: the product's most important read is not behind the API.

**Files:**
- Modify: `packages/contracts/src/round.ts`
- Create: `packages/contracts/src/gameState.test.ts` (or extend `round.test.ts` — match the file's own convention)

**Interfaces:**
- Produces: `gameStateSchema: z.ZodType<GameState>` exported from `@swng/contracts`.

- [ ] **Step 1: Read both the target union and the existing precedent**

```bash
grep -n "export type GameState" -A 60 packages/domain/src/scoring/game.ts
sed -n '250,280p' packages/contracts/src/round.ts    # gameResultSchemaImpl — the pattern to follow
```

`gameResultSchemaImpl` is a `z.discriminatedUnion("kind", […])` assigned to a separately-declared `z.ZodType<GameResult>`. The doc comment above it (`round.ts:257`) explains why the two-step exists — read it and follow it exactly; the same reasoning applies here.

- [ ] **Step 2: Extend the existing type-parity check — this is the real test**

`round.test.ts:211` already holds the mechanism, and its own comment explains why it is written the way it is: it diffs `z.infer<typeof …SchemaImpl>` against the domain type **in both directions**, deliberately against the *unannotated* Impl, because the annotated `z.ZodType<T>` alias makes `z.infer` equal `T` by declaration — "a tautology that compiles even if a union member silently falls out of the schema array."

Add to that test:

```ts
const forwardState: GameState = {} as z.infer<typeof gameStateSchemaImpl>;
const backwardState: z.infer<typeof gameStateSchemaImpl> = {} as GameState;
```

This is what catches a dropped field or a missing arm, and it catches it at compile time across all five kinds at once. Extend the test's title to name `gameStateSchema` too.

- [ ] **Step 3: Add a parse test per kind, driven off a real fold**

Structural parity is not enough on its own — it says the shapes agree, not that a real value survives JSON:

```ts
for (const kind of ["stroke-play", "singles-match", "stableford", "fourball-match", "skins"] as const) {
  it(`round-trips a live ${kind} game`, () => {
    const [state] = foldRoundWithOneGameOf(kind).games;      // a real fold, not a literal
    expect(parse(gameStateSchema, JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
}
it("round-trips a match that has gone dormie", () => { /* the arm most likely to be missed */ });
```

Use `playGoldenRoundLog` + `reduceRound` + `scoreGame` from `@swng/domain` (contracts may import domain — `round.test.ts:3` already does). A hand-built literal proves nothing here: it would be written from the same reading of the type as the schema.

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm -F @swng/contracts exec vitest run src/round.test.ts`
Expected: FAIL — `gameStateSchemaImpl` is not exported.

- [ ] **Step 5: Author the union and its nested line schemas**

Five arms — and the nested shapes are the bulk of the work. **Already present:** `matchOutcomeSchema` (:251), `fourballOutcomeSchema` (:253). **Missing, and each must be written:** the scored stroke-play line (note `strokePlayLineSchema` at :244 is the *settled* line, not `ScoredStrokePlayLine` — check the two types before reusing it), `StablefordLine`, `SkinsLine`, `SkinsHole`, `MatchHole`.

Follow the file's idiom exactly: unannotated `gameStateSchemaImpl`, then `export const gameStateSchema: z.ZodType<GameState> = gameStateSchemaImpl;`.

- [ ] **Step 6: Run, then falsify**

Expected PASS. Then delete `thru` from the `singles-match` arm and run **`pnpm -F @swng/contracts typecheck`** — *not* `vitest run`, which uses esbuild and drops types entirely, so a compile-time assertion can never fail under it. The parity check must go red there. If `typecheck` stays green while only the parse test fails, the parity assertion was written against the annotated alias instead of the Impl — the exact tautology `round.test.ts`'s comment warns about. Restore.

- [ ] **Step 7: Commit**

```bash
pnpm validate
git add packages/contracts
git commit -m "feat(contracts): a wire schema for live game state"
```

---

### Task 7: `GET /rounds/{roundId}/view` — the API serves a folded round

The last piece of drift: no route returns a folded round, so the browser is the only thing that can answer "how is this round going".

**Files:**
- Modify: `packages/contracts/src/round.ts`, `packages/application/src/index.ts`, `packages/lambda/src/http/routes.ts`, `packages/lambda/src/compositionRoot.ts`, `apps/infra-cdk/lib/swngStack.ts`, `apps/infra-cdk/test/swngStack.test.ts`
- Create: `packages/application/src/rounds/getRoundView.ts` + test

**Interfaces:**
- Produces: `RoundViewResponse`; `getRoundView(deps) => (claims: AccountClaims, roundId: RoundId) => Promise<RoundViewResponse>`; route `GET /rounds/{roundId}/view`, `auth: "golfer"`, `successStatus: 200`.

- [ ] **Step 1: Compose the response from what now exists**

```bash
grep -n "holeSelectionSchema\|courseCardSchema\|rosterEntry\|roundStatus" packages/contracts/src/round.ts
grep -n "export const unresolvedGames" -A 6 packages/domain/src/round/archive.ts
```

```ts
export interface RoundViewResponse {
  readonly status: RoundStatus;
  readonly card: CourseCard;
  readonly holes: HoleSelection;
  readonly playedAt: number;
  readonly participants: readonly RosterEntry[];
  readonly games: readonly GameState[];              // Task 6's schema — LIVE scoring, not GameResult
  readonly unresolved: readonly UnresolvedGameDescription[];  // Task 4's prose
}
```

`games` is `GameState`, not `GameResult`: a `GameResult` is `undefined` until a game settles, so a `GameResult[]` response would be empty for every live round — silent on the question this route exists to answer.

- [ ] **Step 2: Write the failing test — authorization first**

```ts
it("folds a live round for someone on the roster", async () => { /* status "live", games present */ });

it("REFUSES a live round to a golfer who is not on the roster", async () => {
  // Live rounds are capability-gated; settled ones are history.
  await expect(getRoundView(liveDeps())(strangerClaims, roundId)).rejects.toThrow(/participant/);
});

it("serves a finalized round to any signed-in golfer, matching GET /archive", async () => { /* … */ });

// RoundStatus has FOUR arms — "setup" | "live" | "final" | "abandoned". A guard written as
// `status === "live" ? requireRoster : allow` leaks a setup round's roster and card, and an
// abandoned round's, to any signed-in golfer. Today neither is reachable, because
// getRoundArchive reads the snapshot only; this route makes them reachable. The rule is
// "anything not final requires the roster", and these two tests are what hold it.
it("REFUSES a setup round to a golfer who is not on the roster", async () => { /* … */ });
it("REFUSES an abandoned round to a golfer who is not on the roster", async () => { /* … */ });

it("reports round-not-found when neither store has it", async () => { /* … */ });

it("reports unresolved games in words for a live round", async () => {
  const view = await getRoundView(liveDepsMissingHoles())(participantClaims, roundId);
  expect(view.unresolved[0]!.missing).toMatch(/unscored for/);
});
```

The tier is **`golfer`**, not `round-read`: `mintParticipantToken` throws `round-final`, so a round-scoped tier would 409 on exactly the finished rounds a golfer's history is made of. Authorization splits inside the use case on liveness instead. Build fixtures from `packages/application/src/testing/fakes.ts`.

- [ ] **Step 3: Run to verify it fails, then implement**

```ts
// Journal first, snapshot as the fallback. Finalize APPENDS round-finalized to the journal and
// writes the snapshot in the same transaction, and nothing truncates the journal — so a settled
// round is in both stores and this usually reads the journal for it too. The snapshot branch is
// the safety net for a round whose journal has been trimmed, not the normal path for a finished
// round. (An earlier draft of this plan claimed the opposite; check EventJournal.AppendOptions
// before you trust either sentence.)
const live = await deps.journal.read(roundIdValue, 0);
const events = live.length > 0 ? live : (await deps.snapshots.get(roundIdValue))?.events;
if (!events || events.length === 0) throw new ApplicationError("round-not-found");
const { state, games } = foldAndScore(events);

// Authorization splits on SETTLEDNESS, not tier and not liveness. A FINAL round is readable by
// any signed-in golfer — the rule getRoundArchive already applies, because a settled scorecard is
// already visible on every participant's record. Everything else — setup, live, abandoned — is
// readable only from its roster.
if (state.status !== "final") { /* require the caller on state.participants */ }
```

Resolve `sub` → `golferId` through the existing helper (`grep -rn "claims.sub" packages/application/src | head`) — do not write a second one.

- [ ] **Step 4: Run, then falsify**

Run: `pnpm -F @swng/application exec vitest run src/rounds/getRoundView.test.ts`
Expected: PASS (7). Delete the settledness guard and confirm the three refusal tests go red.

- [ ] **Step 5: Wire the route and fix everything the new `UseCases` member breaks**

Route (`auth: "golfer"`, with a comment naming the `round-final` reason), `UseCases`, `compositionRoot`, `HTTP_ROUTES` (+ its doc comment, 41 → 42).

Adding a member to `UseCases` breaks **every exhaustive object literal typed as it**. Find them all rather than trusting a count:

```bash
grep -rn ": UseCases = {\|UseCases> = {\|satisfies UseCases" packages apps --include="*.ts" | grep -v node_modules
```

There are exactly **two** today: `packages/lambda/src/http/dispatch.test.ts:175` and `apps/infra-cdk/test/routesParity.test.ts:9`. Run the grep anyway — a third may have landed since. Then `apps/infra-cdk/test/swngStack.test.ts`: add `"GET /rounds/{roundId}/view"` to `expectedRouteKeys` (~740), retitle the "forty-one" test, and change `resourceCountIs("AWS::ApiGatewayV2::Route", 43)` → `44` (~823).

- [ ] **Step 6: Gate and commit**

```bash
pnpm validate
git commit -am "feat(api): GET /rounds/{roundId}/view returns a folded round"
```

---

### Task 8: HLC minting moves to the domain

The third instance of the same drift, and the one that MCP surfaced rather than invented.

`score-recorded` is **the one client-authored event kind** (`recordScore.ts:8-12`): the caller supplies `opId` and `hlc`, and only `authorId` is stamped server-side. The rule for generating that `hlc` — monotonic wall clock, counter on tie, device tag — lives in `createHlcSource` at `packages/client/src/hlc.ts`, which only a browser can reach. `compareHlc`, the rule that *consumes* it, is in `@swng/domain`. A generator and its comparator living in different packages is a smell on its own; it becomes a defect the moment a second client exists, because that client has to write its own.

**Files:**
- Create: `packages/domain/src/round/hlcSource.ts` (+ move its test)
- Modify: `packages/domain/src/index.ts`, `packages/client/src/hlc.ts` (re-export), `packages/client/src/session.ts` if its import path changes

**Interfaces:**
- Produces from `@swng/domain`: `HlcSource`, `createHlcSource(deviceId: DeviceId, clock?: { now(): number }): HlcSource`.

- [ ] **Step 1: Read it and confirm it is movable**

```bash
cat packages/client/src/hlc.ts
sed -n '1,20p' packages/client/src/hlc.test.ts
```

It takes an injectable `clock` defaulting to `Date.now`, so it is deterministic under test and carries no browser dependency. If that is not what you find, **stop** — the move is off and the MCP layer needs a different answer.

- [ ] **Step 2: Move the test first, watch it fail**

Move `hlc.test.ts` into `packages/domain/src/round/`, relativizing every `@swng/domain` import (the domain layer rule has no test exemption). Run it: expected FAIL, not-exported.

- [ ] **Step 3: Move, re-export, run**

`packages/client/src/hlc.ts` becomes a re-export, the same shape Task 1 gave `scoring.ts`. `session.ts:3` imports `createHlcSource` from `./hlc.js` and needs no edit.

- [ ] **Step 4: Gate and commit**

```bash
pnpm validate
git commit -am "refactor(domain): HLC minting joins the comparator it feeds"
```

**Why this is Phase 1 and not Phase 2:** with MCP cancelled, the generator and comparator still belong together, and `client/hlc.ts` still holds a rule nothing else can reach. It is the weakest of Phase 1's justifications and it is still a real one — but be honest in review that MCP is what exposed it.

---

> **Phase 1 gate.** Before starting Phase 2, confirm the refactor stands on its own: `pnpm validate` green, `pnpm e2e:beta` green, and the web behaves identically by hand on the round, watch, archive and finalize screens. Nothing in Phase 1 should be visible to a user. If the web changed, a move became a rewrite.

---

# PHASE 2 — MCP

### Task 9: The access-token verifier

**Files:** `packages/adapters-cognito/src/createAccessTokenVerifier.ts` + test; modify `index.ts`.

**Interfaces:** an **`OAuthTokenVerifier`** — an object with `verifyAccessToken(token): Promise<AuthInfo>` returning `{ token, clientId, scopes, expiresAt }`. Not a bare function: `requireBearerAuth` calls `.verifyAccessToken` and **throws** without a numeric `expiresAt`. Also produces an `AccountVerifier` adapter (`(bearer) => Promise<{ sub }>`) for Task 9, since the dispatcher needs `sub` and `AuthInfo` has no such field.

- [ ] **Step 1: Write the failing tests**

```ts
const CANONICAL = "https://mcp.beta.swng.golf/mcp";
const claims = { sub: "s1", aud: CANONICAL, scope: `${CANONICAL}/read`, client_id: "abc", exp: 1893456000 };

it("returns the AuthInfo shape requireBearerAuth needs, expiresAt included", async () => {
  await expect(accessTokenVerifierFrom({ verify: async () => claims }, CANONICAL).verifyAccessToken("t"))
    .resolves.toEqual({ token: "t", clientId: "abc", scopes: [`${CANONICAL}/read`], expiresAt: 1893456000 });
});

it("REJECTS a token issued for a different audience", async () => {
  // aws-jwt-verify checks client_id for access tokens and NEVER reads aud (its own source), so
  // without this explicit check a bound token and an unbound one verify identically.
  await expect(accessTokenVerifierFrom({ verify: async () => ({ ...claims, aud: "https://elsewhere/mcp" }) }, CANONICAL)
    .verifyAccessToken("t")).rejects.toThrow(/audience/i);
});

it("REJECTS a token with no aud at all", async () => { /* … */ });
it("exposes sub through the AccountVerifier adapter the dispatcher needs", async () => { /* { sub: "s1" } */ });
```

- [ ] **Step 2–4:** Run (fail) → implement, mirroring `createCognitoVerifier.ts`'s `…From` split so tests never touch JWKS → run (pass). Then **delete the `aud` comparison, re-run, confirm tests 2 and 3 go red**, restore.

- [ ] **Step 5: Commit**

---

### Task 10: The tool table

**Files:** `packages/lambda/src/mcp/toolTable.ts` + test; modify `eslint.config.mjs`.

- [ ] **Step 0: Fence the subtree before you put anything in it**

`layer("packages/lambda", …)` bans only `@swng/client` and the AWS SDKs, so a new file under `packages/lambda/src/mcp/` may import `scoreGame` and `reduceRound` freely — and Task 1's shared banlist buys nothing until it is actually applied here. Add a block scoping `DOMAIN_COMPUTE_BANLIST` to `packages/lambda/src/mcp/**/*.ts`, and add that glob to the golf-arithmetic fence's `files`.

Verify it the way Task 1 does: a probe that *uses* a banned symbol in a non-test file must fail `pnpm lint`, and `describeGame` (presentation, not on the banlist) must not. Delete the probe.

**Interfaces:**

```ts
export interface ToolDefinition {
  readonly name: string; readonly title: string; readonly description: string;
  readonly scope: "read" | "write";
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;                     // the routes.ts template
  readonly pathParams: readonly string[];
  readonly queryParams?: readonly string[];
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
}
```

- [ ] **Step 1: Compose schemas — and subtract the fields the transport authors**

Every write route already has a request schema in `@swng/contracts`, and they are all `z.object`, so they compose:

```ts
inputSchema: setHolesRequestSchema.extend({ roundId: roundIdSchema }),
```

**But composition alone produces a broken `record_score`.** `recordScoreRequestSchema` (`commands.ts:180`) requires `opId` **and** `hlc: { wallMs, counter, deviceId }` — `score-recorded` is the one client-authored event kind, and every client mints those itself (`recordScore.ts:8-12`). Composed naively, the flagship tool asks a language model to author a hybrid logical clock. That is not merely awkward: `hlc` is the **last-writer-wins key** the round's whole convergence rests on (`reduceRound` → `compareHlc`), so a model-invented `wallMs` silently wins or loses against real scores coming off a phone.

The MCP layer *is* a client. It mints them, exactly as the browser session does:

```ts
// Fields the transport authors, never the model. Subtracted from the tool schema and filled by
// the dispatcher — the same division the web already makes (session.ts mints hlc/opId; the user
// supplies only the score). Composition is still the rule; this is the one carve-out, and it is
// declared per tool rather than inferred, so a new field on a request schema surfaces here.
readonly authored?: readonly ("opId" | "hlc")[];
```

`record_score` declares `authored: ["opId", "hlc"]` and omits both via `.omit({ opId: true, hlc: true })`. Task 8 put `createHlcSource` in `@swng/domain`, so `dispatchTool` builds one per invocation with `deviceId("mcp")` and fills them.

Check every other write route for fields in the same class before writing its tool — `grep -n "opId\|hlc" packages/contracts/src/commands.ts`.

**Do not hand-write `z.enum(["all","front","back"])`** — that is `holeSelectionSchema`, and `setHolesRequestSchema` already uses it. Restating a contract is the drift this arc exists to end (spec §1.1). Check each route's `schema:` field and its handler line together:

```bash
grep -n "schema:\|handler:" packages/lambda/src/http/routes.ts | head -60
```

**Exactly three routes read `ctx.query`** (`routes.ts:378,389,461`) — check all three, and only those:

- `GET /rounds/peek` → `peekRound(parseJoinCode(ctx.query.code))`. `peek_round` needs `queryParams: ["code"]`, **required**. Ship it with an empty schema and every one of Step 2's tests still passes while the tool 400s at runtime.

Two more an earlier draft fabricated:
- `GET /me/rounds` → `useCases.getMyRounds(ctx.account!)` — parses **no** query. `list_my_rounds` gets an empty schema, not paging that does nothing.
- `GET /courses` → `searchCourses(parseSearchQuery(ctx.query.query), parseLimit(ctx.query.limit))` — `search_courses` needs `queryParams: ["query","limit"]`, `query` required.

- [ ] **Step 2: Write the failing tests**

```ts
it("declares every path param its template names", () => { /* pathParams vs /\{(\w+)\}/g */ });
it("names every path and query param in its input schema", () => { /* inputSchema.shape */ });
it("sends nothing in a GET body", () => {
  // A GET body is dropped on the wire, so an unrouted argument vanishes silently — the failure
  // that made search_courses 400 in an earlier draft.
  for (const t of TOOL_TABLE.filter((t) => t.method === "GET")) {
    const routed = new Set([...t.pathParams, ...(t.queryParams ?? [])]);
    expect(Object.keys(t.inputSchema.shape).filter((k) => !routed.has(k)), t.name).toEqual([]);
  }
});
it("is sorted by name, so tools/list is deterministic", () => { /* … */ });
it("every tool names a live route", () => {
  const keys = new Set(buildRoutes(stubUseCases).map((r) => `${r.method} ${r.path}`));
  expect(TOOL_TABLE.filter((t) => !keys.has(`${t.method} ${t.path}`)).map((t) => t.name)).toEqual([]);
});
it("covers all 23 tools", () => { expect(TOOL_TABLE).toHaveLength(23); });
```

Parity lives here naturally now: `packages/lambda` owns both sides. No package boundary to bridge.

- [ ] **Step 3: Write the 23 entries**

Reads (11): `crew_season_standings`, `get_course`, `get_crew`, `get_round`, `list_live_rounds`, `list_my_crews`, `list_my_rounds`, `my_course_record`, `peek_round`, `search_courses`, `whoami`.

Writes (12): `abandon_round`, `add_game`, `finalize_round`, `join_round`, `leave_round`, `record_score`, `set_participant_strokes`, `set_round_holes`, `set_round_played_at`, `share_round`, `start_round`, `terminate_game`.

Two descriptions carry a warning — the only one-way acts: `abandon_round` ("terminal and irreversible; the round produces no archive and counts nowhere") and `share_round` ("mints a permanent public link anyone can watch with"). `share_round` and `finalize_round` act on a **live** round only, because the participant-token mint refuses a finalized one — say so.

- [ ] **Step 4–5:** Run (pass), commit.

---

### Task 11: Tool dispatch, and the verifier seam that makes it work

**The bug this task exists to prevent:** the dispatcher's `AccountVerifier` is `createCognitoVerifier` — `tokenUse: "id"`, web client id. Hand it a Cognito **access** token and it 401s: nine read tools, `start_round`, `join_round`, and the participant-token mint every write depends on. Tasks 10 and 12 mock the dispatcher, so nothing else catches it.

**Files:** `packages/lambda/src/mcp/toolDispatch.ts` + test; modify `compositionRoot.ts`.

- [ ] **Step 1: Open the verifier seam**

`buildApp` constructs `createCognitoVerifier` internally. Add an injectable override in the same idiom as the existing `deps.readSecret`:

```ts
deps: { readSecret?: (arn: string) => Promise<string>; accountVerifier?: AccountVerifier } = {}
```

using `deps.accountVerifier ?? createCognitoVerifier({ … })` at the existing site. Test it: `buildApp(env, { accountVerifier: fake })`, dispatch a `golfer` route, assert the fake was called.

- [ ] **Step 2: Write the failing dispatch tests**

```ts
it("sends the caller's own access token for a golfer-tier route", async () => { /* bearer === "ACCESS" */ });

it("mints a round-scoped token for a participant route and sends THAT", async () => {
  // The credential rides in `headers.authorization` — Task 5's HttpRequest has no `bearer`
  // field, and the dispatcher reads the header exactly as it does for a real HTTP call.
  expect(dispatch.mock.calls[0][0]).toMatchObject({ path: "/rounds/r1/token", headers: { authorization: "Bearer ACCESS" } });
  expect(dispatch.mock.calls[1][0]).toMatchObject({ path: "/rounds/r1/holes", headers: { authorization: "Bearer ROUND-TOKEN" } });
});

it("surfaces a failed mint instead of calling the route with a bad token", async () => {
  // mintParticipantToken 409s round-final. Report THAT, not a confusing 401 from a route the
  // call should never have reached.
  const result = await dispatchTool(deps, tool("set_round_holes"), { roundId: "r1", holes: "back" }, "ACCESS");
  expect(result.statusCode).toBe(409);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it("routes path args to the path, query args to the query, the rest to the body", async () => { /* … */ });
it("sends no body for a GET", async () => { /* … */ });
```

- [ ] **Step 3: Implement against the real `HttpRequest`**

Task 5 made the dispatcher transport-agnostic, so this constructs a **real** `HttpRequest` — no look-alike type, no synthetic API Gateway event:

```ts
// Which tier a route sits in decides which credential goes on the wire. The ten "participant"
// routes want a round-scoped token the MCP caller never holds: an agent authenticates as a
// golfer, not as a device that joined a round. Minting it here reuses POST /rounds/{roundId}/token,
// which already proves participation. No new authorization logic exists in this file.
//
// Reads are deliberately not in this path: GET /rounds/{roundId}/view is "golfer"-tier precisely
// because the mint refuses a finalized round.
```

The tier comes from `buildRoutes` folded into a `Map` keyed `` `${method} ${path}` `` — read, never duplicated into the tool table. Confirm the mint response's field name in contracts rather than assuming `token`.

- [ ] **Step 4–5:** Run (pass), gate, commit.

---

### Task 12: The MCP server

Read the shipped declarations **before writing a line** — an earlier draft invented three APIs:

```bash
cd /tmp && npm pack @modelcontextprotocol/server --silent && tar -xzf modelcontextprotocol-server-2.0.0.tgz
grep -n -A6 "interface McpHttpHandler\|interface McpRequestContext\|interface McpHandlerRequestOptions" package/dist/*.d.mts
grep -n "registerTool" package/dist/*.d.mts | head
```

`createMcpHandler(factory, options?)` returns an **`McpHttpHandler`** (`{ fetch, close, notify, bus }`). `authInfo` is **optional** on the factory context and **strictly pass-through** — supplied by the caller via `handler.fetch(request, { authInfo })`.

**Files:** `packages/lambda/src/mcp/server.ts` + test.

- [ ] **Step 1: Write the failing conformance test through the HTTP handler**

Do **not** use `InMemoryTransport`: it wires a `Client` straight to a `Server` and bypasses `createMcpHandler`, so it would prove nothing about the path production uses. Use `StreamableHTTPClientTransport` with a custom `fetch` calling `handler.fetch(request, { authInfo })`.

```ts
it("hides write tools from a read-only token", async () => { /* get_round yes, record_score no */ });
it("shows write tools when the write scope is present", async () => { /* … */ });
it("reports an application error as a tool execution error, not a protocol error", async () => { /* isError true */ });
```

**A consequence worth naming:** hiding write tools means the `403 insufficient_scope` step-up flow cannot fire — a tool that was never listed is never called. A golfer who chose read-only changes their mind by reconnecting, which walks the same consent page. That is the intended v1 behaviour (spec §4.4); do not add `requiredScopes` to `requireBearerAuth` expecting step-up to work.

- [ ] **Step 2–3:** Run (fail) → implement. Fresh server per request (the protocol is stateless — that is why the SDK calls the factory per request); tools filtered by **this request's** scopes, so a read-only connection never sees a write tool. `scopes = authInfo?.scopes ?? []` — it is optional, never assume. No `outputSchema` in v1 (spec §5). A 4xx/5xx becomes `isError: true`, never a thrown protocol error.

- [ ] **Step 4–5:** Run (pass), commit.

---

### Task 13: The fetch shim and the `mcp` entry

**Files:** `packages/lambda/src/http/fetchAdapter.ts` + test; `packages/lambda/src/entries/mcp.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
it("rebuilds the absolute URL from Host, path and query", () => { /* https://mcp.beta.swng.golf/mcp?a=1 */ });
it("decodes a base64 body", async () => { /* … */ });
it("preserves Mcp-Method and Mcp-Name", () => {
  // The transport rejects a request whose headers disagree with the body (-32020), so a shim
  // that drops headers turns every tool call into a header mismatch.
});
```

- [ ] **Step 2–3:** Run (fail) → implement. `entries/mcp.ts` follows `entries/http.ts`'s cached-promise idiom, builds the app **with the `accountVerifier` seam opened in Task 11 Step 1, fed by the adapter from Task 9** (the fix), gates with `requireBearerAuth({ verifier, resourceMetadataUrl })` + `originValidationResponse`, then calls `handler.fetch(request, { authInfo })`.

- [ ] **Step 4–5:** Gate, commit.

---

### Task 14: The OAuth store

**Files:** `packages/lambda/src/oauth/store.ts` + test.

**Interfaces:** `putClient`/`getClient` (90d), `putRequest`/`takeRequest` (10m, single-use), `putCode`/`takeCode` (60s, single-use), `putHandle`/`getHandle`/`retireHandle` (30d, 30s grace).

- [ ] **Step 1: Write the failing tests** — code single-use; request single-use; a retired handle readable inside its grace window and gone after; **and an expired item not returned even though it is still physically present**:

```ts
it("refuses an expired code even when the item still exists", async () => {
  await store.putCode("c1", grant);   // 60s
  clock.advance(61_000);
  await expect(store.takeCode("c1")).resolves.toBeUndefined();
});
```

DynamoDB TTL deletes "typically within 48 hours" — it is **cleanup, not expiry**. A 60-second code whose only expiry is `ttl` stays redeemable for hours. Every read compares an explicit `expiresAtMs`.

- [ ] **Step 2–4:** Decide the home first — if `packages/adapters-dynamodb`'s tests run against DynamoDB Local (`pnpm test:contract`), it belongs there and matches that idiom. Then implement: one table keyed `pk` with typed prefixes, a numeric `ttl` for cleanup **and** an `expiresAtMs` the code reads; single-use reads are a conditional delete returning the old item.

- [ ] **Step 5:** Commit.

---

### Task 15: The metadata documents

**Files:** `packages/lambda/src/oauth/metadata.ts` + test.

- [ ] **Step 1: Write the failing tests**

```ts
it("advertises S256 PKCE — clients MUST refuse to proceed without it", () => { /* ["S256"] */ });
it("advertises both flags Claude needs before choosing CIMD over DCR", () => {
  expect(m.client_id_metadata_document_supported).toBe(true);
  expect(m.token_endpoint_auth_methods_supported).toContain("none");
});
it("advertises RFC 9207 issuer identification", () => { /* … */ });
it("names the canonical resource exactly, path included", () => { /* https://mcp.beta.swng.golf/mcp */ });
it("advertises the read scope only — write is granted at the consent page, not by step-up", () => { /* … */ });
it("does NOT advertise offline_access", () => { /* … */ });
```

- [ ] **Step 2–5:** Run (fail) → implement, typed against the SDK's `OAuthMetadata`/`OAuthProtectedResourceMetadata` with **`import type` only** so no SDK runtime enters this bundle → run (pass) → commit.

---

### Task 16: Client registration — CIMD and the DCR fallback

**Files:** `packages/lambda/src/oauth/clients.ts` + test.

- [ ] **Step 1: Write the failing tests** — CIMD: reject a document whose `client_id` ≠ its URL; refuse non-https; refuse a fetch into private address space; refuse a cross-host redirect. `redirectUriAllowed`: loopback matches **port-agnostically** (RFC 8252 §7.3 — Claude Code binds an ephemeral port) but **path and host are never relaxed**; non-loopback needs exact match.

- [ ] **Step 2–5:** Run (fail) → implement (https only; refuse loopback/link-local/RFC 1918; 64 KB cap; 5 s timeout; cache per response headers; `/register` parses **JSON**, unlike `/token`'s form encoding; 90-day TTL) → run (pass) → commit.

---

### Task 17: `/authorize`, the Cognito callback, and consent

**Files:** `packages/lambda/src/oauth/authorize.ts` + test.

- [ ] **Step 1: Write the failing tests**

```ts
it("redirects to Cognito with the canonical resource bound and S256 PKCE", async () => { /* … */ });
it("rejects an unregistered redirect_uri WITHOUT redirecting to it", async () => { /* 400, no location */ });
it("refuses a scope the resource server does not own", async () => {
  // Cognito fails the WHOLE authorization with invalid_request when a custom scope belongs to a
  // different resource (measured, spec F5) — reject it here, legibly.
});
it("issues NO code until consent is granted", async () => {
  // Falsifiable: assert the callback renders consent and that the store holds zero codes.
  expect(res.headers.get("location")).toBeNull();
  expect(await deps.store.debugCodeCount()).toBe(0);
});
it("shows the client name and the redirect URI hostname", async () => { /* MUST, spec §4.3 */ });
it("grants only read when the golfer picks read-only", async () => { /* code carries [read] */ });
it("returns iss on the redirect, per RFC 9207", async () => { /* … */ });
```

- [ ] **Step 2–5:** Run (fail) → implement → run (pass) → commit. Order is load-bearing: `/authorize` validates and stores; the callback exchanges Cognito's code **immediately** (five-minute expiry) and holds the tokens under a short TTL; consent renders; the client's code is minted **after** consent with the scopes actually approved. The consent page is server-rendered HTML — no SPA route, no client-side JS — showing the client name, the redirect hostname, read-only / read-and-write, and a warning when every registered redirect URI is loopback.

---

### Task 18: `/token`

**Files:** `packages/lambda/src/oauth/token.ts` + test.

- [ ] **Step 1: Write the failing tests** — code grant: PKCE mismatch → `invalid_grant`; replay → `invalid_grant`; success returns the Cognito access token and an **opaque** refresh handle; a JSON content-type is refused. Refresh: the handle rotates; the retired handle works **inside** the 30-second grace window and fails after it (Claude refreshes proactively up to five minutes early, so two in-flight requests race, and rotating without a grace window locks the golfer out). Inject the clock.

Every failure answers `invalid_grant` — never `invalid_request`, never a custom code.

- [ ] **Step 2–5:** Run (fail) → implement → run (pass) → commit.

---

### Task 19: The `mcpAuth` entry

**Files:** `packages/lambda/src/entries/mcpAuth.ts` + test.

- [ ] **Step 1–3:** Failing routing test (six paths reach their handlers; unknown → 404; PRM served at **both** `/.well-known/oauth-protected-resource` and `…/oauth-protected-resource/mcp`, because clients probe the suffixed form first) → implement as a path switch over `new URL(request.url).pathname` sharing one lazily-built dependency promise.

- [ ] **Step 4: Verify the SDK is absent from the deployed bundle — after Task 18**

`pnpm build` runs `tsc`, not a bundler, and elides type-only imports anyway, so grepping `dist/` proves nothing. The artifact that matters is the esbuild bundle CDK produces:

**The obvious version of this check reports "clean" unconditionally, twice over** — measured: `pnpm -F` runs synth inside `apps/infra-cdk`, so the output is at `apps/infra-cdk/cdk.out`, not the repo root; and CDK names asset directories `asset.<sha256>`, so no path contains "mcpauth". Both make the glob empty, `2>/dev/null` eats the error, and `||` fires the success message.

Map the asset hash to the function through the synthesized template instead:

```bash
cd apps/infra-cdk && npx cdk synth swng-beta >/dev/null
node -e '
  const t = require("./cdk.out/swng-beta.template.json");
  const [id, r] = Object.entries(t.Resources).find(([i, x]) =>
    x.Type === "AWS::Lambda::Function" && /mcpAuth/i.test(i));
  // Properties.Code is an S3 placeholder, not a path. The on-disk directory is
  // cdk.out/asset.<hash>, and the hash is Metadata["aws:asset:path"] (or S3Key minus ".zip").
  console.log(id, r.Metadata?.["aws:asset:path"] ?? r.Properties.Code.S3Key);
'
```

Then grep **that** asset directory for `modelcontextprotocol`. If the leak is there, a type-only import became a value import.

**Defer this step until Task 20 (CDK) exists; Task 20 Step 6 sends you back here.**

- [ ] **Step 5:** Commit.

---

### Task 20: CDK — the MCP API and the drift guard

**Files:** modify `apps/infra-cdk/lib/swngStack.ts`, `bin/infra-cdk.ts`; create `apps/infra-cdk/test/mcpCanonical.test.ts`.

- [ ] **Step 1: Write the failing drift guard**

A test asserting `CANONICAL === CANONICAL` cannot fail — every use derives from one constant. This one reads the **synthesized template**, bridging places a stack edit can drift apart. Use `Match.anyValue()`: `Match.objectLike` wraps non-`Matcher` values in a `LiteralMatch` and deep-compares, so `expect.anything()` yields `failCount 1` on a template that matches otherwise (measured).

```ts
it("the Cognito resource server identifier IS the MCP endpoint URL", () => {
  // Measured, spec F2: a `resource` that doesn't name a registered resource server yields an
  // authorization code that cannot be redeemed — and the token endpoint reports an ordinary
  // invalid_grant, pointing nowhere near this mismatch.
  template.hasResourceProperties("AWS::Cognito::UserPoolResourceServer", {
    Identifier: "https://mcp.beta.swng.golf/mcp",
    Scopes: Match.arrayWith([Match.objectLike({ ScopeName: "read", ScopeDescription: Match.anyValue() })]),
  });
});
it("the mcp function is told the same string", () => { /* MCP_CANONICAL */ });
it("the custom domain serves that host and POST /mcp is a real route", () => { /* … */ });
it("the mcp app client has its own managed login branding", () => {
  // Measured, spec F6: without one the sign-in page renders "Login pages unavailable" and no
  // form — a symptom naming nothing that leads to the cause.
  template.resourceCountIs("AWS::Cognito::ManagedLoginBranding", 2);
});
```

- [ ] **Step 2–3:** Run (fail) → add the stack block, all gated on `props.mcp`, following `props.web`'s shape: `HttpApi` `McpApi` with `corsPreflight` (any origin, `allowHeaders: ["*"]` — `Mcp-Param-*` headers are dynamic and cannot be enumerated); certificate + domain + mapping + Route 53; `NodejsFunction`s `mcp` and `mcpAuth` with `MCP_CANONICAL`; the `mcp-oauth-<stage>` table; `CfnUserPoolResourceServer` with `Identifier: canonical`; the `swng-mcp-<stage>` app client (confidential, code flow, custom scopes) **plus its own `CfnManagedLoginBranding`**; explicit routes; throttle and alarms. Add `mcp` to **beta's** `STAGE_CONFIG` only.

- [ ] **Step 4:** `pnpm -F @swng/infra-cdk test` — the existing prop-less template test must still pass; that is what proves the MCP block is fully gated.
- [ ] **Step 5:** `pnpm cdk:diff`, read every line. Additions only, plus Task 6's route.
- [ ] **Step 6:** Return to Task 19 Step 4 (the `mcpAuth` bundle check) and run it now that CDK assets exist.
- [ ] **Step 7:** Commit.

---

### Task 21: The Playwright beta gate

Resource binding is managed-login-only, so `e2e:beta`'s `InitiateAuth` shortcut **cannot** mint an MCP token.

**Files:** `apps/web/e2e/mcpConnector.spec.ts`; modify `apps/web/e2e/support.ts`.

- [ ] **Step 1: Write the gate**

1. Register a client (CIMD document from a local static server, or `POST /register`).
2. **`POST`** to `https://mcp.beta.swng.golf/mcp` with no token → **401** with `WWW-Authenticate: Bearer resource_metadata="…"`. POST, not GET: only `POST /mcp` is routed, so GET returns 404 — and even routed, `legacy: 'stateless'` answers GET with 405.
3. PRM at the advertised URL → `resource` equals the canonical URI exactly.
4. AS metadata → `code_challenge_methods_supported: ["S256"]`.
5. Drive `/authorize` in the browser: managed login as a `support.ts` user, consent, choose **read and write**, capture the code from the loopback redirect.
6. `POST /token` → decode: `aud` is canonical, `scope` carries both.
7. `tools/list` → `record_score` present.
8. `tools/call get_round` against a **finalized** round — deliberately the case a round-scoped token could never have served.
9. Refresh → `aud` survived (spec F4), handle rotated.

- [ ] **Step 2:** Run three times. A flake here is a real cold-start or race problem given Claude's 10-second budget.
- [ ] **Step 3:** Commit.

---

### Task 22: Deploy beta and close the arc

- [ ] **Step 1:** `pnpm validate`
- [ ] **Step 2:** `pnpm cdk:diff`, read it, then `pnpm deploy:beta`. The web publishes separately and is **not** part of this arc — do not run `publish:web:beta` out of habit.
- [ ] **Step 3:** `pnpm e2e:beta` **and** the Playwright gate.
- [ ] **Step 4:** Add `https://mcp.beta.swng.golf/mcp` as a custom connector in Claude and walk it by hand: consent reads correctly, a read-only grant hides the write tools, "how did I play this year?" returns real rounds, "put me down for a 5 on 7" lands, "we played the back nine" corrects the hole selection. A green pipeline verifies this plan's assumptions, not the product.
- [ ] **Step 5:** Invoke `closing-an-arc`; add the arc-log entry linking this plan and the spec.

---

## Self-Review

**Does Phase 1 pass its own test?** Each task, with MCP cancelled:

| Task | Still worth doing? |
|---|---|
| 1 — fold moves down, one shared banlist | Yes, but only the **banlist addition** carries the argument. Extracting the list into a constant with one reference fixes nothing on its own; it earns its place by being applied in Task 10, and it is bundled here because the fold's new exports are what expose the hole. |
| 2 — `describeGame` → `present.ts` | Yes. Half the game vocabulary is already there; this ends a split home. |
| 3 — round designation → domain | Yes. "How a round is named" is a product-wide rule living in one app. |
| 4 — readiness prose moves, strokes line splits | Yes. Same split-home argument, plus it stops `strokesSummary` from smuggling allocation into a module whose contract forbids it. |
| 5 — dispatcher decoupled | Yes. It makes `dispatch.ts` testable without constructing API Gateway events. |
| 6 — live game state on the wire | Yes. The product's live scoring shape has never been serializable; nothing outside a browser can read a round in progress. |
| 7 — `GET /view` | Yes. "Everything behind the API" is not true of the product's most important read. |
| 8 — HLC minting → domain | Yes, and it is the weakest of the seven. The generator and the comparator it feeds live in different packages, and only a browser can reach the generator. MCP is what exposed it; say so in review rather than overclaiming. |

**Spec coverage.** §1.1 → Phase 1 entire (Tasks 1–8). §2 → Tasks 12, 13. §3.1 → Tasks 5, 11. §3.2 → Task 11. §3.4 → Task 19. §4.2 F2 → Task 20; F3/F5 → Task 17; F4 → Task 21; F6 → Task 20. §4.3 → Tasks 15–18. §4.4 → Tasks 12, 15, 17. §5 → Tasks 10, 11. §5.1 → Tasks 1, 4, 6, 7. §5.2 → Tasks 1, **10 (Step 0 — the fence is applied there, not inherited)**. §6 → Task 20. §7 → Tasks 13, 20. §8 → Tasks 9–11, 20, 21.

**Deliberately unresolved:**

- **Task 14's home** — `packages/lambda/src/oauth/` or `packages/adapters-dynamodb`. Decide from that package's test idiom at the start of the task.
- **Task 4's two renames** (`unresolvedGames` → `describeUnresolvedGames`; `nameOf` → `nameOfInRound`/`nameOfParticipant`) are behaviour-preserving renames inside move commits. Called out in their own steps so a reviewer sees them.
- **No runtime step-up** (Task 12). A read-only golfer reconnects to gain write. Recorded in spec §4.4 as the intended v1 behaviour.
- **`share_round` and `finalize_round` cannot act on a finalized round** — the existing product's behaviour reaching MCP unchanged. Say so in the tool descriptions.

**Where this plan has been wrong before.** Four adversarial reviews, in order, found: an unfalsifiable CDK test and a verifier the SDK would reject; a silently-widening fence and a `round-final` mint that breaks the flagship read; a response shape that could not carry a live round at all; and a flagship write whose composed schema asks a language model to author a hybrid logical clock, plus a falsification step that cannot run because `vitest run` does not typecheck.

Every round also found **false rows in the fact table** — including the row describing the safety net that is supposed to make Phase 1 safe. **Spot-check the table against the files.** "Verified" means someone read it once; it does not mean it is true now, and it has not been true every time.
