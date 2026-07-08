# M1 — Round Log & Scoring Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The event-sourced round and the games engine skeleton in pure `@swng/domain`, proven on the two formats that exercise handicaps hardest: stroke play (gross/net) and singles match play — with golden-card decks and convergence properties green.

**Architecture:** `docs/architecture.md` §1–2. The round is an append-only event log; every projection of it (`RoundState`, every `GameState`) is a pure fold. Conflict resolution is per-cell last-writer-wins by authoring-time HLC (tie-break `deviceId`); the whole reduce is a commutative merge, so any delivery order converges — that claim is property-tested, not assumed.

**Tech stack:** TypeScript strict (ES2022/NodeNext), Vitest 4, fast-check 4 (property tests). Zero runtime dependencies in `@swng/domain` — the lint layer law enforces it.

## Global Constraints

- Work lands directly on `main` (repo convention). `pnpm validate` (lint + **typecheck** + build + test) green at every commit.
- Every commit message ends with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- `@swng/domain` imports nothing: no `@swng/*`, no `node:*`, no AWS (lint-enforced). **Golden fixtures are TS modules**, never `node:fs` reads.
- TDD per task: failing test first, then implementation. Vitest imports are explicit (`import { describe, expect, it } from "vitest"`), tests co-located `*.test.ts`.
- Conventions bind (`docs/engineering-conventions.md`): group by concept (`round/`, `course/`, `scoring/`), one barrel, explicit enums (no `| null` states), comment the why only.
- **Design decisions fixed by this plan** (implementers do not relitigate):
  - Ordering vs. conflict: server `seq` is canonical order (not used inside domain folds); cell conflicts resolve by `compareHlc`, tie-break included. Naive wall clocks appear nowhere.
  - There is no `ScoreCorrected` event type — a correction is a later `ScoreRecorded` to the same cell (LWW). One register-write op.
  - `RoundCreated` must be the first event of a log; a log without it throws `DomainError("round-log-missing-genesis")`. All other unknown/foreign event kinds are ignored (schema tolerance).
  - Lifecycle, participants, and games are themselves LWW registers/maps keyed by hlc — this is what makes the entire fold order-independent.
  - Command-time validity (e.g. "no scoring before the round starts") is the application layer's job (M3); the domain fold is mechanical and tolerant.
  - `scoreGame(config, state)` takes the reduced `RoundState` — games over one log share one reduce. (`scoreGame(config, reduceRound(events))` is the composed form the architecture doc describes; Task 5 reconciles the doc's inline signature.)

---

### Task 1: Core vocabulary — ids, HLC, course card, participants, hole results

**Files:**
- Create: `packages/domain/src/ids.ts`, `packages/domain/src/round/hlc.ts`, `packages/domain/src/course/card.ts`, `packages/domain/src/round/participant.ts`, `packages/domain/src/round/holeResult.ts`, `packages/domain/src/errors.ts`
- Rewrite: `packages/domain/src/index.ts` (real barrel; the bootstrap `packageName` export and its placeholder test die here)
- Test: `packages/domain/src/round/hlc.test.ts`, `packages/domain/src/ids.test.ts`
- Delete: `packages/domain/src/index.test.ts` (placeholder)

**Interfaces (produced — later tasks consume these exact names):**

```ts
// ids.ts
export type Brand<T, B extends string> = T & { readonly [brandSymbol]: B };
export type GolferId = Brand<string, "GolferId">;
export type RoundId = Brand<string, "RoundId">;
export type GameId = Brand<string, "GameId">;
export type OpId = Brand<string, "OpId">;
export type DeviceId = Brand<string, "DeviceId">;
export const golferId: (value: string) => GolferId;   // and roundId, gameId, opId, deviceId
// hlc.ts
export interface Hlc { readonly wallMs: number; readonly counter: number; readonly deviceId: DeviceId; }
export const compareHlc: (a: Hlc, b: Hlc) => number;  // total order: wallMs, counter, deviceId
// course/card.ts
export interface Hole { readonly number: number; readonly par: number; readonly yardage: number; readonly strokeIndex: number; }
export interface TeeSet { readonly name: string; readonly rating: number; readonly slope: number; readonly holes: readonly Hole[]; }
export interface CourseCard { readonly courseName: string; readonly teeSets: readonly TeeSet[]; }
export const findTeeSet: (card: CourseCard, name: string) => TeeSet;  // throws DomainError("unknown-tee-set")
// round/participant.ts
export interface Participant { readonly golferId: GolferId; readonly name: string; readonly tee: string; readonly courseHandicap: number; }
// round/holeResult.ts
export type HoleResult =
  | { readonly kind: "strokes"; readonly strokes: number }
  | { readonly kind: "picked-up" }
  | { readonly kind: "conceded" };
// errors.ts
export class DomainError extends Error { constructor(readonly code: string, message?: string); }
```

- [ ] **Step 1: Write the failing tests**

`packages/domain/src/round/hlc.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deviceId } from "../ids.js";
import { compareHlc, type Hlc } from "./hlc.js";

const hlc = (wallMs: number, counter: number, device: string): Hlc => ({
  wallMs,
  counter,
  deviceId: deviceId(device),
});

describe("compareHlc", () => {
  it("orders by wall time first", () => {
    expect(compareHlc(hlc(1000, 5, "b"), hlc(2000, 0, "a"))).toBeLessThan(0);
  });
  it("breaks wall-time ties by counter", () => {
    expect(compareHlc(hlc(1000, 2, "a"), hlc(1000, 1, "b"))).toBeGreaterThan(0);
  });
  it("breaks counter ties by deviceId so the order is total", () => {
    expect(compareHlc(hlc(1000, 1, "a"), hlc(1000, 1, "b"))).toBeLessThan(0);
    expect(compareHlc(hlc(1000, 1, "a"), hlc(1000, 1, "a"))).toBe(0);
  });
});
```

`packages/domain/src/ids.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { golferId } from "./ids.js";

describe("branded ids", () => {
  it("carries the runtime string through", () => {
    expect(golferId("g-1")).toBe("g-1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @swng/domain test`
Expected: FAIL — cannot resolve `./ids.js` / `./hlc.js`.

- [ ] **Step 3: Implement**

`packages/domain/src/ids.ts`:

```ts
declare const brandSymbol: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brandSymbol]: B };

export type GolferId = Brand<string, "GolferId">;
export type RoundId = Brand<string, "RoundId">;
export type GameId = Brand<string, "GameId">;
export type OpId = Brand<string, "OpId">;
export type DeviceId = Brand<string, "DeviceId">;

export const golferId = (value: string): GolferId => value as GolferId;
export const roundId = (value: string): RoundId => value as RoundId;
export const gameId = (value: string): GameId => value as GameId;
export const opId = (value: string): OpId => value as OpId;
export const deviceId = (value: string): DeviceId => value as DeviceId;
```

`packages/domain/src/errors.ts`:

```ts
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "DomainError";
  }
}
```

`packages/domain/src/round/hlc.ts`:

```ts
import type { DeviceId } from "../ids.js";

// Hybrid logical clock: authoring-time causality for conflict resolution.
// deviceId in the tie-break makes the order total, so LWW merges are deterministic.
export interface Hlc {
  readonly wallMs: number;
  readonly counter: number;
  readonly deviceId: DeviceId;
}

export const compareHlc = (a: Hlc, b: Hlc): number => {
  if (a.wallMs !== b.wallMs) return a.wallMs - b.wallMs;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0;
};
```

`packages/domain/src/course/card.ts`:

```ts
import { DomainError } from "../errors.js";

export interface Hole {
  readonly number: number;      // 1-based position in play order
  readonly par: number;
  readonly yardage: number;
  readonly strokeIndex: number; // 1 = hardest; a permutation of 1..N within a tee set
}

export interface TeeSet {
  readonly name: string;
  readonly rating: number;
  readonly slope: number;
  readonly holes: readonly Hole[]; // 9 or 18, in play order
}

export interface CourseCard {
  readonly courseName: string;
  readonly teeSets: readonly TeeSet[];
}

export const findTeeSet = (card: CourseCard, name: string): TeeSet => {
  const tee = card.teeSets.find((t) => t.name === name);
  if (!tee) throw new DomainError("unknown-tee-set", `no tee set named "${name}"`);
  return tee;
};
```

`packages/domain/src/round/participant.ts`:

```ts
import type { GolferId } from "../ids.js";

export interface Participant {
  readonly golferId: GolferId;
  readonly name: string;
  readonly tee: string;            // TeeSet name within the round's frozen CourseCard
  readonly courseHandicap: number; // frozen at join; negative = plus handicap
}
```

`packages/domain/src/round/holeResult.ts`:

```ts
// "picked-up" and "conceded" are first-class scores, not errors (product.md §4).
// Each game format decides what they mean; the cell just records the truth.
export type HoleResult =
  | { readonly kind: "strokes"; readonly strokes: number }
  | { readonly kind: "picked-up" }
  | { readonly kind: "conceded" };
```

`packages/domain/src/index.ts`:

```ts
export * from "./ids.js";
export * from "./errors.js";
export * from "./course/card.js";
export * from "./round/hlc.js";
export * from "./round/participant.js";
export * from "./round/holeResult.js";
```

Delete `packages/domain/src/index.test.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @swng/domain test` → PASS. Then `pnpm validate` → green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(domain): core vocabulary — branded ids, HLC total order, course card, participants, hole results

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Round events and the commutative fold

**Files:**
- Create: `packages/domain/src/round/events.ts`, `packages/domain/src/round/state.ts`
- Modify: `packages/domain/src/index.ts` (add exports), `pnpm-workspace.yaml` (catalog + fast-check), `packages/domain/package.json` (devDep fast-check)
- Test: `packages/domain/src/round/state.test.ts`, `packages/domain/src/round/state.properties.test.ts`

**Interfaces:**
- Consumes (Task 1): `GolferId`, `RoundId`, `GameId`, `OpId`, `Hlc`, `compareHlc`, `CourseCard`, `Participant`, `HoleResult`, `DomainError`.
- Produces:

```ts
// events.ts
export interface RoundEventBase { readonly opId: OpId; readonly hlc: Hlc; readonly authorId: GolferId; readonly seq?: number; }
export type RoundEvent = RoundEventBase & (
  | { readonly kind: "round-created"; readonly roundId: RoundId; readonly card: CourseCard }
  | { readonly kind: "participant-joined"; readonly participant: Participant }
  | { readonly kind: "game-added"; readonly config: GameConfig }        // GameConfig imported type-only; defined in Task 4
  | { readonly kind: "round-started" }
  | { readonly kind: "score-recorded"; readonly golferId: GolferId; readonly hole: number; readonly result: HoleResult }
  | { readonly kind: "round-finalized" }
  | { readonly kind: "round-reopened" }
);
// state.ts
export type RoundStatus = "setup" | "live" | "final";
export interface ScoreCell { readonly result: HoleResult; readonly recordedBy: GolferId; readonly hlc: Hlc; readonly opId: OpId; }
export interface RoundState {
  readonly id: RoundId; readonly status: RoundStatus; readonly card: CourseCard;
  readonly participants: readonly Participant[]; readonly games: readonly GameConfig[];
  readonly cells: Readonly<Record<string, ScoreCell>>;   // key: cellKey(golferId, hole)
}
export const cellKey: (golfer: GolferId, hole: number) => string;   // `${golfer}#${hole}`
export const reduceRound: (events: readonly RoundEvent[]) => RoundState;
```

NOTE on Task 4 dependency: until Task 4 exists, declare a placeholder `export type GameConfig = { readonly kind: string; readonly id: GameId }` in `events.ts` and re-point it to `../scoring/game.js` in Task 4 (one-line change there). The fold only keys games by `id` and never inspects format internals, so the swap is type-only.

**Fold semantics (fixed):** everything is an hlc-resolved LWW merge, so the fold is commutative and idempotent:
- `round-created` is genesis: must be present; its `card`/`roundId` are immutable. No `round-created` in the log → `DomainError("round-log-missing-genesis")`. More than one → highest-hlc wins (degenerate but deterministic).
- Status is an LWW register over lifecycle events (`round-created`→setup, `round-started`→live, `round-finalized`→final, `round-reopened`→live): the lifecycle event with the highest hlc determines status.
- `participants` and `games` are LWW maps keyed by `golferId`/`config.id` (a re-join with a corrected tee is a later write that wins).
- Cells: apply a `score-recorded` iff no cell exists or `compareHlc(event.hlc, cell.hlc) > 0`.
- Duplicate `opId` (verbatim retry) → ignored after first application.
- Unknown `kind` (future schema) → skipped silently. Events are processed regardless of current status — command-time validity is M3's job.

- [ ] **Step 1: Add fast-check to the catalog and domain**

`pnpm-workspace.yaml` — add to the existing `catalog:` block: `fast-check: ^4.0.0`.
`packages/domain/package.json` devDependencies — add `"fast-check": "catalog:"`.
Run `pnpm install`.

- [ ] **Step 2: Write the failing behavior tests**

`packages/domain/src/round/state.test.ts` — complete file:

```ts
import { describe, expect, it } from "vitest";
import { deviceId, gameId, golferId, opId, roundId } from "../ids.js";
import type { CourseCard } from "../course/card.js";
import type { Hlc } from "./hlc.js";
import type { RoundEvent } from "./events.js";
import { cellKey, reduceRound } from "./state.js";

const card: CourseCard = {
  courseName: "Fixture Links",
  teeSets: [{ name: "white", rating: 35.8, slope: 128, holes: [
    { number: 1, par: 4, yardage: 380, strokeIndex: 5 },
    { number: 2, par: 4, yardage: 410, strokeIndex: 1 },
    { number: 3, par: 3, yardage: 165, strokeIndex: 9 },
  ] }],
};
const A = golferId("a");
const B = golferId("b");
const at = (wallMs: number, device = "d1", counter = 0): Hlc => ({ wallMs, counter, deviceId: deviceId(device) });
let op = 0;
const base = (wallMs: number, device?: string) => ({ opId: opId(`op-${op++}`), hlc: at(wallMs, device), authorId: A });

const genesis: RoundEvent = { ...base(1), kind: "round-created", roundId: roundId("r1"), card };
const joinA: RoundEvent = { ...base(2), kind: "participant-joined", participant: { golferId: A, name: "Ann", tee: "white", courseHandicap: 8 } };
const started: RoundEvent = { ...base(3), kind: "round-started" };

describe("reduceRound", () => {
  it("throws on a log without genesis", () => {
    expect(() => reduceRound([joinA])).toThrowError(/round-log-missing-genesis/);
  });

  it("walks the lifecycle: setup → live → final → live again on reopen", () => {
    expect(reduceRound([genesis]).status).toBe("setup");
    expect(reduceRound([genesis, started]).status).toBe("live");
    const final: RoundEvent = { ...base(4), kind: "round-finalized" };
    const reopened: RoundEvent = { ...base(5), kind: "round-reopened" };
    expect(reduceRound([genesis, started, final]).status).toBe("final");
    expect(reduceRound([genesis, started, final, reopened]).status).toBe("live");
  });

  it("resolves same-cell conflicts by hlc, not arrival order", () => {
    const early: RoundEvent = { ...base(10, "offline-phone"), kind: "score-recorded", golferId: A, hole: 1, result: { kind: "strokes", strokes: 6 } };
    const correction: RoundEvent = { ...base(20, "online-phone"), kind: "score-recorded", golferId: A, hole: 1, result: { kind: "strokes", strokes: 5 } };
    // The stale offline write ARRIVES LAST — the correction must still win.
    const state = reduceRound([genesis, joinA, started, correction, early]);
    expect(state.cells[cellKey(A, 1)]?.result).toEqual({ kind: "strokes", strokes: 5 });
  });

  it("ignores a verbatim duplicate (same opId)", () => {
    const score: RoundEvent = { ...base(10), kind: "score-recorded", golferId: A, hole: 2, result: { kind: "strokes", strokes: 4 } };
    const once = reduceRound([genesis, joinA, started, score]);
    const twice = reduceRound([genesis, joinA, started, score, score]);
    expect(twice).toEqual(once);
  });

  it("treats a participant re-join as a correcting write (tee fix wins by hlc)", () => {
    const fixedTee: RoundEvent = { ...base(9), kind: "participant-joined", participant: { golferId: A, name: "Ann", tee: "white", courseHandicap: 9 } };
    const state = reduceRound([genesis, joinA, fixedTee]);
    expect(state.participants).toHaveLength(1);
    expect(state.participants[0]?.courseHandicap).toBe(9);
  });

  it("skips unknown event kinds (schema tolerance)", () => {
    const alien = { ...base(50), kind: "press-opened", gameId: gameId("g9") } as unknown as RoundEvent;
    expect(reduceRound([genesis, joinA, alien]).participants).toHaveLength(1);
  });

  it("records picked-up and conceded as first-class results", () => {
    const pu: RoundEvent = { ...base(11), kind: "score-recorded", golferId: A, hole: 1, result: { kind: "picked-up" } };
    const cc: RoundEvent = { ...base(12), kind: "score-recorded", golferId: B, hole: 1, result: { kind: "conceded" } };
    const state = reduceRound([genesis, joinA, started, pu, cc]);
    expect(state.cells[cellKey(A, 1)]?.result.kind).toBe("picked-up");
    expect(state.cells[cellKey(B, 1)]?.result.kind).toBe("conceded");
  });
});
```

`packages/domain/src/round/state.properties.test.ts` — complete file:

```ts
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { deviceId, golferId, opId, roundId } from "../ids.js";
import type { CourseCard } from "../course/card.js";
import type { RoundEvent } from "./events.js";
import { reduceRound } from "./state.js";

const card: CourseCard = {
  courseName: "Fixture Links",
  teeSets: [{ name: "white", rating: 35.8, slope: 128, holes: [
    { number: 1, par: 4, yardage: 380, strokeIndex: 2 },
    { number: 2, par: 4, yardage: 410, strokeIndex: 1 },
    { number: 3, par: 3, yardage: 165, strokeIndex: 3 },
  ] }],
};
const golfers = [golferId("a"), golferId("b")];

const genesis: RoundEvent = {
  kind: "round-created", roundId: roundId("r1"), card,
  opId: opId("genesis"), hlc: { wallMs: 0, counter: 0, deviceId: deviceId("d0") }, authorId: golfers[0]!,
};

const scoreEvent = fc
  .record({
    golfer: fc.constantFrom(...golfers),
    hole: fc.integer({ min: 1, max: 3 }),
    strokes: fc.integer({ min: 1, max: 10 }),
    wallMs: fc.integer({ min: 1, max: 1_000 }),
    counter: fc.integer({ min: 0, max: 3 }),
    device: fc.constantFrom("d1", "d2", "d3"),
    op: fc.integer({ min: 0, max: 500 }),
  })
  .map(({ golfer, hole, strokes, wallMs, counter, device, op }): RoundEvent => ({
    kind: "score-recorded", golferId: golfer, hole,
    result: { kind: "strokes", strokes },
    opId: opId(`op-${op}`), hlc: { wallMs, counter, deviceId: deviceId(device) }, authorId: golfer,
  }));

describe("reduceRound convergence", () => {
  it("is order-independent: any shuffle of the same events folds to the same state", () => {
    fc.assert(
      fc.property(fc.array(scoreEvent, { maxLength: 40 }), fc.infiniteStream(fc.nat()), (events, seeds) => {
        const log = [genesis, ...events];
        const shuffled = [...log]
          .map((e) => ({ e, k: seeds.next().value ?? 0 }))
          .sort((x, y) => x.k - y.k)
          .map(({ e }) => e);
        expect(reduceRound(shuffled)).toEqual(reduceRound(log));
      }),
    );
  });

  it("is idempotent under replay: folding the log twice-over changes nothing", () => {
    fc.assert(
      fc.property(fc.array(scoreEvent, { maxLength: 40 }), (events) => {
        const log = [genesis, ...events];
        expect(reduceRound([...log, ...log])).toEqual(reduceRound(log));
      }),
    );
  });
});
```

- [ ] **Step 3: Run tests to verify they fail** — `pnpm -F @swng/domain test` → FAIL (modules missing).

- [ ] **Step 4: Implement `events.ts` and `state.ts`**

`packages/domain/src/round/events.ts`:

```ts
import type { GolferId, GameId, OpId, RoundId } from "../ids.js";
import type { CourseCard } from "../course/card.js";
import type { Hlc } from "./hlc.js";
import type { Participant } from "./participant.js";
import type { HoleResult } from "./holeResult.js";

// Placeholder until Task 4 defines the real union in scoring/game.ts.
export type GameConfig = { readonly kind: string; readonly id: GameId };

// seq is server-assigned canonical order (absent until acked); the fold never uses it —
// conflicts resolve by hlc so offline replays can't clobber later intent.
export interface RoundEventBase {
  readonly opId: OpId;
  readonly hlc: Hlc;
  readonly authorId: GolferId;
  readonly seq?: number;
}

export type RoundEvent = RoundEventBase &
  (
    | { readonly kind: "round-created"; readonly roundId: RoundId; readonly card: CourseCard }
    | { readonly kind: "participant-joined"; readonly participant: Participant }
    | { readonly kind: "game-added"; readonly config: GameConfig }
    | { readonly kind: "round-started" }
    | { readonly kind: "score-recorded"; readonly golferId: GolferId; readonly hole: number; readonly result: HoleResult }
    | { readonly kind: "round-finalized" }
    | { readonly kind: "round-reopened" }
  );
```

`packages/domain/src/round/state.ts` — the fold. Implementation requirements (write it in this shape):

```ts
import type { GolferId, OpId, RoundId } from "../ids.js";
import type { CourseCard } from "../course/card.js";
import { DomainError } from "../errors.js";
import { compareHlc, type Hlc } from "./hlc.js";
import type { HoleResult } from "./holeResult.js";
import type { Participant } from "./participant.js";
import type { GameConfig, RoundEvent } from "./events.js";

export type RoundStatus = "setup" | "live" | "final";

export interface ScoreCell {
  readonly result: HoleResult;
  readonly recordedBy: GolferId;
  readonly hlc: Hlc;
  readonly opId: OpId;
}

export interface RoundState {
  readonly id: RoundId;
  readonly status: RoundStatus;
  readonly card: CourseCard;
  readonly participants: readonly Participant[];
  readonly games: readonly GameConfig[];
  readonly cells: Readonly<Record<string, ScoreCell>>;
}

export const cellKey = (golfer: GolferId, hole: number): string => `${golfer}#${hole}`;

export const reduceRound = (events: readonly RoundEvent[]): RoundState => {
  // Every sub-structure is an hlc-resolved LWW register/map, which is what makes
  // the whole fold commutative: any delivery order converges (property-tested).
  // ... implementation:
  // 1. Dedupe by opId (keep first occurrence encountered; retries are verbatim).
  // 2. Genesis: among "round-created" events pick highest hlc; none → throw
  //    new DomainError("round-log-missing-genesis").
  // 3. Status: among lifecycle events (created/started/finalized/reopened) pick
  //    highest hlc; map kind → status ("round-created"→"setup", "round-started"→"live",
  //    "round-finalized"→"final", "round-reopened"→"live").
  // 4. participants: Map<GolferId, {participant, hlc}> keeping highest hlc per golfer;
  //    emit as array in first-seen-by-hlc order (sort by hlc for determinism).
  // 5. games: same LWW-map treatment keyed by config.id.
  // 6. cells: Map keyed by cellKey; apply score-recorded iff absent or
  //    compareHlc(event.hlc, existing.hlc) > 0.
  // 7. Unknown kinds: default case falls through silently.
};
```

Add to `packages/domain/src/index.ts`: `export * from "./round/events.js"; export * from "./round/state.js";`

- [ ] **Step 5: Run tests to verify they pass** — `pnpm -F @swng/domain test` → PASS (behavior + both properties). Then `pnpm validate` → green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(domain): round event log and commutative hlc-resolved fold, with convergence properties

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Stroke allocation and handicap-hole math

**Files:**
- Create: `packages/domain/src/scoring/strokes.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/scoring/strokes.test.ts`, `packages/domain/src/scoring/strokes.properties.test.ts`

**Interfaces:**
- Consumes: `TeeSet` (Task 1).
- Produces:

```ts
export const roundHalfUp: (value: number) => number;                       // floor(x + 0.5): 7.5→8, -3.5→-3
export const allocateStrokes: (strokes: number, teeSet: TeeSet) => number[]; // dots per hole, aligned with teeSet.holes order
export const strokesReceivedOnHole: (strokes: number, teeSet: TeeSet, hole: number) => number;
export const netDoubleBogey: (par: number, strokesReceived: number) => number; // par + 2 + strokesReceived
```

**Allocation rules (fixed):** with `H` holes and `n` strokes: every hole gets `floor(n / H)`, plus one extra on holes whose `strokeIndex <= n % H`. Negative `n` (plus handicap) gives strokes back starting from the EASIEST hole: holes with `strokeIndex > H - (|n| % H)` get −1 (plus `ceil` analog for |n| > H, mirrored). Works identically for 9- and 18-hole tee sets.

- [ ] **Step 1: Write the failing tests** — complete `strokes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { TeeSet } from "../course/card.js";
import { allocateStrokes, netDoubleBogey, roundHalfUp, strokesReceivedOnHole } from "./strokes.js";

// 9 holes; strokeIndex permutation [5,1,9,3,7,8,2,4,6]
const nine: TeeSet = {
  name: "white", rating: 35.8, slope: 128,
  holes: [
    { number: 1, par: 4, yardage: 380, strokeIndex: 5 },
    { number: 2, par: 4, yardage: 410, strokeIndex: 1 },
    { number: 3, par: 3, yardage: 165, strokeIndex: 9 },
    { number: 4, par: 5, yardage: 520, strokeIndex: 3 },
    { number: 5, par: 4, yardage: 400, strokeIndex: 7 },
    { number: 6, par: 3, yardage: 180, strokeIndex: 8 },
    { number: 7, par: 4, yardage: 430, strokeIndex: 2 },
    { number: 8, par: 5, yardage: 490, strokeIndex: 4 },
    { number: 9, par: 4, yardage: 390, strokeIndex: 6 },
  ],
};

describe("roundHalfUp", () => {
  it("rounds .5 upward, including for negatives", () => {
    expect(roundHalfUp(7.6)).toBe(8);
    expect(roundHalfUp(7.5)).toBe(8);
    expect(roundHalfUp(7.4)).toBe(7);
    expect(roundHalfUp(-3.5)).toBe(-3);
  });
});

describe("allocateStrokes", () => {
  it("puts n dots on the n hardest holes", () => {
    // 6 strokes → SI 1..6 → holes 2,7,4,8,1,9 get one dot
    expect(allocateStrokes(6, nine)).toEqual([1, 1, 0, 1, 0, 0, 1, 1, 1]);
  });
  it("wraps past a full lap: 11 on 9 holes = 1 everywhere + extras on SI 1..2", () => {
    expect(allocateStrokes(11, nine)).toEqual([1, 2, 1, 1, 1, 1, 2, 1, 1]);
  });
  it("gives strokes back from the easiest holes for plus handicaps", () => {
    // -2 → SI 9 and 8 → holes 3 and 6 get -1
    expect(allocateStrokes(-2, nine)).toEqual([0, 0, -1, 0, 0, -1, 0, 0, 0]);
  });
  it("zero means a clean card", () => {
    expect(allocateStrokes(0, nine)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("strokesReceivedOnHole / netDoubleBogey", () => {
  it("reads a single hole's dots", () => {
    expect(strokesReceivedOnHole(6, nine, 2)).toBe(1);
    expect(strokesReceivedOnHole(6, nine, 3)).toBe(0);
  });
  it("caps a hole at par + 2 + strokes received", () => {
    expect(netDoubleBogey(5, 1)).toBe(8);
    expect(netDoubleBogey(4, 0)).toBe(6);
  });
});
```

And `strokes.properties.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { TeeSet } from "../course/card.js";
import { allocateStrokes } from "./strokes.js";

const teeSet = (count: 9 | 18): TeeSet => ({
  name: "t", rating: 70, slope: 113,
  holes: Array.from({ length: count }, (_, i) => ({
    number: i + 1, par: 4, yardage: 400,
    strokeIndex: ((i * 7) % count) + 1, // deterministic permutation for 9 and 18
  })),
});

describe("allocateStrokes properties", () => {
  it("dots always sum to the allocation and differ by at most 1 across holes", () => {
    fc.assert(
      fc.property(fc.integer({ min: -18, max: 54 }), fc.constantFrom(9 as const, 18 as const), (n, count) => {
        const dots = allocateStrokes(n, teeSet(count));
        expect(dots.reduce((a, b) => a + b, 0)).toBe(n);
        expect(Math.max(...dots) - Math.min(...dots)).toBeLessThanOrEqual(1);
      }),
    );
  });
});
```

(Verify the SI expression `((i * 7) % count) + 1` is a permutation for 9 and 18 — gcd(7,9)=gcd(7,18)=1, so it is.)

- [ ] **Step 2: Run to verify FAIL**, **Step 3: implement `strokes.ts`** (pure arithmetic per the fixed rules; comment the plus-handicap mirror rule's why), **Step 4: run to PASS**, then `pnpm validate`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(domain): stroke allocation by stroke index, half-up rounding, net double bogey

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Games framework + stroke play engine + golden deck

**Files:**
- Create: `packages/domain/src/scoring/game.ts`, `packages/domain/src/scoring/allowances.ts`, `packages/domain/src/scoring/strokePlay.ts`, `packages/domain/src/scoring/golden/fixtureCourse.ts`, `packages/domain/src/scoring/golden/deck.ts`
- Modify: `packages/domain/src/round/events.ts` (re-point `GameConfig` import to `../scoring/game.js`, delete the placeholder), `packages/domain/src/index.ts`
- Test: `packages/domain/src/scoring/strokePlay.test.ts` (golden deck + net ≤ gross property)

**Interfaces:**
- Consumes: everything above.
- Produces (later formats and M2+ consume these exact shapes):

```ts
// game.ts
export type GameConfig =
  | { readonly kind: "stroke-play"; readonly id: GameId; readonly scoring: "gross" | "net"; readonly players: readonly GolferId[]; readonly allowance?: number }
  | { readonly kind: "singles-match"; readonly id: GameId; readonly a: GolferId; readonly b: GolferId; readonly allowance?: number };

export interface RunningTotal { readonly total: number; readonly pickups: number } // pickups>0 ⇒ the total is not a completed gross score
export interface StrokePlayLine { readonly golferId: GolferId; readonly thru: number; readonly gross: RunningTotal; readonly net?: RunningTotal }
export type MatchOutcome = { readonly winner: GolferId; readonly closing: string } | { readonly halved: true }
export type GameState =
  | { readonly kind: "stroke-play"; readonly id: GameId; readonly scoring: "gross" | "net"; readonly lines: readonly StrokePlayLine[]; readonly complete: boolean }
  | { readonly kind: "singles-match"; readonly id: GameId; readonly up: number; readonly leader?: GolferId; readonly thru: number; readonly remaining: number; readonly dormie: boolean; readonly outcome?: MatchOutcome };

export const scoreGame: (config: GameConfig, state: RoundState) => GameState; // dispatch table by kind
// allowances.ts
export const defaultAllowance: (kind: GameConfig["kind"]) => number; // "stroke-play" → 0.95 (WHS individual), "singles-match" → 1 (full difference)
export const playingHandicap: (courseHandicap: number, allowance: number) => number; // roundHalfUp(ch × allowance)
```

**Engine semantics (fixed):**
- *stroke play*: per player, over decided holes (cells present): gross `RunningTotal` sums `strokes` results, counting picked-up/conceded in `pickups` (they have no gross number). Net (when `scoring: "net"`): playing handicap = `playingHandicap(courseHandicap, allowance ?? defaultAllowance("stroke-play"))`; per-hole net = strokes − dots; picked-up/conceded holes enter net at `netDoubleBogey(par, dots) − dots` (= par + 2). `complete` = every player has a result on every hole.
- *golden deck*: fixtures are plain TS data + a tiny runner in `golden/deck.ts` that builds the event log (genesis → joins → started → scores in order), reduces, scores every game, and returns the states — fixtures then assert exact expected values.

- [ ] **Step 1: Write `fixtureCourse.ts`** (shared by both decks — the 9-hole card from Task 3's test, wrapped as `CourseCard`, exported as `fixtureLinks` plus `fixtureWhite: TeeSet`).

- [ ] **Step 2: Write the failing golden tests** — `strokePlay.test.ts`, complete:

```ts
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { gameId, golferId } from "../ids.js";
import { playGoldenRound } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";
import type { GameState } from "./game.js";

const A = golferId("ann");
const B = golferId("bo");
const players = [
  { golferId: A, name: "Ann", tee: "white", courseHandicap: 8 },
  { golferId: B, name: "Bo", tee: "white", courseHandicap: 2 },
];

const grossGame = { kind: "stroke-play", id: gameId("g1"), scoring: "gross", players: [A, B] } as const;
const netGame = { kind: "stroke-play", id: gameId("g2"), scoring: "net", players: [A, B] } as const;

describe("stroke play — golden cards", () => {
  it("gross: Ann 39, Bo 41, complete", () => {
    const [state] = playGoldenRound(fixtureLinks, players, [grossGame], {
      [A]: [4, 5, 3, 6, 4, 3, 5, 5, 4],
      [B]: [5, 4, 4, 5, 4, 4, 4, 6, 5],
    });
    expect(state).toMatchObject({
      kind: "stroke-play", complete: true,
      lines: [
        { golferId: A, thru: 9, gross: { total: 39, pickups: 0 } },
        { golferId: B, thru: 9, gross: { total: 41, pickups: 0 } },
      ],
    });
  });

  it("net with dots and a pickup: Ann nets 39 via net double bogey, Bo nets 35", () => {
    // Playing handicaps at 95%: Ann 8 → 8 dots (every hole but SI 9), Bo 2 → dots on SI 1,2.
    // Ann picks up on hole 4 (par 5, 1 dot): counts par+2 = 7 net.
    const [state] = playGoldenRound(fixtureLinks, players, [netGame], {
      [A]: [5, 6, 3, "picked-up", 5, 4, 5, 6, 5],
      [B]: [4, 4, 3, 5, 5, 3, 4, 5, 4],
    });
    expect(state).toMatchObject({
      kind: "stroke-play", complete: true,
      lines: [
        { golferId: A, thru: 9, gross: { total: 39, pickups: 1 }, net: { total: 39, pickups: 0 } },
        { golferId: B, thru: 9, gross: { total: 37, pickups: 0 }, net: { total: 35, pickups: 0 } },
      ],
    });
  });

  it("mid-round: totals run over decided holes only, complete=false", () => {
    const [state] = playGoldenRound(fixtureLinks, players, [grossGame], {
      [A]: [4, 5, 3],
      [B]: [5, 4],
    });
    const lines = (state as GameState & { kind: "stroke-play" }).lines;
    expect(lines[0]).toMatchObject({ thru: 3, gross: { total: 12, pickups: 0 } });
    expect(lines[1]).toMatchObject({ thru: 2, gross: { total: 9, pickups: 0 } });
    expect((state as { complete: boolean }).complete).toBe(false);
  });
});

describe("stroke play — properties", () => {
  it("net never exceeds gross for non-negative handicaps with full cards", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 9, maxLength: 9 }),
        fc.integer({ min: 0, max: 18 }),
        (strokes, courseHandicap) => {
          const P = golferId("p");
          const [state] = playGoldenRound(
            fixtureLinks,
            [{ golferId: P, name: "P", tee: "white", courseHandicap }],
            [{ kind: "stroke-play", id: gameId("g"), scoring: "net", players: [P] }],
            { [P]: strokes },
          );
          const line = (state as GameState & { kind: "stroke-play" }).lines[0]!;
          expect(line.net!.total).toBeLessThanOrEqual(line.gross.total);
        },
      ),
    );
  });
});
```

- [ ] **Step 3: Run to verify FAIL.**

- [ ] **Step 4: Implement** `game.ts` (unions + `scoreGame` dispatch table — one entry per kind, throw `DomainError("unknown-game-kind")` on gaps), `allowances.ts`, `strokePlay.ts` per the fixed semantics, `golden/deck.ts`:

```ts
// golden/deck.ts — builds a canonical event log from fixture data and scores every game.
// Signature (fixtures pass strokes as numbers or the literal "picked-up"/"conceded"):
export type FixtureScores = Readonly<Record<string, ReadonlyArray<number | "picked-up" | "conceded">>>;
export const playGoldenRound = (
  card: CourseCard,
  participants: readonly Participant[],
  games: readonly GameConfig[],
  scores: FixtureScores,
): GameState[] => { /* genesis → joins → game-added×N → started → score-recorded per (golfer, hole index+1) with sequential hlcs → reduceRound → games.map(scoreGame) */ };
```

Re-point `events.ts`'s `GameConfig` to `import type { GameConfig } from "../scoring/game.js"` and delete the placeholder. Update the barrel.

- [ ] **Step 5: Run to PASS**, then `pnpm validate` → green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(domain): games framework, WHS allowances, stroke play engine with golden deck

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Singles match engine + golden deck + doc reconciliation

**Files:**
- Create: `packages/domain/src/scoring/singlesMatch.ts`
- Modify: `packages/domain/src/scoring/game.ts` (wire dispatch entry), `packages/domain/src/index.ts`
- Modify (docs): `docs/architecture.md` (two one-line reconciliations), `docs/implementation-plan.md` (M1 "Produces" line)
- Test: `packages/domain/src/scoring/singlesMatch.test.ts`

**Interfaces:**
- Consumes: Task 4's `GameConfig`/`GameState`/`MatchOutcome`, `allocateStrokes`, `playGoldenRound`.
- Produces: the `singles-match` dispatch entry; `GameState` variant as declared in Task 4.

**Engine semantics (fixed):**
- Match strokes are relative: `diff = roundHalfUp((chHigh − chLow) × (allowance ?? 1))` strokes to the higher-handicap player, allocated by `allocateStrokes(diff, teeSet)`; the lower player plays off scratch.
- Process holes in card order; a hole is decided when BOTH cells exist. Hole winner by net; `picked-up`/`conceded` loses the hole (both → halved). `thru` = decided holes; `remaining` = H − decided.
- Closed out when `|up| > remaining` → `closing` = `` `${up}&${remaining}` ``; decided at the last hole → `"1 up"`/`"2 up"`; all decided and level → `{ halved: true }` (state shows `up: 0`, no leader). `dormie` = `|up| === remaining && remaining > 0`.
- Holes decided after the match is closed are ignored (the match is over; junk lives in other games).

- [ ] **Step 1: Write the failing tests** — `singlesMatch.test.ts`, complete:

```ts
import { describe, expect, it } from "vitest";
import { gameId, golferId } from "../ids.js";
import { playGoldenRound } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";

const A = golferId("ann"); // courseHandicap 8
const B = golferId("bo");  // courseHandicap 2 → Ann gets 6 dots on SI 1..6 (holes 1,2,4,7,8,9)
const players = [
  { golferId: A, name: "Ann", tee: "white", courseHandicap: 8 },
  { golferId: B, name: "Bo", tee: "white", courseHandicap: 2 },
];
const match = { kind: "singles-match", id: gameId("m1"), a: A, b: B } as const;

describe("singles match — golden cards", () => {
  it("full-difference strokes close it out 3&2", () => {
    // h1 halve(net4/4) h2 A(4/5) h3 A(3/4) h4 halve(5/5) h5 A(4/5) h6 B(4/3) h7 A(4/5) → A 3 up thru 7, 2 to play
    const [state] = playGoldenRound(fixtureLinks, players, [match], {
      [A]: [5, 5, 3, 6, 4, 4, 5],
      [B]: [4, 5, 4, 5, 5, 3, 5],
    });
    expect(state).toMatchObject({
      kind: "singles-match", up: 3, leader: A, thru: 7, remaining: 2, dormie: false,
      outcome: { winner: A, closing: "3&2" },
    });
  });

  it("dormie is called when up equals remaining", () => {
    // Same card thru 6: A 2 up, 3 remaining → not dormie. Add h7 halve → 2 up, 2 remaining → dormie.
    const [state] = playGoldenRound(fixtureLinks, players, [match], {
      [A]: [5, 5, 3, 6, 4, 4, 5],
      [B]: [4, 5, 4, 5, 5, 3, 4], // h7: A net 4, B 4 → halve
    });
    expect(state).toMatchObject({ up: 2, leader: A, thru: 7, remaining: 2, dormie: true });
    expect((state as { outcome?: unknown }).outcome).toBeUndefined();
  });

  it("a conceded hole is lost; a match can end all square", () => {
    // Hole-by-hole (Ann's dots on 1,2,4,7,8,9): h1 halve (net 4/4), h2 Ann (4/6),
    // h3 Bo (4/3), h4 Ann (5/6), h5 halve (4/4), h6 halve (4/4), h7 halve (4/4),
    // h8 halve (5/5), h9 Ann concedes → Bo wins → level overall: +1 −1 = 0.
    const [state] = playGoldenRound(fixtureLinks, players, [match], {
      [A]: [5, 5, 4, 6, 4, 4, 5, 6, "conceded"],
      [B]: [4, 6, 3, 6, 4, 4, 4, 5, 5],
    });
    expect(state).toMatchObject({ kind: "singles-match", up: 0, thru: 9, remaining: 0, outcome: { halved: true } });
  });

  it("a win sealed on the final hole reads '1 up', not '1&0'", () => {
    // Level thru 8, A wins h9 (dot): net 4 vs 5.
    const [state] = playGoldenRound(fixtureLinks, players, [match], {
      [A]: [5, 5, 4, 6, 4, 4, 5, 6, 5],
      [B]: [4, 6, 3, 6, 4, 3, 4, 5, 5],
    });
    expect(state).toMatchObject({ outcome: { winner: A, closing: "1 up" } });
  });
});
```

**IMPLEMENTER MUST VERIFY the last two fixtures hole-by-hole against the engine semantics before implementing** (dots for Ann on holes 1,2,4,7,8,9): if an expected value is wrong, the fixture — not the engine — is the bug; recompute and correct the fixture, showing the hole-by-hole working in your report.

- [ ] **Step 2: Run to verify FAIL.** **Step 3: Implement** `singlesMatch.ts` + dispatch entry. **Step 4: Run to PASS**, `pnpm validate` green.

- [ ] **Step 5: Doc reconciliation (exact edits)**

In `docs/architecture.md`: (a) in the §1 code block, change the signature line to
`scoreGame(config: GameConfig, state: RoundState): GameState   // state = reduceRound(events); N games share one fold`;
(b) in the §2 `RoundEvent` sketch, delete the `| ScoreCorrected` line (a correction is a later `ScoreRecorded` — LWW).
In `docs/implementation-plan.md` M1 section, "Produces" line: replace `scoreGame` with `scoreGame(config, reducedState)`.

- [ ] **Step 6: Final gate & commit**

Run: `pnpm validate` → green. Confirm the M1 gate from `docs/implementation-plan.md`: golden decks pass, `pnpm -F @swng/domain test` green, property suite green.

```bash
git add -A
git commit -m "feat(domain): singles match engine with match-relative strokes and golden deck; reconcile docs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
