# A Round Plays a Nine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A round records the holes it set out to play — all 18, the front nine, or the back nine — chosen at creation, changeable while live, so a nine played at an 18-hole course allocates its strokes correctly and lands in the golfer's record as a nine.

**Architecture:** One optional field on the round (`HoleSelection = "all" | "front" | "back"`, absent means the whole card), folded into `RoundState`, corrected by one narrow event, and frozen into the archive. One total domain function, `intendedHoles(teeSet, selection)`, replaces every read of `teeSet.holes` that meant "the holes this round plays". Two things consume it — stroke allocation and completeness — and everything else is downstream. Nothing about what was *actually scored* is stored: the golfer's decided cells already are that, and `hasCompleteScore` already compares the two.

**Tech Stack:** TypeScript (ESM, `nodenext` — relative imports carry `.js`), pnpm workspaces, Vitest, Zod (contracts), React 19 + Tailwind 4 (web), AWS CDK (routes).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-02-round-plays-a-nine-design.md`. Read it before Task 1.
- **No migration, no wipe, no rebuild.** Absent `holes` means the whole card, on every stored round, snapshot and fixture. Any change that makes an existing stored round parse differently is a defect.
- **Bounds and validation on request schemas only** — never on a stored-event, archive, or fold path (Arc A placement rule). A guard on a read path makes a stored round permanently unreadable.
- `intendedHoles` is **total**: on a card with one nine, every selection resolves to that nine. It never throws.
- **The settled wire must stay byte-unchanged** apart from the one additive optional `holes` on the archive.
- Golf logic lives in `@swng/domain`; `apps/web` renders. New compute names go on the ESLint banlist and are re-exported through `@swng/client` (Task 7).
- `pnpm validate` must pass at every commit. Run it before each commit step.
- Commit messages: sentence-case subject, no scope-less noise; end with the `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` trailer.

---

### Task 1: The fact and the resolver

**Files:**
- Create: `packages/domain/src/round/holes.ts`
- Create: `packages/domain/src/round/holes.test.ts`
- Modify: `packages/domain/src/round/events.ts` (add `holes?` to `round-created`; add the `round-holes-set` arm)
- Modify: `packages/domain/src/round/state.ts` (`RoundState.holes`; fold register)
- Modify: `packages/domain/src/round/state.test.ts` (fold tests)
- Modify: `packages/domain/src/index.ts` (export `HoleSelection`, `intendedHoles`)

**Interfaces:**
- Consumes: `Hole`, `TeeSet` from `../course/card.js`; `compareHlc`, `Hlc` from `./hlc.js`.
- Produces:
  - `export type HoleSelection = "all" | "front" | "back"`
  - `export const intendedHoles: (teeSet: TeeSet, selection: HoleSelection) => readonly Hole[]`
  - `RoundState.holes: HoleSelection` (always defined)
  - `RoundEvent` arm `{ kind: "round-holes-set"; holes: HoleSelection }`
  - `round-created` gains `holes?: HoleSelection`

- [ ] **Step 1: Write the failing resolver test**

Create `packages/domain/src/round/holes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { TeeSet } from "../course/card.js";
import { intendedHoles } from "./holes.js";

// An 18-hole tee with the conventional split: odd stroke indexes on the front, even on the back.
const eighteen: TeeSet = {
  name: "white",
  holes: Array.from({ length: 18 }, (_, i) => ({
    number: i + 1,
    par: 4,
    yardage: 400,
    strokeIndex: i < 9 ? i * 2 + 1 : (i - 9) * 2 + 2,
  })),
};

const nine: TeeSet = { name: "white", holes: eighteen.holes.slice(0, 9) };

const numbers = (tee: TeeSet, selection: Parameters<typeof intendedHoles>[1]) =>
  intendedHoles(tee, selection).map((h) => h.number);

describe("intendedHoles", () => {
  it("gives the whole card for 'all'", () => {
    expect(numbers(eighteen, "all")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });

  it("gives the first nine in card order for 'front'", () => {
    expect(numbers(eighteen, "front")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("gives the second nine in card order for 'back'", () => {
    expect(numbers(eighteen, "back")).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });

  // The case that must never throw and never come back empty: a nine-hole card has one nine, so
  // every selection names it. "We played nine holes at a nine-hole course" is a true statement.
  it.each(["all", "front", "back"] as const)("resolves '%s' to the whole nine on a one-nine card", (selection) => {
    expect(numbers(nine, selection)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("preserves the hole objects themselves, not copies", () => {
    expect(intendedHoles(eighteen, "back")[0]).toBe(eighteen.holes[9]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -F @swng/domain vitest run src/round/holes.test.ts`
Expected: FAIL — cannot resolve `./holes.js`.

- [ ] **Step 3: Write the resolver**

Create `packages/domain/src/round/holes.ts`:

```ts
import type { Hole, TeeSet } from "../course/card.js";

// Which holes a round SET OUT to play (spec 2026-08-02 §3). A plan, not an outcome: stroke
// allocation depends on the hole set, so the set has to be fixed before the first score or the
// dots shift under the players while they enter them. What actually got scored is the golfer's
// own decided cells, already derived — nothing here stores it.
export type HoleSelection = "all" | "front" | "back";

const NINE = 9;

// TOTAL, deliberately (spec §3): a card with one nine has one answer, so every selection resolves
// to that nine rather than throwing or coming back empty. There is no error case to design,
// because "we played nine holes at a nine-hole course" is a true statement. The only guard in the
// system lives at startRound's door (Task 6), where the card is already in hand — never here, on a
// read path, where it would make a stored round permanently unreadable (Arc A placement rule).
export const intendedHoles = (teeSet: TeeSet, selection: HoleSelection): readonly Hole[] => {
  if (selection === "all" || teeSet.holes.length <= NINE) return teeSet.holes;
  return selection === "front" ? teeSet.holes.slice(0, NINE) : teeSet.holes.slice(NINE);
};
```

- [ ] **Step 4: Run the resolver test — it should pass**

Run: `pnpm -F @swng/domain vitest run src/round/holes.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing fold tests**

Append to `packages/domain/src/round/state.test.ts` (the fixtures `genesis`, `base`, `card`, `started` already exist at the top of that file):

```ts
describe("holes — which holes the round set out to play (spec 2026-08-02 §3)", () => {
  it("defaults to the whole card when the genesis says nothing", () => {
    expect(reduceRound([genesis]).holes).toBe("all");
  });

  it("takes the genesis's own selection", () => {
    const g: RoundEvent = { ...base(1), kind: "round-created", roundId: roundId("r1"), card, playedAtMs: 1, holes: "back" };
    expect(reduceRound([g]).holes).toBe("back");
  });

  it("a later round-holes-set wins", () => {
    const set: RoundEvent = { ...base(10), kind: "round-holes-set", holes: "front" };
    expect(reduceRound([genesis, started, set]).holes).toBe("front");
  });

  it("resolves two corrections by hlc, not arrival order", () => {
    const early: RoundEvent = { ...base(10), kind: "round-holes-set", holes: "front" };
    const late: RoundEvent = { ...base(20), kind: "round-holes-set", holes: "all" };
    expect(reduceRound([genesis, early, late]).holes).toBe("all");
    expect(reduceRound([genesis, late, early]).holes).toBe("all");
  });

  // Spec §3b: changing your mind is the normal case, so it must cost nothing. Cells are keyed by
  // hole number and the hole set is a filter over them, so this is true by construction — pinned
  // anyway, because it is the promise the round page's teaching line makes to the golfer.
  it("loses nothing scored when the selection changes", () => {
    const front: RoundEvent = { ...base(5), kind: "round-holes-set", holes: "front" };
    const scored: RoundEvent = { ...base(6), kind: "score-recorded", golferId: A, hole: 2, result: { kind: "strokes", strokes: 4 } };
    const widened: RoundEvent = { ...base(7), kind: "round-holes-set", holes: "all" };
    const state = reduceRound([genesis, joinA, started, front, scored, widened]);
    expect(state.holes).toBe("all");
    expect(cellAt(state.cells, A, 2)?.result).toEqual({ kind: "strokes", strokes: 4 });
  });
});
```

Note: `card` in `state.test.ts` is a 3-hole fixture, so `intendedHoles` returns it whole for any
selection — which is exactly why these tests assert `state.holes`, the folded VALUE, and never the
resolved hole list. The resolver has its own test file.

- [ ] **Step 6: Run them and watch them fail**

Run: `pnpm -F @swng/domain vitest run src/round/state.test.ts -t "holes —"`
Expected: FAIL — `holes` is not a property of `RoundState`; `round-holes-set` is not a `RoundEvent` kind.

- [ ] **Step 7: Add the event arms**

In `packages/domain/src/round/events.ts`, add the import and extend `round-created`:

```ts
import type { HoleSelection } from "./holes.js";
```

Change the `round-created` arm to include `holes`:

```ts
    // Which holes this round set out to play (spec 2026-08-02 §3a). OPTIONAL, and its absence is a
    // TRUE STATEMENT rather than a missing fact: every round ever played played its whole card, so
    // there is nothing to migrate and every stored genesis folds byte-identically. That is the
    // distinction from playedAtMs above, which was made required precisely because an absent value
    // there had to be invented.
    | { readonly kind: "round-created"; readonly roundId: RoundId; readonly card: CourseCard; readonly playedAtMs: number; readonly holes?: HoleSelection }
```

And add a new arm beside `round-played-at-set`:

```ts
    // The holes, corrected (spec 2026-08-02 §3b): the round-played-at-set template — a round-level
    // fact, so no golferId. Latest-HLC-wins; `authorId` records who changed it. Any participant may
    // set it (the score-for-anyone trust model), enforced at the API layer, not here. Going out for
    // nine and playing on is the normal case, not the error case.
    | { readonly kind: "round-holes-set"; readonly holes: HoleSelection }
```

- [ ] **Step 8: Fold it**

In `packages/domain/src/round/state.ts`, import the type:

```ts
import type { HoleSelection } from "./holes.js";
```

Add to the `RoundState` interface, directly under `playedAtMs`:

```ts
  // Which holes this round set out to play (spec 2026-08-02 §3). ALWAYS DEFINED here even though
  // the stored fields are optional — absence means the whole card, and resolving that once in the
  // fold keeps every downstream reader from re-deciding it.
  readonly holes: HoleSelection;
```

Add the register inside `reduceRound`, after the played-date step (step 2b) — a single ascending scan over `deduped`, which is already in canonical HLC-major order, so the last write wins without a separate max pass:

```ts
  // 2c. Holes: the latest round-holes-set by HLC, else the genesis's own selection, else the whole
  //     card. One ascending scan over the canonical order handles all three arms.
  let holes: HoleSelection = genesis.holes ?? "all";
  for (const event of deduped) {
    if (event.kind === "round-holes-set") holes = event.holes;
  }
```

and add `holes,` to the returned object, beside `playedAtMs`.

- [ ] **Step 9: Run the fold tests**

Run: `pnpm -F @swng/domain vitest run src/round/state.test.ts`
Expected: PASS, including the four new tests.

- [ ] **Step 10: Export from the barrel**

In `packages/domain/src/index.ts`, beside the other `round/` exports, add:

```ts
export { intendedHoles } from "./round/holes.js";
export type { HoleSelection } from "./round/holes.js";
```

- [ ] **Step 11: Validate and commit**

Run: `pnpm validate`
Expected: exit 0.

```bash
git add packages/domain/src/round/holes.ts packages/domain/src/round/holes.test.ts \
  packages/domain/src/round/events.ts packages/domain/src/round/state.ts \
  packages/domain/src/round/state.test.ts packages/domain/src/index.ts
git commit -m "feat(domain): a round records the holes it set out to play"
```

---

### Task 2: Allocation ranks the holes played

**Files:**
- Modify: `packages/domain/src/scoring/strokes.ts` (`allocateStrokes`, `dotsByHole`, `strokesReceivedOnHole` take a hole list)
- Modify: `packages/domain/src/scoring/strokes.test.ts`
- Modify: `packages/domain/src/scoring/allocation.ts` (the two `dotsByHole` call sites)

**Interfaces:**
- Consumes: `Hole` from `../course/card.js`.
- Produces:
  - `allocateStrokes(strokes: number, holes: readonly Hole[]): number[]` — dots per hole, in the order of `holes`
  - `dotsByHole(strokes: number, holes: readonly Hole[]): ReadonlyMap<number, number>`
  - `strokesReceivedOnHole(strokes: number, holes: readonly Hole[], hole: number): number`

**Why:** `allocateStrokes` reads `strokeIndex <= extra`, which assumes stroke index is a permutation of `1..N`. That is false for a nine drawn out of an eighteen — the back nine carries 2, 4 … 18 — so five strokes would draw two dots. It must rank the holes being played by stroke index and allocate hardest-first over that ranking. On a full card, rank ≡ stroke index, so the output is unchanged.

- [ ] **Step 1: Write the failing tests**

In `packages/domain/src/scoring/strokes.test.ts`, add a back-nine fixture beside the existing `nine` and add the tests. Note that every existing call in this file becomes `allocateStrokes(6, nine.holes)` — update them in Step 3, not now.

```ts
// The back nine of a conventional 18-hole card: stroke indexes 2, 4, 6 … 18. Nothing here is a
// permutation of 1..9, which is exactly what the raw-strokeIndex rule could not handle.
const backNine: readonly Hole[] = [
  { number: 10, par: 4, yardage: 400, strokeIndex: 2 },
  { number: 11, par: 4, yardage: 400, strokeIndex: 4 },
  { number: 12, par: 4, yardage: 400, strokeIndex: 6 },
  { number: 13, par: 4, yardage: 400, strokeIndex: 8 },
  { number: 14, par: 4, yardage: 400, strokeIndex: 10 },
  { number: 15, par: 4, yardage: 400, strokeIndex: 12 },
  { number: 16, par: 4, yardage: 400, strokeIndex: 14 },
  { number: 17, par: 4, yardage: 400, strokeIndex: 16 },
  { number: 18, par: 4, yardage: 400, strokeIndex: 18 },
];

describe("allocateStrokes over a nine drawn out of an eighteen (spec 2026-08-02 §3d)", () => {
  it("gives every typed stroke a hole, ranking the holes played by stroke index", () => {
    // 5 strokes over these nine → the five hardest of THEM: SI 2,4,6,8,10 = holes 10-14.
    expect(allocateStrokes(5, backNine)).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0]);
  });

  it("wraps past a full lap the same way", () => {
    // 11 over nine holes → 1 everywhere, plus a second on the two hardest (SI 2 and 4).
    expect(allocateStrokes(11, backNine)).toEqual([2, 2, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("keys dots by the card's own hole numbers, not positions", () => {
    expect(Object.fromEntries(dotsByHole(2, backNine))).toEqual({
      10: 1, 11: 1, 12: 0, 13: 0, 14: 0, 15: 0, 16: 0, 17: 0, 18: 0,
    });
  });

  // The pin that protects every round that has nothing to do with nines: on a full card, rank IS
  // stroke index, so ranking changes no existing number.
  it("is byte-identical to the raw-strokeIndex rule on a full card", () => {
    const raw = (strokes: number, holes: readonly Hole[]) => {
      const base = Math.floor(strokes / holes.length);
      const extra = strokes % holes.length;
      return holes.map(({ strokeIndex }) => base + (strokeIndex <= extra ? 1 : 0));
    };
    for (const strokes of [0, 1, 5, 8, 9, 10, 17, 18, 25, 36]) {
      expect(allocateStrokes(strokes, nine.holes)).toEqual(raw(strokes, nine.holes));
    }
  });
});
```

Add `Hole` to the existing type import at the top of the file: `import type { Hole, TeeSet } from "../course/card.js";`

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm -F @swng/domain vitest run src/scoring/strokes.test.ts`
Expected: FAIL — `allocateStrokes` expects a `TeeSet`, and the back-nine cases return the wrong dots.

- [ ] **Step 3: Rewrite the allocation over a hole list**

In `packages/domain/src/scoring/strokes.ts`, replace the three functions:

```ts
import type { Hole } from "../course/card.js";

export const roundHalfUp = (value: number): number => Math.floor(value + 0.5);

// Dots on the hardest holes first, wrapping past a full lap. Takes the holes BEING PLAYED, not a
// tee set, and ranks them among themselves (spec 2026-08-02 §3d): a nine drawn out of an eighteen
// carries stroke indexes 2, 4 … 18, so reading `strokeIndex` raw would hand out a fraction of the
// typed strokes. Rank ≡ strokeIndex whenever the whole card is played, so this changes no existing
// number — pinned in strokes.test.ts.
//
// Non-negative by construction: a player's strokes are asserted, and the request schema bounds
// them at min(0), so nobody ever gives strokes back.
export const allocateStrokes = (strokes: number, holes: readonly Hole[]): number[] => {
  const holeCount = holes.length;
  const base = Math.floor(strokes / holeCount);
  const extra = strokes % holeCount;

  // Rank 1 is the hardest hole AMONG THESE. Ties are impossible on a real card (stroke index is a
  // permutation within a tee set), so a plain ascending sort is a total ranking.
  const rankByHole = new Map(
    [...holes]
      .sort((a, b) => a.strokeIndex - b.strokeIndex)
      .map((hole, index) => [hole.number, index + 1] as const),
  );

  return holes.map((hole) => base + (rankByHole.get(hole.number)! <= extra ? 1 : 0));
};

// Hole-number → dots lookup, computed from a SINGLE allocateStrokes run. Callers that need dots
// for every hole (a full scorecard) must build this once and reuse it — calling
// strokesReceivedOnHole per hole instead re-runs allocateStrokes per hole, which is O(holes²) for
// no benefit since one allocation already covers the round.
export const dotsByHole = (strokes: number, holes: readonly Hole[]): ReadonlyMap<number, number> => {
  const dots = allocateStrokes(strokes, holes);
  return new Map(holes.map((hole, index) => [hole.number, dots[index]!]));
};

export const strokesReceivedOnHole = (strokes: number, holes: readonly Hole[], hole: number): number => {
  const dots = dotsByHole(strokes, holes).get(hole);
  if (dots === undefined) throw new DomainError("unknown-hole", `no hole numbered ${hole}`);
  return dots;
};
```

Keep `netDoubleBogey` and `netStrokes` exactly as they are. Remove the now-unused `TeeSet` import if nothing else in the file uses it.

- [ ] **Step 4: Update the existing call sites in this file's tests and in allocation.ts**

In `packages/domain/src/scoring/strokes.test.ts`, change every `allocateStrokes(n, nine)` to `allocateStrokes(n, nine.holes)`, every `dotsByHole(n, nine)` to `dotsByHole(n, nine.holes)`, and every `strokesReceivedOnHole(n, nine, h)` to `strokesReceivedOnHole(n, nine.holes, h)`. Do not change any expected value.

In `packages/domain/src/scoring/allocation.ts`, the two `dotsByHole` calls currently pass a tee set. Change them to pass `findTeeSet(card, p.tee).holes` for now — Task 3 replaces that expression with the intended holes.

- [ ] **Step 5: Run the domain suite**

Run: `pnpm -F @swng/domain vitest run`
Expected: PASS. Any failure here means a number moved on a full card — investigate before proceeding; the byte-identical pin is the whole safety argument for this task.

- [ ] **Step 6: Validate and commit**

Run: `pnpm validate`

```bash
git add packages/domain/src/scoring/strokes.ts packages/domain/src/scoring/strokes.test.ts \
  packages/domain/src/scoring/allocation.ts
git commit -m "feat(domain): allocate strokes over the holes played, ranked by stroke index"
```

---

### Task 3: The live round walks its intended holes

**Files:**
- Modify: `packages/domain/src/scoring/players.ts` (`PlayerTeeSet` gains `holes`; `allPlayersComplete`)
- Modify: `packages/domain/src/scoring/allocation.ts` (`gameStrokeAllocation`, `roundStrokeAllocation` take the selection)
- Modify: `packages/domain/src/scoring/strokePlay.ts`, `stableford.ts`, `skins.ts`, `singlesMatch.ts`, `fourballMatch.ts`
- Modify: `packages/domain/src/scoring/allocation.test.ts`, `skins.test.ts`, `singlesMatch.test.ts`
- Create: `packages/domain/src/scoring/nine.test.ts`

**Interfaces:**
- Consumes: `intendedHoles`, `HoleSelection` (Task 1); `dotsByHole(strokes, holes)` (Task 2).
- Produces:
  - `PlayerTeeSet` becomes `{ participant: Participant; teeSet: TeeSet; holes: readonly Hole[] }`
  - `gameStrokeAllocation(config, participants, card, selection: HoleSelection)`
  - `roundStrokeAllocation(participants, card, selection: HoleSelection)`

- [ ] **Step 1: Write the failing whole-round test**

Create `packages/domain/src/scoring/nine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CourseCard } from "../course/card.js";
import { deviceId, gameId, golferId, opId, roundId } from "../ids.js";
import type { Hlc } from "../round/hlc.js";
import type { RoundEvent } from "../round/events.js";
import { reduceRound } from "../round/state.js";
import { roundStrokeAllocation, totalDots } from "./allocation.js";
import { scoreGame } from "./game.js";
import { resultOf } from "./result.js";

// The conventional split: odd stroke indexes on the front, even on the back.
const card: CourseCard = {
  courseName: "Casa Verde GC",
  teeSets: [
    {
      name: "white",
      holes: Array.from({ length: 18 }, (_, i) => ({
        number: i + 1,
        par: 4,
        yardage: 400,
        strokeIndex: i < 9 ? i * 2 + 1 : (i - 9) * 2 + 2,
      })),
    },
  ],
};

const A = golferId("ann");
const B = golferId("bo");
let op = 0;
const at = (wallMs: number): Hlc => ({ wallMs, counter: 0, deviceId: deviceId("d1") });
const base = (wallMs: number) => ({ opId: opId(`op-${op++}`), hlc: at(wallMs), authorId: A });
const BACK_NINE = [10, 11, 12, 13, 14, 15, 16, 17, 18];

const backNineRound = (): RoundEvent[] => {
  const events: RoundEvent[] = [
    { ...base(1), kind: "round-created", roundId: roundId("r1"), card, playedAtMs: 1, holes: "back" },
    { ...base(2), kind: "participant-joined", participant: { golferId: A, name: "Ann", tee: "white", strokes: 5 } },
    { ...base(3), kind: "participant-joined", participant: { golferId: B, name: "Bo", tee: "white", strokes: 0 } },
    { ...base(4), kind: "round-started" },
    { ...base(5), kind: "game-added", config: { kind: "skins", id: gameId("g1"), scoring: "net", players: [A, B] } },
  ];
  for (const hole of BACK_NINE) {
    events.push({ ...base(10 + hole), kind: "score-recorded", golferId: A, hole, result: { kind: "strokes", strokes: 5 } });
    events.push({ ...base(40 + hole), kind: "score-recorded", golferId: B, hole, result: { kind: "strokes", strokes: 4 } });
  }
  return events;
};

describe("a nine played on an 18-hole card (spec 2026-08-02)", () => {
  it("gives the player every stroke they typed, on the hardest of the nine played", () => {
    const state = reduceRound(backNineRound());
    const dots = roundStrokeAllocation(state.participants, state.card, state.holes).get(A)!;
    expect(totalDots(dots)).toBe(5);
    // Ranked among the back nine: hole 10 (SI 2) is rank 1, then 11, 12, 13, 14. Five strokes over
    // nine holes is base 0 with 5 extras, so ranks 1-5 each take one dot.
    expect(Object.fromEntries(dots)).toEqual({ 10: 1, 11: 1, 12: 1, 13: 1, 14: 1, 15: 0, 16: 0, 17: 0, 18: 0 });
  });

  it("resolves its games once the nine is scored", () => {
    const state = reduceRound(backNineRound());
    expect(resultOf(scoreGame(state.games[0]!, state))).toBeDefined();
  });

  // A match's closing arithmetic counts the holes the ROUND has left, not the card's. Bo wins
  // every hole (4 to Ann's 5, and Ann's five dots do not cover a stroke a hole), so he is 5 up
  // after five holes with four to play — dormie territory on a nine, meaningless on an eighteen.
  it("closes a match over nine holes, not eighteen", () => {
    const events = backNineRound().filter((e) => e.kind !== "game-added");
    events.push({ ...base(6), kind: "game-added", config: { kind: "singles-match", id: gameId("g2"), a: A, b: B } });
    const state = reduceRound(events);
    const match = scoreGame(state.games[0]!, state);
    expect(match.kind).toBe("singles-match");
    expect((match as { thru: number }).thru).toBe(9);
    expect(resultOf(match)).toBeDefined();
  });

  it("still needs all eighteen when the round set out to play eighteen", () => {
    const events = backNineRound().map((e) => (e.kind === "round-created" ? { ...e, holes: "all" as const } : e));
    const state = reduceRound(events);
    expect(resultOf(scoreGame(state.games[0]!, state))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm -F @swng/domain vitest run src/scoring/nine.test.ts`
Expected: FAIL — `roundStrokeAllocation` takes two arguments; the skins game does not resolve.

- [ ] **Step 3: Thread the selection through `players.ts`**

Replace `packages/domain/src/scoring/players.ts` body:

```ts
import { findTeeSet, type Hole, type TeeSet } from "../course/card.js";
import { DomainError } from "../errors.js";
import type { GolferId } from "../ids.js";
import { intendedHoles } from "../round/holes.js";
import type { Participant } from "../round/participant.js";
import { cellAt } from "../round/state.js";
import type { RoundState } from "../round/state.js";

export interface PlayerTeeSet {
  readonly participant: Participant;
  readonly teeSet: TeeSet;
  // The holes THIS ROUND set out to play, off this player's own tee (spec 2026-08-02 §3c). Every
  // engine walks this, never `teeSet.holes` — the tee set describes the course, this describes the
  // round. Resolved once per player rather than per hole.
  readonly holes: readonly Hole[];
}

export const playerTeeSet = (state: RoundState, golferId: GolferId): PlayerTeeSet => {
  const participant = state.participants.find((p) => p.golferId === golferId);
  if (!participant) throw new DomainError("unknown-participant", `no participant ${golferId} joined this round`);
  const teeSet = findTeeSet(state.card, participant.tee);
  return { participant, teeSet, holes: intendedHoles(teeSet, state.holes) };
};

// True once every player has a recorded cell for every hole the ROUND set out to play — the shared
// "nothing left pending" predicate behind each per-player engine's `complete`.
export const allPlayersComplete = (state: RoundState, players: readonly GolferId[]): boolean =>
  players.every((golferId) => {
    const participant = state.participants.find((p) => p.golferId === golferId);
    if (!participant) return false;
    const holes = intendedHoles(findTeeSet(state.card, participant.tee), state.holes);
    return holes.every((hole) => cellAt(state.cells, golferId, hole.number) !== undefined);
  });
```

- [ ] **Step 4: Thread it through `allocation.ts`**

In `packages/domain/src/scoring/allocation.ts`, add the import `import { intendedHoles, type HoleSelection } from "../round/holes.js";`, then give both exported allocators a `selection` parameter and resolve the holes through it:

- `gameStrokeAllocation(config, participants, card, selection: HoleSelection)` — inside `dotsFor`, replace `dotsByHole(strokes, findTeeSet(card, p.tee))` with `dotsByHole(strokes, intendedHoles(findTeeSet(card, p.tee), selection))`.
- `roundStrokeAllocation(participants, card, selection: HoleSelection)` — replace `dotsByHole(p.strokes, findTeeSet(card, p.tee))` with `dotsByHole(p.strokes, intendedHoles(findTeeSet(card, p.tee), selection))`.

Add to `gameStrokeAllocation`'s doc comment:

```
// The dots are allocated over the holes the ROUND set out to play (spec 2026-08-02 §3c), so a nine
// hands out every stroke that was typed rather than the fraction that happens to fall on it.
```

- [ ] **Step 5: Update the five engines**

Each engine already destructures `playerTeeSet`. Change the destructure and the walk:

- `strokePlay.ts`: `const { teeSet } = playerTeeSet(state, golferId)` → `const { holes } = playerTeeSet(state, golferId)`; `for (const hole of teeSet.holes)` → `for (const hole of holes)`; the `parThru` line's `teeSet.holes.slice(0, thru)` → `holes.slice(0, thru)`. Pass the selection into the `gameStrokeAllocation` call: `gameStrokeAllocation(config, state.participants, state.card, state.holes)`.
- `stableford.ts`: same three changes (`{ teeSet }` → `{ holes }`, the `for` loop, the allocation call).
- `skins.ts`: the per-player map keeps `teeSet` only to supply the sequence — change it to `holes`, so `players[0]?.teeSet.holes ?? []` becomes `players[0]?.holes ?? []`. Pass the selection into `gameStrokeAllocation`.
- `singlesMatch.ts`: `const { teeSet: cardTeeSet } = playerTeeSet(state, config.a)` → `const { holes: cardHoles } = playerTeeSet(state, config.a)`; `const holeCount = cardTeeSet.holes.length` → `const holeCount = cardHoles.length`; `cardTeeSet.holes.map(...)` → `cardHoles.map(...)`; `cardTeeSet.holes.slice(0, ladder.thru)` → `cardHoles.slice(0, ladder.thru)`. Pass the selection into `gameStrokeAllocation`.
- `fourballMatch.ts`: the identical four changes.

- [ ] **Step 6: Fix the existing call sites in tests**

Run `pnpm -F @swng/domain vitest run` and update every direct `gameStrokeAllocation(...)` / `roundStrokeAllocation(...)` call in `allocation.test.ts` (and anywhere else the compiler flags) to pass `"all"` as the final argument. **Do not change any expected value** — passing `"all"` is exactly today's behaviour, and any moved number is a defect in Task 2 or this task.

- [ ] **Step 7: Run the domain suite**

Run: `pnpm -F @swng/domain vitest run`
Expected: PASS, including `nine.test.ts`.

- [ ] **Step 8: Validate and commit**

Run: `pnpm validate`

```bash
git add packages/domain/src/scoring/
git commit -m "feat(domain): every engine walks the holes the round set out to play"
```

---

### Task 4: Settle and record the nine

**Files:**
- Modify: `packages/domain/src/round/archive.ts` (`RoundArchive.holes?`, `settleRound`, `hasScoredHole`, `missingHolesFor`)
- Modify: `packages/domain/src/golfer/record.ts` (`archiveGolferLine`)
- Modify: `packages/domain/src/round/archive.test.ts`
- Modify: `packages/domain/src/golfer/record.test.ts`

**Interfaces:**
- Consumes: `intendedHoles`, `HoleSelection` (Task 1); `RoundState.holes`.
- Produces: `RoundArchive.holes?: HoleSelection` — present only when it is not `"all"`.

- [ ] **Step 1: Write the failing record tests**

Add to `packages/domain/src/golfer/record.test.ts`. Build the archives by **settling a real log**
rather than hand-authoring an archive literal — the literal would have to be kept in step with
`settleRound`'s own shape, and the point of these tests is what a settled round produces:

```ts
import { settleRound } from "../round/archive.js";

// An 18-hole card, par 4 throughout (par 72), conventional stroke-index split.
const eighteenCard: CourseCard = {
  courseName: "Casa Verde GC",
  teeSets: [
    {
      name: "white",
      holes: Array.from({ length: 18 }, (_, i) => ({
        number: i + 1,
        par: 4,
        yardage: 400,
        strokeIndex: i < 9 ? i * 2 + 1 : (i - 9) * 2 + 2,
      })),
    },
  ],
};

// Settles a finished round that SET OUT to play `selection` and scored `scoredHoles`, five strokes
// a hole. No games, so nothing blocks the settle.
const settledRound = (selection: HoleSelection, scoredHoles: readonly number[]) => {
  let n = 0;
  const env = (wallMs: number) => ({ opId: opId(`o-${n++}`), hlc: { wallMs, counter: 0, deviceId: deviceId("d1") }, authorId: A });
  const events: RoundEvent[] = [
    { ...env(1), kind: "round-created", roundId: roundId("r1"), card: eighteenCard, playedAtMs: 1, ...(selection !== "all" ? { holes: selection } : {}) },
    { ...env(2), kind: "participant-joined", participant: { golferId: A, name: "Ann", tee: "white", strokes: 0 } },
    { ...env(3), kind: "round-started" },
    ...scoredHoles.map((hole): RoundEvent => ({ ...env(10 + hole), kind: "score-recorded", golferId: A, hole, result: { kind: "strokes", strokes: 5 } })),
    { ...env(200), kind: "round-finalized" },
  ];
  return settleRound(events);
};

const BACK_NINE = [10, 11, 12, 13, 14, 15, 16, 17, 18];
const FIRST_THIRTEEN = Array.from({ length: 13 }, (_, i) => i + 1);

describe("a nine played on an 18-hole card (spec 2026-08-02 §4)", () => {
  it("records nine holes, that nine's par, and a real gross", () => {
    const line = archiveGolferLine(settledRound("back", BACK_NINE), A);
    expect(line.holes).toBe(9);
    expect(line.par).toBe(36);
    expect(line.holeResults).toHaveLength(9);
    expect(line.score).toBe(45);
  });

  // The no-regression pin (spec §5): a round that SET OUT to play eighteen and stopped after
  // thirteen is exactly what it is today — an eighteen-hole line with thirteen results and no
  // score. This arc must not touch it.
  it("leaves a short eighteen exactly as it is today", () => {
    const line = archiveGolferLine(settledRound("all", FIRST_THIRTEEN), A);
    expect(line.holes).toBe(18);
    expect(line.par).toBe(72);
    expect(line.holeResults).toHaveLength(13);
    expect(line.score).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm -F @swng/domain vitest run src/golfer/record.test.ts`
Expected: FAIL — the back-nine line reports `holes: 18`, `par: 72`, no score.

- [ ] **Step 3: Carry the selection into the archive**

In `packages/domain/src/round/archive.ts`, add the import and the field:

```ts
import { intendedHoles, type HoleSelection } from "./holes.js";
```

On `RoundArchive`, after `card`:

```ts
  // Which holes this round set out to play (spec 2026-08-02 §3a). Present ONLY when it is not
  // "all" — absence is the default and a true statement about every round settled before this
  // existed, so every stored snapshot deserializes and settles byte-identically.
  readonly holes?: HoleSelection;
```

In `settleRound`, resolve the played holes once and use them in `hasScoredHole`:

```ts
  const hasScoredHole = (entry: RosterEntry): boolean => {
    const holes = intendedHoles(findTeeSet(state.card, entry.tee), state.holes);
    return holes.some((hole) => cellAt(state.cells, entry.golferId, hole.number) !== undefined);
  };
```

and add the field to the returned literal, immediately after `card`, so the key order stays fixed:

```ts
    card: state.card,
    ...(state.holes !== "all" ? { holes: state.holes } : {}),
```

Change `missingHolesFor` to walk the intended holes:

```ts
const missingHolesFor = (state: RoundState, golfer: GolferId): readonly number[] => {
  const teeSet = state.card.teeSets[0];
  const holes = teeSet ? intendedHoles(teeSet, state.holes) : [];
  return holes.filter((hole) => cellAt(state.cells, golfer, hole.number) === undefined).map((hole) => hole.number);
};
```

- [ ] **Step 4: Derive the line from the intended holes**

In `packages/domain/src/golfer/record.ts`, add `import { intendedHoles } from "../round/holes.js";`, then in `archiveGolferLine` replace the tee-set walk with the intended holes:

```ts
  const teeSet = findTeeSet(archive.card, participant.tee);
  // The holes this round SET OUT to play (spec 2026-08-02 §4) — absent means the whole card, which
  // is what every round settled before this field existed had played.
  const holes = intendedHoles(teeSet, archive.holes ?? "all");
```

then `for (const hole of teeSet.holes)` → `for (const hole of holes)`, and in the line literal:

```ts
    holes: holes.length as 9 | 18,
    par: holes.reduce((sum, hole) => sum + hole.par, 0),
```

Update the `holes:` comment to say the count comes from the holes the round set out to play, still 9 or 18 by construction (`intendedHoles` returns either the whole card — validated 9 or 18 — or exactly one nine).

- [ ] **Step 5: Write the settle test**

Add to `packages/domain/src/round/archive.test.ts`:

Build both logs with that file's existing genesis/join/start/finalize fixtures — the only
difference between them is `holes: "front"` on the genesis of the first:

```ts
describe("holes on the archive (spec 2026-08-02 §3a)", () => {
  it("records the selection when the round played a nine", () => {
    const frontGenesis: RoundEvent = { ...genesis, holes: "front" };
    expect(settleRound([frontGenesis, joinA, started, finalized]).holes).toBe("front");
  });

  // The byte-identity pin: a whole-card round settles to exactly the archive it always did, with
  // no new key at all — which is what makes every stored snapshot deserialize unchanged.
  it("omits the key entirely for a whole-card round", () => {
    expect("holes" in settleRound([genesis, joinA, started, finalized])).toBe(false);
  });
});
```

- [ ] **Step 6: Run the domain suite**

Run: `pnpm -F @swng/domain vitest run`
Expected: PASS.

- [ ] **Step 7: Validate and commit**

Run: `pnpm validate`

```bash
git add packages/domain/src/round/archive.ts packages/domain/src/round/archive.test.ts \
  packages/domain/src/golfer/record.ts packages/domain/src/golfer/record.test.ts
git commit -m "feat(domain): a settled nine is a nine in the golfer's record"
```

---

### Task 5: The wire

**Files:**
- Modify: `packages/contracts/src/round.ts` (event schemas, archive schema)
- Modify: `packages/contracts/src/commands.ts` (`StartRoundRequest.holes`, `setHolesRequestSchema`)
- Modify: `packages/contracts/src/courses.ts` (`peekRoundResponseSchema.holes`)
- Modify: `packages/contracts/src/round.test.ts`, `commands.test.ts`, `courses.test.ts`

**Interfaces:**
- Consumes: `HoleSelection` from `@swng/domain`.
- Produces:
  - `holeSelectionSchema: z.ZodType<HoleSelection>`
  - `setHolesRequestSchema` / `SetHolesRequest` = `{ holes: HoleSelection }`
  - `SetHolesResponse` = `{ events: RoundEvent[] }` (same shape as `SetPlayedAtResponse`)
  - `StartRoundRequest.holes?: HoleSelection`
  - `PeekRoundResponse.holes?: HoleSelection`

- [ ] **Step 1: Write the failing contract tests**

Add to `packages/contracts/src/round.test.ts`. `roundTrips`, `parse` and `ContractError` already
exist in that file; `genesisEvent`, `envelopeFixture` and `archiveFixture` below are whatever that
file already calls its valid `round-created` event, its bare envelope, and its valid archive —
reuse them under their real names rather than adding new ones.

```ts
describe("holes on the wire (spec 2026-08-02)", () => {
  it("round-trips a genesis carrying a nine", () => {
    roundTrips(roundEventSchema, { ...genesisEvent, holes: "back" });
  });

  // The no-migration pin: a stored genesis with no `holes` key parses, and stays without one.
  it("parses a genesis with no holes and does not invent one", () => {
    const parsed = parse(roundEventSchema, genesisEvent);
    expect("holes" in parsed).toBe(false);
  });

  it("round-trips the correction event", () => {
    roundTrips(roundEventSchema, { ...envelopeFixture, kind: "round-holes-set", holes: "front" });
  });

  it("rejects a selection that is not one of the three", () => {
    expect(() => parse(roundEventSchema, { ...envelopeFixture, kind: "round-holes-set", holes: "middle" })).toThrow(ContractError);
  });

  it("round-trips an archive carrying a nine, and one without", () => {
    roundTrips(roundArchiveSchema, { ...archiveFixture, holes: "front" });
    const parsed = parse(roundArchiveSchema, archiveFixture);
    expect("holes" in parsed).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm -F @swng/contracts vitest run`
Expected: FAIL — unknown key `holes`, unknown event kind `round-holes-set`.

- [ ] **Step 3: Add the schemas**

In `packages/contracts/src/round.ts`, above the event union:

```ts
// Which holes the round set out to play (spec 2026-08-02 §3). Optional on the stored arms and on
// the archive: absence means the whole card, which is a TRUE statement about every round already
// stored, so nothing migrates.
export const holeSelectionSchema = z.enum(["all", "front", "back"]);
```

Add `holes: holeSelectionSchema.optional()` to the `round-created` object, add the new arm beside `round-played-at-set`:

```ts
  z.object({ ...envelope, kind: z.literal("round-holes-set"), holes: holeSelectionSchema }),
```

and add `holes: holeSelectionSchema.optional(),` to `roundArchiveSchemaImpl`, directly after `card`.

In `packages/contracts/src/commands.ts`:

```ts
  // spec 2026-08-02 §3a: absent means the whole card — exactly today's behaviour. A nine selection
  // against a card that has only one nine is rejected by the application layer, where the card is
  // already resolved; the wire cannot check it, because the wire does not hold the card.
  holes: holeSelectionSchema.optional(),
```

on `startRoundRequestSchema`, and beside `setPlayedAtRequestSchema`:

```ts
export const setHolesRequestSchema = z.object({ holes: holeSelectionSchema });
export type SetHolesRequest = z.infer<typeof setHolesRequestSchema>;
```

Add `SetHolesResponse` next to `SetPlayedAtResponse`, mirroring it exactly.

In `packages/contracts/src/courses.ts`, add `holes: holeSelectionSchema.optional(),` to `peekRoundResponseSchema`.

Both `commands.ts` and `courses.ts` need `import { holeSelectionSchema } from "./round.js";` — it is
defined once, in `round.ts`, beside the event union that is its primary consumer. Export it from
the package barrel too if that barrel re-exports schemas individually.

- [ ] **Step 4: Run the contracts suite**

Run: `pnpm -F @swng/contracts vitest run`
Expected: PASS.

- [ ] **Step 5: Validate and commit**

Run: `pnpm validate`

```bash
git add packages/contracts/src/
git commit -m "feat(contracts): the holes a round set out to play, on the wire"
```

---

### Task 6: Freeze it, correct it, route it

**Files:**
- Modify: `packages/application/src/rounds/startRound.ts`
- Create: `packages/application/src/rounds/setHoles.ts`
- Create: `packages/application/src/rounds/setHoles.test.ts`
- Modify: `packages/application/src/rounds/startRound.test.ts`
- Modify: `packages/application/src/rounds/peekRound.ts` (serve `holes`)
- Modify: `packages/application/src/index.ts` (export `setHoles`)
- Modify: `packages/lambda/src/compositionRoot.ts` (register the route)
- Modify: `apps/infra-cdk/lib/swngStack.ts` (`HTTP_ROUTES`)
- Modify: `apps/infra-cdk/test/swngStack.test.ts` (route-count pin)

**Interfaces:**
- Consumes: `setHolesRequestSchema`, `SetHolesRequest/Response` (Task 5); `intendedHoles` (Task 1).
- Produces: `setHoles` use case; `POST /rounds/{roundId}/holes` (participant auth).

- [ ] **Step 1: Write the failing use-case tests**

Create `packages/application/src/rounds/setHoles.test.ts`, modelled on `setPlayedAt.test.ts` (copy its harness verbatim):

```ts
describe("setHoles", () => {
  it("appends a round-holes-set while the round is live", async () => {
    const { events } = await setHoles(deps)(participantClaims, { holes: "front" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "round-holes-set", holes: "front" });
  });

  it("refuses a finalized round", async () => {
    await expect(setHoles(deps)(participantClaims, { holes: "front" })).rejects.toThrow(/round-not-live/);
  });

  it("refuses a caller who is not a participant", async () => {
    await expect(setHoles(deps)(strangerClaims, { holes: "front" })).rejects.toThrow(/not-a-participant/);
  });
});
```

And in `startRound.test.ts`:

```ts
it("freezes the chosen nine onto the genesis", async () => {
  const response = await startRound(deps)({ ...validCommand, holes: "back" }, claims);
  const genesis = response.events.find((e) => e.kind === "round-created");
  expect(genesis).toMatchObject({ holes: "back" });
});

it("omits the key when the round plays the whole card", async () => {
  const response = await startRound(deps)(validCommand, claims);
  const genesis = response.events.find((e) => e.kind === "round-created")!;
  expect("holes" in genesis).toBe(false);
});

// The one guard in the system: not because the value is dangerous — intendedHoles handles it —
// but so no round can be stored carrying a "Back 9" label its course cannot have.
it("rejects a nine selection against a card that has only one nine", async () => {
  await expect(startRound(nineHoleDeps)({ ...validCommand, holes: "back" }, claims)).rejects.toThrow(/holes-not-on-this-card/);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm -F @swng/application vitest run src/rounds/`
Expected: FAIL — no `setHoles` module; `startRound` ignores `holes`.

- [ ] **Step 3: Write `setHoles`**

Create `packages/application/src/rounds/setHoles.ts` as a verbatim structural copy of `setPlayedAt.ts`, with the event kind, request type and doc comment changed:

```ts
import type { SetHolesRequest, SetHolesResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { ParticipantClaims } from "../ports/tokenIssuer.js";
import { requireParticipant } from "../scoringPolicy.js";
import { loadRoundState } from "./loadRoundState.js";
import { createServerHlcSource, serverEnvelope } from "./serverEnvelope.js";

// The holes a round set out to play, corrected (spec 2026-08-02 §3b): going out for nine and
// playing on is the normal case, not the error case, and the alternative is scrapping a live round
// and re-entering it. A round-level fact, so unlike setStrokes there is no SUBJECT — the body
// carries only the new value and requireParticipant runs once, against the caller. Nothing scored
// is lost by a change: cells are keyed by hole number and the hole set is a filter over them.
//
// No card check here, deliberately: the only selection this could get wrong is a nine against a
// one-nine card, which intendedHoles resolves sensibly anyway, and re-resolving the course record
// mid-round to re-check it would buy nothing. startRound owns that guard.
export const setHoles =
  (deps: { journal: EventJournal; broadcast: Broadcast; clock: Clock; ids: IdGenerator }) =>
  async (claims: ParticipantClaims, request: SetHolesRequest): Promise<SetHolesResponse> => {
    const { state } = await loadRoundState(deps.journal, claims.roundId);
    requireParticipant(state, claims.golferId);
    if (state.status !== "live") throw new ApplicationError("round-not-live");

    const hlc = createServerHlcSource(deps.clock);
    const result = await deps.journal.append(claims.roundId, [
      { kind: "round-holes-set", holes: request.holes, ...serverEnvelope({ hlc, ids: deps.ids }, claims.golferId) },
    ]);
    await deps.broadcast.publish(claims.roundId, result.appended);
    return { events: result.appended };
  };
```

- [ ] **Step 4: Freeze it at creation, with the door check**

In `packages/application/src/rounds/startRound.ts`, after the existing `findTeeSet(record.card, command.host.tee)` line:

```ts
    // The one guard on this fact (spec 2026-08-02 §3): a nine selection needs a card that HAS two
    // nines. Checked here, at the one door where the card is already in hand, and never again —
    // intendedHoles is total, and a guard on a read path would make a stored round unreadable.
    const holes = command.holes ?? "all";
    if (holes !== "all" && findTeeSet(record.card, command.host.tee).holes.length <= 9) {
      throw new ApplicationError("holes-not-on-this-card", `this course has one nine; "${holes}" names a second`);
    }
```

If `ApplicationError`'s codes are enumerated anywhere (a union type, or the dispatcher's
code→status map), register `holes-not-on-this-card` there as a **400**. Grep for a neighbouring
creation-time code such as `card-superseded` and follow it to every place it is listed.

and on the `round-created` literal, add:

```ts
        // Present only when it is not "all" (spec §3a) — absence is the default and keeps every
        // whole-card round's genesis byte-identical to the ones written before this existed.
        ...(holes !== "all" ? { holes } : {}),
```

- [ ] **Step 5: Serve it on the peek**

In `packages/application/src/rounds/peekRound.ts`, add `...(state.holes !== "all" ? { holes: state.holes } : {})` to the response literal, so the join screen can name the nine before a tee is chosen.

- [ ] **Step 6: Register the route**

In `packages/lambda/src/compositionRoot.ts`, beside the `/rounds/{roundId}/played-at` entry, add the `/rounds/{roundId}/holes` route: participant auth, `setHolesRequestSchema`, `setHoles(deps)`. Copy the played-at entry exactly and change the four names.

In `apps/infra-cdk/lib/swngStack.ts`, add to `HTTP_ROUTES`:

```ts
  { method: HttpMethod.POST, path: "/rounds/{roundId}/holes" },
```

**Do not** add it to the tightened-throttle set — this is participant-auth, like `/played-at` and `/strokes`. Update the route-count comment above `HTTP_ROUTES` and the count assertion in `apps/infra-cdk/test/swngStack.test.ts` (40 → 41 HTTP).

- [ ] **Step 7: Run the suites**

Run: `pnpm -F @swng/application vitest run && pnpm -F @swng/lambda vitest run && pnpm -F @swng/infra-cdk vitest run`
Expected: PASS.

- [ ] **Step 8: Validate and commit**

Run: `pnpm validate`

```bash
git add packages/application/src/ packages/lambda/src/ apps/infra-cdk/
git commit -m "feat(application,lambda,infra): POST /rounds/{roundId}/holes"
```

---

### Task 7: The card draws the holes being played

**Files:**
- Modify: `packages/client/src/scoring.ts` (re-export `intendedHoles`)
- Modify: `eslint.config.mjs` (banlist + fence)
- Modify: `apps/web/src/round/ScorecardGrid.tsx` (`canonicalHoles`)
- Modify: `apps/web/src/round/ResultsView.tsx`
- Modify: `apps/web/src/round/ScorecardGrid.test.tsx`
- Modify: any caller of `canonicalHoles` the compiler flags

**Interfaces:**
- Consumes: `intendedHoles`, `HoleSelection` (Task 1), via `@swng/client`.
- Produces: `canonicalHoles(card, selection: HoleSelection): readonly Hole[]`

- [ ] **Step 1: Write the failing grid test**

Add to `apps/web/src/round/ScorecardGrid.test.tsx`. `backNineState` is that file's existing folded
`RoundState` fixture with `holes: "back"` and an 18-hole card; `gridProps` is whatever prop bundle
its neighbouring tests already pass. Build them from the file's own idioms.

```tsx
it("draws only the nine the round set out to play", () => {
  render(<ScorecardGrid state={{ ...backNineState }} {...gridProps} />);
  expect(screen.queryByRole("columnheader", { name: /^9$/ })).toBeNull();
  expect(screen.getByRole("columnheader", { name: /^10$/ })).toBeTruthy();
  // One unambiguous total row, exactly as a nine-hole card already renders — no OUT/IN.
  expect(screen.queryByLabelText("OUT")).toBeNull();
  expect(screen.getByLabelText("TOT")).toBeTruthy();
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm -F @swng/web vitest run src/round/ScorecardGrid.test.tsx`
Expected: FAIL — all eighteen columns render.

- [ ] **Step 3: Re-export and fence**

In `packages/client/src/scoring.ts`, add `intendedHoles` to the `export { ... } from "@swng/domain"` block, and add a note above it:

```
// `intendedHoles` (spec 2026-08-02 §3c) is the round's own hole list — which holes it set out to
// play, off a given tee. The grid and the results headline both need it to draw and total the right
// holes; it is golf compute, so it comes through here and is banned from direct import below.
```

In `eslint.config.mjs`, add `"intendedHoles"` to the `@typescript-eslint/no-restricted-imports` name banlist (the array containing `"roundStrokeAllocation"`, `"allocateStrokes"`).

- [ ] **Step 4: Give the grid the selection**

In `apps/web/src/round/ScorecardGrid.tsx`:

```tsx
// The hole numbering/par/SI for the grid's rows: the holes THIS ROUND set out to play, off the
// canonical first tee set (real courses keep these identical across tees — only yardage/rating/
// slope vary). Exported: ResultsView's "Final totals" headline reuses this SAME list rather than
// re-deciding which holes make up the round a second way.
export const canonicalHoles = (card: CourseCard, selection: HoleSelection): readonly Hole[] => {
  const teeSet = card.teeSets[0];
  return teeSet ? intendedHoles(teeSet, selection) : [];
};
```

Update its call site inside the component to pass `state.holes`, and update `ResultsView.tsx`'s call the same way. The OUT/IN/TOT segment logic needs no change: it already collapses to a single TOT row when no hole numbers exceed 9 — but the back nine is all above 9, so change the split to be positional rather than numeric:

```tsx
  // OUT / IN only mean anything when the round plays two nines. A round that set out to play ONE
  // nine gets the single unambiguous TOT row, exactly as a nine-hole card already does — and the
  // back nine must take that path too, so the split is by COUNT, not by hole number.
  const outHoles = holes.slice(0, 9);
  const inHoles = holes.slice(9);
```

- [ ] **Step 5: Run the web suite**

Run: `pnpm -F @swng/web vitest run`
Expected: PASS. Fix any caller the compiler flags by threading `state.holes` through.

- [ ] **Step 6: Validate and commit**

Run: `pnpm validate`

```bash
git add packages/client/src/scoring.ts eslint.config.mjs apps/web/src/round/
git commit -m "feat(web): the card draws the holes the round set out to play"
```

---

### Task 8: Choosing it, and changing your mind

**Files:**
- Modify: `apps/web/src/routes/CreateRoundPage.tsx`
- Modify: `apps/web/src/routes/CreateRoundPage.test.tsx`
- Modify: `apps/web/src/routes/RoundPage.tsx`
- Modify: `apps/web/src/routes/RoundPage.test.tsx`
- Modify: `apps/web/src/api/rounds.ts` (or wherever `setPlayedAt` client call lives — add `setHoles`)

**Interfaces:**
- Consumes: `POST /rounds/{roundId}/holes` (Task 6); `state.holes` (Task 1).

- [ ] **Step 1: Write the failing create-form tests**

`renderCreateRoundPage`, `eighteenHoleCourse`, `nineHoleCourse` and the `createRound` mock are that
file's existing harness — reuse them under their real names, adding a nine-hole course fixture if
none exists. Same for `frontNineState` and the `setHolesApi` mock in the round-page test below.

```tsx
it("offers the three choices at an 18-hole course, defaulting to 18", () => {
  renderCreateRoundPage({ course: eighteenHoleCourse });
  expect(screen.getByRole("radio", { name: /18 holes/i })).toBeChecked();
  expect(screen.getByRole("radio", { name: /front 9/i })).toBeTruthy();
  expect(screen.getByRole("radio", { name: /back 9/i })).toBeTruthy();
});

it("asks nothing at a nine-hole course", () => {
  renderCreateRoundPage({ course: nineHoleCourse });
  expect(screen.queryByRole("radio", { name: /front 9/i })).toBeNull();
});

it("submits the chosen nine", async () => {
  renderCreateRoundPage({ course: eighteenHoleCourse });
  fireEvent.click(screen.getByRole("radio", { name: /back 9/i }));
  fireEvent.click(screen.getByRole("button", { name: /start round/i }));
  await waitFor(() => expect(createRound).toHaveBeenCalledWith(expect.objectContaining({ holes: "back" }), expect.anything()));
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm -F @swng/web vitest run src/routes/CreateRoundPage.test.tsx`
Expected: FAIL — no such control.

- [ ] **Step 3: Add the control**

In `CreateRoundPage.tsx`, add `const [holes, setHoles] = useState<HoleSelection>("all");` and, directly below the tee picker, a radio group rendered **only** when the selected card's first tee set has 18 holes:

```tsx
{selectedCardHoleCount === 18 && (
  <fieldset className="flex flex-col gap-1">
    <legend className={eyebrow}>Holes</legend>
    <div className="flex gap-2">
      {([["all", "18 holes"], ["front", "Front 9"], ["back", "Back 9"]] as const).map(([value, label]) => (
        <label key={value} className="flex items-center gap-1">
          <input type="radio" name="holes" value={value} checked={holes === value} onChange={() => setHoles(value)} />
          {label}
        </label>
      ))}
    </div>
  </fieldset>
)}
```

Reset it to `"all"` wherever the course changes (the same effect that re-seeds `tee`), and add `holes` to the `createRound({...})` payload — omitting the key when it is `"all"`:

```tsx
...(holes !== "all" ? { holes } : {}),
```

- [ ] **Step 4: Write the failing round-page test**

```tsx
it("changes the holes mid-round with one post, then re-syncs", async () => {
  renderRoundPage({ state: frontNineState });
  fireEvent.click(screen.getByRole("button", { name: /edit holes/i }));
  fireEvent.click(screen.getByRole("radio", { name: /18 holes/i }));
  fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
  await waitFor(() => expect(setHolesApi).toHaveBeenCalledTimes(1));
  expect(setHolesApi).toHaveBeenCalledWith(expect.anything(), { holes: "all" }, expect.anything());
});
```

- [ ] **Step 5: Add the round-page affordance**

In `RoundPage.tsx`, beside the played-date row, render the current selection (`18 holes` / `Front 9` / `Back 9`) with an **Edit** button, following the roster-strokes-editor idiom exactly: Edit swaps the static value for the same radio group, Save is `btnSecondary`, the call is api-then-`sync()` with no optimistic write, and the control is shown only while the round is live and only when the card has 18 holes. Add one teaching line: *"Changing this redraws the card. Nothing you've scored is lost."*

- [ ] **Step 6: Run the web suite**

Run: `pnpm -F @swng/web vitest run`
Expected: PASS.

- [ ] **Step 7: Validate and commit**

Run: `pnpm validate`

```bash
git add apps/web/src/
git commit -m "feat(web): choose the holes at creation, change them while you play"
```

---

### Task 9: The field gate

**Files:**
- Create: `apps/web/e2e/nineHoles.spec.ts`
- Modify: `apps/web/e2e/helpers/*` only if a helper genuinely lacks a capability

**Interfaces:**
- Consumes: the whole stack, live against beta.

- [ ] **Step 1: Write the spec**

Create `apps/web/e2e/nineHoles.spec.ts`, following `handicapCorrection.spec.ts`'s structure (real accounts via `USER_PASSWORD_AUTH`, ndjson-tracked teardown). One story, four assertions:

1. Create a round at an 18-hole course, choosing **Back 9**.
2. Set a player's strokes to 5, and assert the card shows **five dots**, all on holes 10–18 — the defect this arc exists to fix. Derive the expected holes from the seeded course's own stroke indexes; do not hard-code hole numbers against a course the test did not seed.
3. Score the nine for both players with a net skins game added, and finalize **without** reaching for "End unfinished games & finalize" — the game must resolve on its own.
4. Assert the history row reads nine holes with its gross, and that the profile's Best 9 names this round.

- [ ] **Step 2: Reconcile locators against the JSX**

Open `CreateRoundPage.tsx` and `RoundPage.tsx` and check every locator the new spec uses resolves by accessible name against the real markup. String-level breakage is invisible to typecheck — this repo has been bitten by it twice.

- [ ] **Step 3: Run it**

Run: `pnpm e2e:field -- nineHoles.spec.ts` (requires AWS credentials and a deployed beta; this runs at close-out, after the deploy).

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/nineHoles.spec.ts
git commit -m "test(e2e): a back nine, played and recorded"
```

---

## Close-out (controller-run)

Not a task — the controller runs this after Task 9, in this order:

1. `pnpm validate` (exit 0) and `pnpm test:contract`.
2. **`pnpm deploy:beta` — LAMBDA-FIRST, required.** `startRoundRequestSchema` is not `.strict()`, so a new bundle posting `holes` to an old lambda has the field silently stripped: the golfer picks Front 9 and gets an eighteen-hole round with no error anywhere. The reverse is inert.
3. `pnpm publish:web:beta`, and curl the bundle to confirm it is served.
4. `pnpm e2e:beta` ×2, then the full `pnpm e2e:field`.
5. An adversarial USE pass on deployed `beta.swng.golf` at phone width: play a **back nine** at an 18-hole course whose stroke indexes are known, and read the screenshots as artifacts — every typed stroke drawn as a dot on the right holes, a game settling on the nine, the finalize dialog naming nothing spurious, and the history row reading nine holes. Then change a live round from Front 9 to 18 and confirm the previously-scored holes are still there.
6. **No wipe, no migration, no `rebuildProjections`.**
