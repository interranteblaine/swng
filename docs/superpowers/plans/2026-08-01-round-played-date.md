# A round has one date: when you played it — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A round records when it was *played* — set by the golfer, correctable while live — and that is the only date the product shows, groups, or sorts by.

**Architecture:** One required field on `round-created`, one narrow correction event, and ONE domain function that reads a log and answers "when was this played." Every product surface that reads `createdAtMs` or `finalizedAtMs` for a *date* moves onto it. `createdAt`/`finalizedAt` stay as audit facts, rendered nowhere. No tolerate arm: every stored round is migrated.

**Tech Stack:** TypeScript (nodenext ESM), Zod, Vitest, React 19 + Tailwind 4, AWS CDK, DynamoDB.

**Spec:** `docs/superpowers/specs/2026-08-01-round-played-date-design.md` — read §3 (the model) and §8 (migration order) before starting.

## Global Constraints

- **`playedAtMs` is REQUIRED on `round-created`.** There is no fallback arm, no `??`, no `.optional()`, no `.default()` anywhere in the derivation. A round whose genesis lacks it is invalid data, and the migration (Task 8) is what makes that true. If you find yourself adding a fallback, stop — that is the exact thing this spec rejected.
- **ONE function decides a round's played instant.** `playedAtMsOf(events)` in `packages/domain/src/round/playedAt.ts`. The fold calls it and the projector calls it. A second implementation anywhere is a defect.
- **Bounds live on request schemas ONLY**, never on the stored event arm or any fold/read path (pre-prod hardening Arc A's placement rule: a bound on a stored path rejects already-stored data on a read).
- **`apps/web/src` may not import golf compute from `@swng/domain`** — the ESLint fence. `playedAtMsOf` reaches the web through `@swng/client` only.
- **`createdAt` / `finalizedAt` are not deleted and not renamed.** They stay exactly as they are on the line and the wire. They simply stop being read for any date the product renders, groups, or sorts by.
- Field naming: `playedAtMs` on domain/store/event shapes (the repo's `...Ms` convention for instants); `playedAt` on the wire (matching `createdAt`/`finalizedAt`).
- `pnpm validate` must be green at every commit.

---

### Task 1: The domain rule

**Files:**
- Create: `packages/domain/src/round/playedAt.ts`
- Create: `packages/domain/src/round/playedAt.test.ts`
- Modify: `packages/domain/src/round/events.ts` (the `round-created` arm; a new `round-played-at-set` arm)
- Modify: `packages/domain/src/round/state.ts` (`RoundState`, `reduceRound`)
- Modify: `packages/domain/src/index.ts` (export `playedAtMsOf`)
- Test: `packages/domain/src/round/state.test.ts` (add cases)

**Interfaces:**
- Produces: `playedAtMsOf(events: readonly RoundEvent[]): number`; `RoundState.playedAtMs: number`; event arms `round-created { …, playedAtMs: number }` and `round-played-at-set { playedAtMs: number }`.

- [ ] **Step 1: Write the failing test** — `packages/domain/src/round/playedAt.test.ts`

Use the existing test helpers in `state.test.ts` for building events (read that file first and match its construction idiom for `opId`/`hlc`/`authorId`). Cases:

```ts
describe("playedAtMsOf", () => {
  it("returns the genesis event's own playedAtMs when no correction exists", () => { /* one round-created, playedAtMs: 1_000 -> 1_000 */ });

  it("a later round-played-at-set wins", () => { /* genesis 1_000, set 5_000 at a HIGHER hlc -> 5_000 */ });

  it("an hlc-EARLIER set does not win", () => {
    // genesis playedAtMs 1_000; TWO round-played-at-set events, the hlc-later one carrying
    // 5_000 and the hlc-earlier one carrying 9_000, appended in the WRONG array order.
    // -> 5_000. This is the pin that fails if the implementation takes "last in the array"
    // or "largest playedAtMs" instead of "highest hlc".
  });

  it("resolves by hlc, not arrival order", () => { /* same two sets, array order reversed -> same answer */ });

  it("throws on a log with no round-created", () => { /* DomainError, mirroring reduceRound's round-log-missing-genesis */ });
});

describe("reduceRound", () => {
  it("state.playedAtMs equals playedAtMsOf for the same log", () => {
    // Build a log with a genesis AND a correction; assert
    // reduceRound(events).playedAtMs === playedAtMsOf(events).
    // This is the one-rule pin: it fails the moment the fold grows its own copy of the rule.
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm -F @swng/domain exec vitest run src/round/playedAt.test.ts`
Expected: FAIL — `playedAtMsOf` is not exported.

(Note the command form: packages define a `test` script, not a `vitest` one, so `pnpm -F <pkg> vitest run <file>` does not resolve. Use `exec`.)

- [ ] **Step 3: Add the event arms** — `packages/domain/src/round/events.ts`

Change the `round-created` arm to carry the field, and add the correction arm. Keep the existing comment block on `round-created` and append to it:

```ts
    // `playedAtMs` (spec 2026-08-01 §3a) — WHEN THE GOLF HAPPENED, which is not the same fact as
    // when this record was created. The genesis event's own `hlc.wallMs` still records the
    // latter (it is the log's audit trail, untouched); this field is what every product surface
    // reads for a date. REQUIRED, deliberately: a fallback arm would be a permanent read branch
    // existing to serve a handful of enumerable stored rounds, which is the reflex the
    // 2026-07-31 prod-migration spec rejected on proportion. Every stored round is migrated
    // (scripts/migrateRoundPlayedAt.mjs) and the branch never exists.
    | { readonly kind: "round-created"; readonly roundId: RoundId; readonly card: CourseCard; readonly playedAtMs: number }
```

```ts
    // The played date, corrected (spec 2026-08-01 §3b): the participant-strokes-set template
    // minus the subject — a round-level fact, so there is no golferId. Latest-HLC-wins;
    // `authorId` (the envelope) records who changed it. Any participant may set it (the
    // score-for-anyone trust model), enforced at the API layer, not here.
    | { readonly kind: "round-played-at-set"; readonly playedAtMs: number }
```

- [ ] **Step 4: Write `playedAtMsOf`** — `packages/domain/src/round/playedAt.ts`

```ts
import { DomainError } from "../errors.js";
import type { RoundEvent } from "./events.js";
import { byCanonicalOrder } from "./state.js";

// THE one rule for "when was this round played" (spec 2026-08-01 §3c). Two callers, one
// implementation: reduceRound (so the live round page shows and edits it) and the projector (so
// every participant's line is stamped with the same instant). Two copies would let a live round
// and its own archive disagree about what day it was.
//
// Two arms, no fallback: the latest round-played-at-set by HLC, else the genesis event's own
// playedAtMs. A log with no genesis is corrupt — the same stance reduceRound and createdAtMsOf
// already take, never a silent 0.
export const playedAtMsOf = (events: readonly RoundEvent[]): number => {
  const sorted = [...events].sort(byCanonicalOrder);
  let playedAtMs: number | undefined;
  for (const event of sorted) {
    if (event.kind === "round-created") playedAtMs = event.playedAtMs;
    else if (event.kind === "round-played-at-set") playedAtMs = event.playedAtMs;
  }
  if (playedAtMs === undefined) throw new DomainError("round-log-missing-genesis");
  return playedAtMs;
};
```

Note why one ascending scan over `byCanonicalOrder` handles both arms: canonical order is total and HLC-major, so the last write of either kind is the highest-HLC write, and a correction always sorts after the genesis it corrects. Check `DomainError`'s constructor signature in `packages/domain/src/errors.ts` and match how `state.ts` throws `round-log-missing-genesis`.

- [ ] **Step 5: Add it to the fold** — `packages/domain/src/round/state.ts`

Add to `RoundState`, after `card`:

```ts
  // When the golf happened (spec 2026-08-01 §3): the round's ONE date, set at creation and
  // correctable while live. Derived by playedAtMsOf — this fold does not re-implement the rule.
  readonly playedAtMs: number;
```

In `reduceRound`, after the genesis check, set it from the same deduped list the rest of the fold uses:

```ts
  const playedAtMs = playedAtMsOf(deduped);
```

and include `playedAtMs` in the returned state object.

- [ ] **Step 6: Export it** — add `playedAtMsOf` to `packages/domain/src/index.ts` beside the other `round/` exports.

- [ ] **Step 7: Run the tests**

Run: `pnpm -F @swng/domain exec vitest run src/round`
Expected: PASS. Existing `state.test.ts` cases will fail to compile until their event fixtures carry `playedAtMs` on `round-created` — fix every fixture by adding `playedAtMs` equal to that fixture's own genesis `hlc.wallMs`, so no existing assertion's meaning changes.

- [ ] **Step 8: Full typecheck**

Run: `pnpm -F @swng/domain build && pnpm -F @swng/domain test`
Expected: PASS. Other packages will not compile yet; that is Tasks 2–5.

- [ ] **Step 9: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): a round records when it was played"
```

---

### Task 2: The wire

**Files:**
- Modify: `packages/contracts/src/round.ts` (the `round-created` arm of `roundEventSchema`; a new arm; the set-played-at response)
- Modify: `packages/contracts/src/commands.ts` (`startRoundRequestSchema`; a new request schema)
- Test: `packages/contracts/src/round.test.ts`, `packages/contracts/src/commands.test.ts`

**Interfaces:**
- Consumes: Task 1's event arms.
- Produces: `setPlayedAtRequestSchema` / `SetPlayedAtRequest` (`{ playedAtMs: number }`), `setPlayedAtResponseSchema` / `SetPlayedAtResponse` (`{ events: readonly RoundEvent[] }`), `StartRoundRequest.playedAtMs?: number`.

- [ ] **Step 1: Write the failing tests**

In `commands.test.ts`:

```ts
it("accepts a playedAtMs on startRound", () => { /* round-trips */ });
it("rejects a playedAtMs before 2000-01-01", () => { /* 946_684_799_999 -> throws */ });
it("rejects a playedAtMs more than two years ahead", () => { /* throws */ });
it("accepts a startRound with no playedAtMs", () => { /* absent is the "now" case */ });
```

In `round.test.ts`:

```ts
it("rejects a round-created with no playedAtMs", () => {
  // THE no-fallback pin. If this ever passes, the required-ness has been quietly relaxed.
});
it("round-trips a round-played-at-set", () => { /* … */ });
it("accepts a stored round-created whose playedAtMs is outside the request bounds", () => {
  // Arc A's placement rule: the STORED arm carries no bound. A pre-2000 stored value parses.
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm -F @swng/contracts exec vitest run src/round.test.ts src/commands.test.ts`

- [ ] **Step 3: Add the bounds constant and the schemas**

In `commands.ts`, above `startRoundRequestSchema`:

```ts
// Typo protection on a user-typed instant, NOT a product limit (spec 2026-08-01 §6). Request
// schemas only — the stored round-created arm carries no bound at all, because a bound on a
// stored/fold path rejects already-stored data on a read (pre-prod hardening Arc A's placement
// rule). Future dates ARE allowed: setting up Saturday's round on Thursday is the same round
// entered early instead of late.
const MIN_PLAYED_AT_MS = Date.UTC(2000, 0, 1);
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1_000;
export const playedAtInputSchema = z
  .number()
  .int()
  .min(MIN_PLAYED_AT_MS)
  .refine((ms) => ms <= Date.now() + TWO_YEARS_MS, { message: "playedAtMs is too far in the future" });
```

Add `playedAtMs: playedAtInputSchema.optional()` to `startRoundRequestSchema` with a comment naming §3a ("absent means now — exactly today's behaviour").

Add, beside `setStrokesRequestSchema`:

```ts
// POST /rounds/{roundId}/played-at (spec 2026-08-01 §3b): any participant corrects the round's
// played date — a round-level fact, so there is no subject in the body. Server-minted envelope,
// like join/leave/strokes.
export const setPlayedAtRequestSchema = z.object({ playedAtMs: playedAtInputSchema });
export type SetPlayedAtRequest = z.infer<typeof setPlayedAtRequestSchema>;
```

In `round.ts`: add `playedAtMs: z.number().int()` to the `round-created` object (no bound — see above), and add the new arm beside `participant-strokes-set`:

```ts
  z.object({ ...envelope, kind: z.literal("round-played-at-set"), playedAtMs: z.number().int() }),
```

Add `SetPlayedAtResponse` / `setPlayedAtResponseSchema` mirroring `SetStrokesResponse` exactly (`{ events: readonly RoundEvent[] }`).

- [ ] **Step 4: Export from the barrel** — `packages/contracts/src/index.ts`, beside the strokes exports.

- [ ] **Step 5: Run the tests**

Run: `pnpm -F @swng/contracts exec vitest run`
Expected: PASS. Existing fixtures carrying a `round-created` need `playedAtMs` added — same rule as Task 1, use that fixture's own genesis `hlc.wallMs`.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): playedAtMs on round-created, POST /rounds/{id}/played-at"
```

---

### Task 3: Application — stamp it, correct it, project it, sort by it

**Files:**
- Create: `packages/application/src/rounds/setPlayedAt.ts`
- Create: `packages/application/src/rounds/setPlayedAt.test.ts`
- Modify: `packages/application/src/rounds/startRound.ts`
- Modify: `packages/application/src/projections/projectArchive.ts` (`sortLines`, `projectArchive`)
- Modify: `packages/application/src/ports/projectionStore.ts` (line shape)
- Modify: `packages/application/src/golfers/getMyRounds.ts`, `golfers/recordOf.ts` (`toWireLine` ×2)
- Modify: `packages/application/src/golfers/getMyLiveRounds.ts`
- Modify: `packages/application/src/rounds/peekRound.ts`
- Modify: `packages/contracts/src/golfers.ts` (history rows + live rounds gain `playedAt`)
- Modify: `packages/contracts/src/round.ts` (`PeekRoundResponse` gains `playedAt`)
- Modify: `packages/application/src/index.ts`
- Test: the co-located `*.test.ts` for each

**Interfaces:**
- Consumes: `playedAtMsOf` (Task 1), `SetPlayedAtRequest` (Task 2).
- Produces: `setPlayedAt(deps)(claims, request)`; projection line type `GolferRoundLine & { finalizedAtMs: number; playedAtMs: number; createdAtMs?: number }`; wire history rows gain required `playedAt: number`.

- [ ] **Step 1: Write the failing tests**

`setPlayedAt.test.ts` — copy the shape of the existing `setStrokes.test.ts`:

```ts
it("appends a round-played-at-set on a live round", () => { /* … */ });
it("refuses a finalized round with round-not-live", () => { /* … */ });
it("refuses a non-participant", () => { /* … */ });
```

In `projectArchive.test.ts`:

```ts
it("sorts by playedAtMs, not finalizedAtMs", () => {
  // Two lines: A played earlier but finalized LATER; B played later but finalized FIRST.
  // sortLines must return [A, B]. This test FAILS on today's implementation — that is the
  // point; the finalizedAtMs ordering is a latent bug that back-dating makes visible.
});
it("stamps the line's playedAtMs from a log carrying a round-played-at-set", () => { /* … */ });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm -F @swng/application exec vitest run src/rounds/setPlayedAt.test.ts src/projections/projectArchive.test.ts`

- [ ] **Step 3: Stamp it at creation** — `startRound.ts`

In the `round-created` event literal, add `playedAtMs: command.playedAtMs ?? deps.clock.now()`. Add a comment: the absent case is exactly today's behaviour, and the clock read is the same one the HLC source uses.

- [ ] **Step 4: Write the use case** — `setPlayedAt.ts`

Copy `setStrokes.ts` verbatim and adapt: no subject, so ONE `requireParticipant(state, claims.golferId)`; the appended event is `{ kind: "round-played-at-set", playedAtMs: request.playedAtMs, ...serverEnvelope({ hlc, ids: deps.ids }, claims.golferId) }`. Same `round-not-live` gate, same broadcast, same `{ events: result.appended }` return.

- [ ] **Step 5: Move the projector and the sort onto it** — `projectArchive.ts`

```ts
// Ordering is by WHEN THE ROUND WAS PLAYED (spec 2026-08-01 §4), not when it was finalized. The
// old finalizedAtMs ordering only ever looked right because you finalize the round you just
// played; a back-dated round would sort to the top of a history that is supposed to be a
// chronology of golf, not of data entry. roundId stays the tiebreak, unchanged.
export const sortLines = <T extends { readonly playedAtMs: number; readonly roundId: string }>(lines: readonly T[]): T[] =>
  [...lines].sort((a, b) => a.playedAtMs - b.playedAtMs || (a.roundId < b.roundId ? -1 : a.roundId > b.roundId ? 1 : 0));
```

In `projectArchive`, add `const playedAtMs = playedAtMsOf(archive.events);` beside the existing `createdAtMsOf` call (keep that call — `createdAtMs` stays on the line as audit) and include `playedAtMs` in the `putLine` payload.

- [ ] **Step 6: Widen the port and the wire**

`ports/projectionStore.ts`: `putLine` / `listLines` line type gains required `playedAtMs: number`.

`contracts/src/golfers.ts`: the three history-row shapes and their schemas gain required `playedAt: number`. `GetMyLiveRoundsResponse` gains required `playedAt: number` and DROPS `createdAt` — that field was always derived at read time from the genesis event and had no other consumer; keeping both would leave a second date on the one response that never carried an audit fact at all.

Both `toWireLine` implementations (`getMyRounds.ts`, `recordOf.ts`) gain `playedAt: line.playedAtMs` — placed with the other explicit field mappings, never a spread. Leave their existing `...(line.createdAtMs !== undefined ? { createdAt: line.createdAtMs } : {})` lines exactly as they are.

`getMyLiveRounds.ts`: replace its genesis-`hlc.wallMs` derivation with `playedAtMsOf(events)`.

`peekRound.ts` + `PeekRoundResponse`: gains required `playedAt: number`, derived by `playedAtMsOf(events)` — it currently serves `createdAt: genesis.hlc.wallMs`, which `JoinRoundPage` renders through `roundLabel` ("Joining Casa Verde GC · Sat, Jul 12"). **Replace `createdAt` here rather than adding beside it**: unlike a history line, a peek carries no audit surface at all, so a second date on this response would be one nobody reads. A peek is capability-scoped and already discloses the round's day; nothing new leaks.

- [ ] **Step 7: Run the tests**

Run: `pnpm -F @swng/application exec vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/application packages/contracts
git commit -m "feat(application): project and sort a round by when it was played"
```

---

### Task 4: Adapters, route, stack

**Files:**
- Modify: `packages/adapters-dynamodb/src/createDynamoProjectionStore.ts` (the `Line` type)
- Modify: `packages/lambda/src/http/routes.ts` (one route, placed beside `/rounds/{roundId}/strokes`)
- Modify: `packages/lambda/src/http/compositionRoot.ts` (wire `setPlayedAt` into `useCases`)
- Modify: `apps/infra-cdk/lib/swngStack.ts` (`HTTP_ROUTES`)
- Test: `packages/lambda/src/http/dispatch.test.ts`, `apps/infra-cdk/test/swngStack.test.ts`, `packages/adapters-dynamodb/test/*` contract tests

**Interfaces:**
- Consumes: `setPlayedAt` (Task 3), `setPlayedAtRequestSchema` (Task 2).
- Produces: `POST /rounds/{roundId}/played-at`, participant auth, 200.

- [ ] **Step 1: Write the failing tests**

In `dispatch.test.ts`, copy the two `POST /rounds/{roundId}/strokes` cases (there are two — one near line 361, one near 1745) and adapt for `/played-at`.

In `swngStack.test.ts`, add `"POST /rounds/{roundId}/played-at"` to the expected-routes list near line 753 and bump the route count assertion (39 HTTP → 40; check the current number in the file rather than trusting this line).

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm -F @swng/lambda exec vitest run src/http/dispatch.test.ts`

- [ ] **Step 3: Add the route** — `routes.ts`, immediately after the `/rounds/{roundId}/strokes` entry

```ts
  {
    method: "POST",
    path: "/rounds/{roundId}/played-at",
    schema: setPlayedAtRequestSchema,
    auth: "participant", // spec 2026-08-01 §3b: any participant corrects the round's played date.
    successStatus: 200, // an act on an existing round (appends round-played-at-set), not a mint.
    handler: async (ctx, body) => useCases.setPlayedAt(ctx.claims!, body as SetPlayedAtRequest),
  },
```

- [ ] **Step 4: Add it to the stack** — `swngStack.ts` `HTTP_ROUTES`, beside the strokes entry

```ts
  { method: HttpMethod.POST, path: "/rounds/{roundId}/played-at" },
```

**Not in the anonymous throttle set** — it is participant-authed, like `/strokes` and `/leave`.

- [ ] **Step 5: Widen the adapter's `Line` type** — add required `playedAtMs: number`.

- [ ] **Step 6: Run everything**

```
pnpm -F @swng/lambda test && pnpm -F infra-cdk test && pnpm -F @swng/adapters-dynamodb test
```

- [ ] **Step 7: Commit**

```bash
git add packages/adapters-dynamodb packages/lambda apps/infra-cdk
git commit -m "feat(lambda,infra): POST /rounds/{roundId}/played-at"
```

---

### Task 5: Crew seasons window on the played date

**Files:**
- Modify: `packages/domain/src/crew/scoreboard.ts` (`StoredLine`, `playedAtMs`, `inWindow`)
- Modify: `packages/application/src/crews/getSeasonStandings.ts` (the `SharedRoundView` mapping)
- Modify: `packages/contracts/src/crews.ts` (`SharedRoundView`)
- Test: `packages/domain/src/crew/scoreboard.test.ts`, `packages/application/src/crews/getSeasonStandings.test.ts`

**Interfaces:**
- Consumes: `playedAtMs` on the projection line (Task 3).
- Produces: `StoredLine` requiring `playedAtMs`; the `playedAtMs(line)` helper function is DELETED.

- [ ] **Step 1: Write the failing test** — `scoreboard.test.ts`

```ts
it("counts a back-dated round in the season window containing its played date, even after that season's end date has passed", () => {
  // A line played 2026-03-15 but finalized 2026-08-01, against a season window
  // 2026-01-01..2026-06-30 (already FINAL by today's date). It IS in window.
  // This fails today: playedAtMs(line) = createdAtMs ?? finalizedAtMs.
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm -F @swng/domain exec vitest run src/crew/scoreboard.test.ts`

- [ ] **Step 3: Make the change** — `scoreboard.ts`

```ts
export type StoredLine = GolferRoundLine & { readonly finalizedAtMs: number; readonly playedAtMs: number };
```

**Delete the `playedAtMs` helper function entirely** and have `inWindow` read `line.playedAtMs` directly. The `createdAtMs ?? finalizedAtMs` fallback it encoded is exactly the overload this arc removes; leaving a one-line indirection that now just returns a field would preserve the shape of the thing being deleted.

Check every reference (`grep -rn "playedAtMs" packages/`) — the helper's callers must read the field.

- [ ] **Step 4: `SharedRoundView`** — `contracts/src/crews.ts` and `getSeasonStandings.ts`

Add required `playedAt: number` to `SharedRoundView` and its schema, mapped from `line.playedAtMs` in `getSeasonStandings`. Leave `finalizedAt` and `createdAt` on it unchanged — the crew "Played together" list will render from `playedAt` in Task 6, and the other two stay as the audit facts they are.

- [ ] **Step 5: Run the tests**

Run: `pnpm -F @swng/domain test && pnpm -F @swng/application test`

- [ ] **Step 6: Commit**

```bash
git add packages/domain packages/application packages/contracts
git commit -m "feat(crew): a round counts in the season it was played in"
```

---

### Task 6: The read surfaces — every rendered date is the played date

**Files:**
- Modify: `packages/client/src/index.ts` (re-export `playedAtMsOf`)
- Modify: `apps/web/src/roundLabel.ts` + `roundLabel.test.ts` (`RoundDesignation.createdAt` → `playedAt`)
- Modify: `apps/web/src/routes/HomePage.tsx`, `apps/web/src/routes/JoinRoundPage.tsx`, `apps/web/src/crews/SeasonPanel.tsx`, `apps/web/src/golfers/RecordSections.tsx`, `apps/web/src/watch/useWatchRound.ts`, `apps/web/src/watch/WatchPage.tsx`, `apps/web/src/round/RoundRecordPage.tsx`
- Modify: their co-located tests

**Interfaces:**
- Consumes: the wire `playedAt` (Task 3), `SharedRoundView.playedAt` (Task 5).
- Produces: `RoundDesignation { courseName: string; playedAt: number }` — **required**, no longer optional.

- [ ] **Step 1: Write the failing test** — `roundLabel.test.ts`

Rename the existing `createdAt` fixtures to `playedAt` and add:

```ts
it("renders the played day, not the day the record was created", () => {
  // A designation whose playedAt is three days before "now" renders that day.
});
```

Delete the `createdAt === undefined` → bare-course-name branch and its tests. `playedAt` is required now; there is no round without one.

- [ ] **Step 2: Run and confirm it fails**

Run: `pnpm -F @swng/web exec vitest run src/roundLabel.test.ts`

- [ ] **Step 3: Re-export through the client** — `packages/client/src/index.ts`

Re-export `playedAtMsOf` from `@swng/domain` beside the other on-device round-compute re-exports. **`apps/web/src` must import it from `@swng/client`** (the ESLint compute fence); add it to the fence's banlist for direct `@swng/domain` import if the banlist is name-based (read `eslint.config.mjs` — it is).

- [ ] **Step 4: Rename in `roundLabel.ts`**

`RoundDesignation.createdAt?: number` → `playedAt: number` (required). Update `dayOf`/`timeOf`/`roundLabel`/`roundDayKey`/`dayCollisionChecker` and their doc comments. The module doc's explanation of the timezone contract is unchanged and stays. Delete the `if (createdAt === undefined) return courseName` branch and the `roundDayKey` undefined-return branch, and the `RoundDayKey` return type narrows from `string | undefined` to `string` — chase the callers.

- [ ] **Step 5: Point every call site at `playedAt`**

Read each file first. Seven sites, and **two of them are more than a rename**:

- `HomePage.tsx:208` — live rounds and recent rounds both.
- `SeasonPanel.tsx:364` — the "Played together" row (`SharedRoundView.playedAt`, Task 5).
- `JoinRoundPage.tsx:52,75,132` — the peek's date (`PeekRoundResponse.playedAt`, Task 3); the local state variable renames with it.
- `WatchPage.tsx:48,95` — two `roundLabel` calls off `view.createdAt`.
- `RecordSections.tsx:25,69,135,141` — the chart's date anchors: `row?.createdAt ?? row?.finalizedAt` becomes `row.playedAt`. **Also delete `createdAt` from the `history` prop type at :69** — nothing reads it, and a web-local type mirroring a wire field it never touches is the drift this arc exists to remove. Update the comments at :25 and :135, which both name the old preference order.
- `useWatchRound.ts:25,142,144` — **a second implementation of the rule.** `events.find((e) => e.kind === "round-created")?.hlc.wallMs` becomes `playedAtMsOf(events)` from `@swng/client`; the field's type narrows from `number | undefined` to `number`.
- `RoundRecordPage.tsx:20,25,57,73,148` — **the same second implementation again**, as a module-local `createdAtMsOf` helper. **Delete the helper outright** and call `playedAtMsOf(events)` from `@swng/client`; `view.createdAtMs` becomes `view.playedAtMs`, type `number`. Two hand-rolled copies of "read the genesis clock" living in the web is precisely what the one-rule constraint forbids; do not leave either.

- [ ] **Step 6: Grep gate**

Run:
```bash
grep -rn "createdAt" apps/web/src --include="*.tsx" --include="*.ts" | grep -v "\.test\." | grep -v "season"
```
Expected: **no matches.** Nothing in the web renders, groups, or sorts by a round's record-creation instant anymore, and no copy of the genesis-clock derivation survives there.

The `season` exclusion is load-bearing and narrow: `CrewPage.tsx:330` sorts crew SEASONS by `season.createdAtMs`, which is when a season was created and has nothing to do with a round's dates. **That line is correct and must not be touched.** If a match survives the gate, it is a real leak or a surface this plan did not authorize — stop and escalate rather than widening the exclusion.

- [ ] **Step 7: Run the web suite**

Run: `pnpm -F @swng/web test`

- [ ] **Step 8: Commit**

```bash
git add packages/client apps/web
git commit -m "feat(web): every rendered round date is the played date"
```

---

### Task 7: The write surfaces — set it, correct it

**Files:**
- Modify: `apps/web/src/routes/CreateRoundPage.tsx` + its test
- Modify: `apps/web/src/api.ts` + `api.test.ts`
- Modify: `apps/web/src/routes/RoundPage.tsx` (or the setup panel — read the file and place it where the round's own facts already render) + its test

**Interfaces:**
- Consumes: `SetPlayedAtRequest`/`Response` (Task 2), `POST /rounds/{roundId}/played-at` (Task 4).
- Produces: `setPlayedAt(roundId, token, request)` in `api.ts`.

- [ ] **Step 1: Write the failing tests**

`CreateRoundPage.test.tsx`:

```tsx
it("defaults the played-at field to now and submits that instant", () => { /* … */ });
it("submits the instant shown in the field when the golfer back-dates it", () => {
  // Type a datetime-local value three days back; assert createRound was called with the
  // matching playedAtMs. The pin that fails if the component ever infers a time (noon, the
  // entry clock) instead of sending exactly what the field shows.
});
```

`api.test.ts`: mirror the existing `setStrokes` case at ~line 941.

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm -F @swng/web exec vitest run src/routes/CreateRoundPage.test.tsx src/api.test.ts`

- [ ] **Step 3: The api call** — `apps/web/src/api.ts`, beside `setStrokes`

```ts
// POST /rounds/{roundId}/played-at (spec 2026-08-01 §3b): any participant corrects the round's
// played date. Append idiom, like setStrokes — the response carries the one event this call
// appended; the caller sync()s and lets the fold render.
export const setPlayedAt = async (roundId: RoundId, token: string, request: SetPlayedAtRequest): Promise<SetPlayedAtResponse> => {
  const json = await requestJson(`/rounds/${roundId}/played-at`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), token });
  return parse(setPlayedAtResponseSchema, json);
};
```

- [ ] **Step 4: The create form** — `CreateRoundPage.tsx`

Add state: `const [playedAt, setPlayedAt] = useState<string>(() => toDatetimeLocalValue(new Date()));`

Add a helper in the same file (it is presentation, not golf compute — the fence does not apply):

```ts
// A datetime-local input's value is a LOCAL wall-clock string with no zone — "2026-07-31T14:05".
// Both directions go through here so the instant submitted is exactly the one the field shows;
// nothing is inferred (spec §5). Earlier drafts of this design picked local noon, then the entry
// clock, by a hidden rule — the field showing the real value is what makes those unnecessary.
const toDatetimeLocalValue = (date: Date): string => { /* pad month/day/hours/minutes; slice off seconds */ };
```

Render it between the course card and the "Playing as" block:

```tsx
<label className="flex flex-col gap-1">
  <span className="text-sm text-fairway">When did you play?</span>
  <input
    type="datetime-local"
    value={playedAt}
    onChange={(e) => setPlayedAt(e.target.value)}
    className={inputBox}
  />
</label>
```

In `submit`, pass `playedAtMs: new Date(playedAt).getTime()` inside the `createRound` request. Always send it — the field always holds a value, so there is no "absent means now" case on this path (that arm exists on the wire for other clients, not for this form).

Add `playedAt !== ""` and `!Number.isNaN(new Date(playedAt).getTime())` to `canSubmit`.

- [ ] **Step 5: The round-page editor**

Read `RoundPage.tsx` and find where the round's own facts render (the setup panel area, near the join-code panel). Add a line showing the played date with an **Edit** affordance in the roster-strokes-editor idiom — read `SetupPanel.tsx`'s strokes editor and match it exactly:

- Edit swaps the static value for a `datetime-local` input; the static value and the input are mutually exclusive (the strokes editor has a test pinning this — write the equivalent).
- Save is `btnSecondary` (one gold per screen).
- `api.setPlayedAt(...)` then `sync()`. No optimistic write.
- Only rendered while the round is live.

- [ ] **Step 6: Run the web suite**

Run: `pnpm -F @swng/web test`

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): set the played date at creation, correct it while live"
```

---

### Task 8: The migration

**Files:**
- Create: `scripts/roundPlayedAtMigration.mjs` (pure, I/O-free)
- Create: `scripts/roundPlayedAtMigration.test.mjs`
- Create: `scripts/migrateRoundPlayedAt.mjs` (the I/O instrument)
- Create: `scripts/migrateRoundPlayedAt.test.mjs`

**Interfaces:**
- Produces: `transformEvent(item)` / `transformArchive(item)` / `changed(before, after)` — the same pure/IO split as `prodStrokesMigration.mjs` + `migrateProdStrokes.mjs`.

Read both existing scripts in full before starting. This task is a close adaptation of them, and the reasons encoded in their headers (idempotence, the export-before-write rule, no deletion path, the ordering assertion) all still apply.

- [ ] **Step 1: Write the failing tests** — `roundPlayedAtMigration.test.mjs`

```js
it("writes the genesis event's own hlc.wallMs into playedAtMs", () => { /* … */ });
it("is idempotent — a second run changes nothing", () => { /* … */ });
it("leaves an event that already carries playedAtMs untouched, even if it differs from hlc.wallMs", () => {
  // The guard is "the field is absent", never "the field disagrees with the clock" — a
  // deliberately back-dated round must survive a re-run unchanged.
});
it("touches no event kind other than round-created", () => { /* … */ });
it("transforms a snapshot's archived copy of round-created the same way", () => { /* … */ });
```

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm exec vitest run --dir scripts`

- [ ] **Step 3: Write the pure module** — `scripts/roundPlayedAtMigration.mjs`

One rule: on a `round-created` event with no `playedAtMs` key, set `playedAtMs` to that same event's `hlc.wallMs`. Guarded on absence, so idempotent. Lossless by definition — it writes the exact number the (now-deleted) fallback would have computed.

Applies to two shapes: a rounds-table item's `event` attribute, and a snapshot item's `archive.events[]` entry of that kind.

- [ ] **Step 4: Write the I/O instrument** — `scripts/migrateRoundPlayedAt.mjs`

Adapt `migrateProdStrokes.mjs`. Keep every safety property: dry-run by default, `--write` to act, full export of all in-scope tables before any write, parse each transformed record before writing it, `--restore` scoped to the migrated keys only, and **no deletion path anywhere in the file**.

**The ordering assertion inverts.** The strokes migration required `--after-deploy`; this one requires **`--before-deploy`**, and the header must say why:

> The safe order here is migrate → deploy → rebuildProjections (spec §8). `round-created`'s wire schema is not `.strict()`, so the currently-deployed lambda silently strips the new key — migrating first breaks nothing. Deploying first is a real outage: the new lambda REQUIRES `playedAtMs` and every un-migrated round fails to parse. And because the snapshot writes this script performs re-drive the projector stream under the OLD projector — which cannot stamp a field it does not know — `rebuildProjections` after the deploy is what puts `playedAtMs` onto the existing lines. That rebuild is not optional and is not a repair; it is a step.

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run --dir scripts`

- [ ] **Step 6: Commit**

```bash
git add scripts
git commit -m "feat(scripts): the round played-at migration"
```

---

### Task 9: E2E reconciliation

**Files:**
- Modify: `e2e/` and `apps/web/e2e/*.spec.ts` — whatever the sweep below turns up
- Modify: `apps/web/e2e/support.ts` if a shared helper builds a round

- [ ] **Step 1: Sweep for breakage**

```bash
grep -rn "createdAt\|finalizedAt\|round-created\|playedAt" e2e apps/web/e2e
```

Three classes to fix:
1. Any fixture or helper constructing a `round-created` event or a `StartRoundRequest` — the former now needs `playedAtMs`.
2. Any assertion on history ORDER — the sort key changed from finalized to played. For live-scored rounds these coincide, so most will pass unchanged; check each rather than assuming.
3. Any locator matching a rendered date.

- [ ] **Step 2: Add the retroactive-round beat**

In `apps/web/e2e/courseEntry.spec.ts` (or the spec that already drives the create form — read them and pick the one whose story this belongs to), add: create a round dated **three days back** through the real form, score it, finalize, then assert the history row's `playedAt` and the rendered `roundLabel` both name that day. Form → sealed snapshot → projection → screen, in one test.

- [ ] **Step 3: Typecheck**

Run: `pnpm validate`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add e2e apps/web/e2e
git commit -m "test(e2e): a round entered three days late reads as three days late"
```

---

## Close-out (controller-run, after the whole-branch review)

Not a task — the controller executes this. **The order is load-bearing (spec §8), and the
whole-branch review amended it in three places — each amendment is required, not tidiness.**

1. `pnpm validate` (exit 0) + `pnpm test:contract`
2. **Beta migrate:** `--stage beta --dry-run`, read it, then `--write --before-deploy`. Then
   `node scripts/checkProdParses.mjs --stage beta` and require **zero event/archive failures**
   — projection-line failures are the documented expected red below. This gate, not the
   migration's own "Nothing to do" line, is the precondition for deploying: the script's
   decision logic reports on itself, and a self-report is not a check.
3. **Prod migrate:** the same two commands against `--stage prod`.
4. `cdk diff` — expect exactly one new route + lambda code updates, nothing stateful
5. `pnpm deploy:beta`
6. **Beta stragglers:** `--write --straggler-after-deploy`, then a dry run that must report
   **0 pending**. Not optional: `SnapshotStore.page()` parses eagerly, so a single un-migrated
   snapshot **hard-stops `rebuildProjections` at that page** — and fact (b) below makes an
   un-migrated snapshot the expected state after a deploy, not the exception.
7. Invoke `RebuildFunction` on beta **until the cursor is exhausted**
8. `pnpm publish:web:beta` — **after** the rebuild, deliberately. See the fourth expected-red
   below: publishing before it gives every golfer a silent "No rounds yet" for the whole
   window, because `ProfilePage`/`HomePage` swallow the parse failure with `.catch(() => {})`.
   Rebuild-then-publish removes that window at zero cost.
9. `pnpm e2e:beta` ×2, `pnpm e2e:field`

**Four operational facts, so nothing red gets misread as a failure:**

- **Between step 5 and step 6, `checkProdParses.mjs` FAILS on that stage, by design.** Its
  `REQUIRED_LINE_FIELDS` now includes `playedAtMs`, and the projection lines do not carry it
  until the rebuild stamps them. That red *is* the gate working; it means step 6 is pending, not
  that something broke. It must go green after the rebuild — if it doesn't, that is a real
  failure.
- **A round can reappear in the pending list after being migrated, and it is not a failed
  write.** The pre-deploy lambda strips `playedAtMs` when it parses a stored event, and
  `settleRound` builds `archive.events` from those parsed events — so a round finalized by the
  OLD lambda after its genesis was migrated writes a fresh un-migrated snapshot. The remedy is
  the same either way: re-run until a dry run reports zero pending.
- **A round created between the last dry run and the deploy must be migrated after it**, which
  is the one legitimate post-deploy run. It asserts `--straggler-after-deploy` instead of
  `--before-deploy`; the two are refused together. Migrating is never unsafe in either order —
  the flag records which side of the deploy you are on, it does not grant permission.
- **In the deploy→rebuild window the crew board silently reports `rounds: 0` for every
  member.** `inWindow` on a line with no `playedAtMs` is `false`, so the round is dropped
  rather than erroring — proven by execution. Server-side, both bundles, unavoidable. It is
  the one failure in this arc that is silent rather than loud, which is the whole reason step
  8 publishes the web after the rebuild instead of before.

10. **Adversarial USE pass on deployed `beta.swng.golf`.** Two beats, both required:
    (a) enter a real paper round dated several days back, finalize it, and confirm it reads as
    that day everywhere — home, profile history, the crew board's season; and
    (b) **correct a live round's date through the round-page editor** and confirm the change
    lands. Beat (b) is not optional: the mid-round correction is half the shipped feature
    (spec §3b) and the whole-branch review found it had no automated coverage at any level, so
    a human driving it is the only gate it has ever had.
11. **Prod, and only after beta is green.** A **fresh** `--stage prod --dry-run` immediately
    before deploying — steps 4–10 can span days, prod is live at `swng.golf` with real
    golfers, and any prod round created in that window goes unreadable the instant prod
    deploys. Then `deploy:prod` → `--write --straggler-after-deploy` + a 0-pending dry run →
    prod `RebuildFunction` **until the cursor is exhausted** → `publish:web:prod` → a browser
    walk on `swng.golf` confirming the existing rounds still read with their original dates
    (the migration is lossless; this is the proof).
