# M2 — Full v1 Game Menu + Handicap Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** All five v1 formats scoring concurrently over one card, WHS-faithful handicap math verified against published examples, and deterministic settlement into the immutable `RoundArchive`.

**Architecture:** `docs/architecture.md` §1–2. New formats are union members + reducers; `GameResult` lands as the settlement currency; `settleRound(events)` writes the archive that every projection replays. All work in pure `@swng/domain`.

**Tech stack:** unchanged — TypeScript strict, Vitest 4, fast-check 4, zero runtime deps in domain.

## Global Constraints

- Work directly on `main`; `pnpm validate` (lint + typecheck + build + test) green at every commit; run the domain suite twice before each commit (property-flake check).
- Every commit message ends with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- TDD; brief test code verbatim; domain imports nothing; fixtures are TS modules; comment the why only.
- Golden fixtures reuse `fixtureLinks`/`fixtureWhite` (9-hole, pars [4,4,3,5,4,3,4,5,4], SI [5,1,9,3,7,8,2,4,6], rating 35.8, slope 128) and the standing cast: **Ann ch 8, Bo ch 2, Cal ch 12, Dee ch 5**.
- **Design decisions fixed by this plan** (do not relitigate):
  - `thru` semantics: medal-family formats (stroke play, stableford, skins tallies) count decided holes anywhere on the card; **match-family formats count the decided prefix** (matches are sequential; a gap pauses the ladder). Recorded as a why-comment on the ladder.
  - Default allowances: stableford 0.95 (WHS individual), fourball match 0.90 **relative to the lowest playing handicap** (all four reduced by the low man's), skins 1.0 (full handicap, net).
  - Stableford points per hole: `max(0, 2 + par − net)`; picked-up/conceded = 0 points.
  - Skins: outright lowest net wins the hole's skin plus all carried; any tie carries; picked-up/conceded is out of the hole; pot left carrying at the last decided hole reports as `carriedOut`. No validation variants in v1 (v1.1 config).
  - Fourball: best net ball per side; a picked-up/conceded player is out of the hole; a side with no ball loses the hole if the other side has one, halves if neither does.
  - `GameResult` is a discriminated union extracted from a **complete** `GameState` by `resultOf(state): GameResult | undefined` (undefined until the game is resolved). Settlement consumes only `GameResult`.
  - `settleRound(events: readonly RoundEvent[]): RoundArchive` — takes the LOG (the archive embeds it), reduces internally, throws `DomainError("round-not-final")` unless status is `final` and `DomainError("game-unresolved")` if any game's `resultOf` is undefined. **Archive event order is the domain canonical order** (deterministic before/without server acks; `seq` is envelope metadata and never flows into the archive's identity). No wall-clock anywhere — the caller stamps time outside the domain.
  - Differentials only for golfers with every hole decided (picked-up/conceded decide a hole; a missing cell does not); otherwise the archive records `{ kind: "incomplete" }` for that golfer. No PCC, no soft/hard caps, no ESR in v1 (documented honest-unofficial deviations).

---

### Task 1: Foundations — GameResult, the match ladder, bench upgrades

**Files:**
- Create: `packages/domain/src/scoring/result.ts`, `packages/domain/src/scoring/matchLadder.ts`
- Modify: `packages/domain/src/scoring/singlesMatch.ts` (refactor over the ladder — behavior frozen by existing tests), `packages/domain/src/scoring/golden/deck.ts` (score `state.games`, not the caller's array), `packages/domain/src/round/state.properties.test.ts` (generator gains `participant-joined`/`game-added` arbitraries), `packages/domain/src/index.ts`
- Test: `packages/domain/src/scoring/result.test.ts`, `packages/domain/src/scoring/matchLadder.test.ts`

**Interfaces (produced — every later task consumes these exact names):**

```ts
// matchLadder.ts — the shared match-progress core. Input: per-hole winners in card order,
// undefined = not yet decided. The ladder stops at the first undefined (decided prefix —
// matches are sequential) and ignores holes after closeout.
export type HoleWinner = "a" | "b" | "halved";
export interface LadderState {
  readonly up: number;              // magnitude; 0 = all square
  readonly leader?: "a" | "b";      // absent when up === 0
  readonly thru: number;            // decided prefix length
  readonly remaining: number;       // totalHoles − thru
  readonly dormie: boolean;         // up === remaining && remaining > 0
  readonly outcome?: MatchOutcomeAB;
}
export type MatchOutcomeAB = { readonly winner: "a" | "b"; readonly closing: string } | { readonly halved: true };
export const matchLadder: (winners: readonly (HoleWinner | undefined)[], totalHoles: number) => LadderState;

// result.ts — the settlement currency.
export type GameResult =
  | { readonly kind: "stroke-play"; readonly id: GameId; readonly scoring: "gross" | "net"; readonly lines: readonly StrokePlayLine[] }
  | { readonly kind: "singles-match"; readonly id: GameId; readonly outcome: MatchOutcome; readonly thru: number }
  | { readonly kind: "stableford"; readonly id: GameId; readonly points: readonly { golferId: GolferId; points: number }[] }
  | { readonly kind: "fourball-match"; readonly id: GameId; readonly outcome: FourballOutcome; readonly thru: number }
  | { readonly kind: "skins"; readonly id: GameId; readonly won: readonly { golferId: GolferId; skins: number }[]; readonly carriedOut: number };
export const resultOf: (state: GameState) => GameResult | undefined;
// resolved when: stroke-play/stableford complete === true; match outcome !== undefined;
// skins complete === true.
```

NOTE: the union above is the END state. Task 1 lands only the `stroke-play` and
`singles-match` members (the formats that exist); Tasks 2–4 each add their member and
`resultOf` case alongside their engine. `FourballOutcome` is declared in Task 3.

**Ladder closeout rules (frozen by M1's singles tests):** outcome when `up > remaining` → `` `${up}&${remaining}` ``; when `remaining === 0` and `up > 0` → `` `${up} up` `` (checked FIRST — M1's ordering bug); when `remaining === 0` and `up === 0` → `{ halved: true }`.

- [ ] **Step 1: Write failing `matchLadder.test.ts`** — cases: `["a","a","halved","a"]` over 9 → up 3 thru 4 remaining 5, no outcome; a 3-up-thru-7-of-9 sequence → `"3&2"`; level-thru-8 then `"a"` → `"1 up"`; nine decided level → halved; `["a", undefined, "a"]` → thru 1 (prefix stops at the gap); dormie at up 2 remaining 2; winners after closeout ignored.
- [ ] **Step 2: RED**, implement `matchLadder.ts`, **GREEN.**
- [ ] **Step 3: Refactor `singlesMatch.ts`** to compute per-hole `HoleWinner | undefined` (net comparison, picked-up/conceded loses, both → halved, either cell missing → undefined) and delegate to `matchLadder`, mapping `"a"/"b"` back to golfer ids. The existing `singlesMatch.test.ts` must pass UNCHANGED — it is the refactor's safety net.
- [ ] **Step 4: `result.ts` + failing tests**: `resultOf` on a complete stroke-play state returns lines; on a mid-round state returns undefined; on a closed match returns outcome+thru. Implement; GREEN.
- [ ] **Step 5: Bench upgrades.** `deck.ts`: score `state.games` (behavior-neutral — hlc order matches insertion; existing decks prove it). `state.properties.test.ts`: add `participant-joined` (2–3 golfers, varying courseHandicap) and `game-added` arbitraries into the shuffled event pool so the convergence properties exercise `firstHlc` roster ordering and game maps.
- [ ] **Step 6:** barrel exports; `pnpm validate`; domain suite ×2; commit:

```bash
git commit -m "feat(domain): GameResult settlement currency, shared match ladder, convergence bench upgrades

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Stableford engine + golden deck

**Files:**
- Create: `packages/domain/src/scoring/stableford.ts`
- Modify: `packages/domain/src/scoring/game.ts` (config + state union members + dispatch), `result.ts` (resultOf case), `allowances.ts` (default 0.95), `packages/domain/src/index.ts`
- Test: `packages/domain/src/scoring/stableford.test.ts`

**Interfaces:**

```ts
// GameConfig member
{ readonly kind: "stableford"; readonly id: GameId; readonly players: readonly GolferId[]; readonly allowance?: number }
// GameState member
{ readonly kind: "stableford"; readonly id: GameId; readonly lines: readonly { golferId: GolferId; thru: number; points: number }[]; readonly complete: boolean }
```

Semantics: per decided hole, `points = max(0, 2 + par − net)` with net = strokes − dots (dots via `dotsByHole(playingHandicap(ch, allowance ?? 0.95), teeSet)`); picked-up/conceded = 0. `thru` counts decided holes anywhere (medal family). `complete` = all players all holes.

- [ ] **Step 1: Failing golden test** (complete file):

```ts
import { describe, expect, it } from "vitest";
import { gameId, golferId } from "../ids.js";
import { playGoldenRound } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";

const A = golferId("ann");
const B = golferId("bo");
const players = [
  { golferId: A, name: "Ann", tee: "white", courseHandicap: 8 },
  { golferId: B, name: "Bo", tee: "white", courseHandicap: 2 },
];
const game = { kind: "stableford", id: gameId("s1"), players: [A, B] } as const;

describe("stableford — golden cards", () => {
  it("standard points with a pickup scoring zero: Ann 15, Bo 19", () => {
    // Ann (8 dots, all but SI9/h3): nets 4,5,3,PU,4,3,4,5,4 → pts 2,1,2,0,2,2,2,2,2 = 15
    // Bo (dots h2,h7): nets 4,3,3,5,5,3,3,5,4 → pts 2,3,2,2,1,2,3,2,2 = 19
    const [state] = playGoldenRound(fixtureLinks, players, [game], {
      [A]: [5, 6, 3, "picked-up", 5, 4, 5, 6, 5],
      [B]: [4, 4, 3, 5, 5, 3, 4, 5, 4],
    });
    expect(state).toMatchObject({
      kind: "stableford", complete: true,
      lines: [
        { golferId: A, thru: 9, points: 15 },
        { golferId: B, thru: 9, points: 19 },
      ],
    });
  });

  it("mid-round points run over decided holes only", () => {
    const [state] = playGoldenRound(fixtureLinks, players, [game], { [A]: [5, 6], [B]: [4] });
    expect(state).toMatchObject({
      complete: false,
      lines: [{ golferId: A, thru: 2, points: 3 }, { golferId: B, thru: 1, points: 2 }],
    });
  });
});
```

- [ ] **Step 2: RED → implement → GREEN**; `resultOf` case + test (complete stableford → points array). `pnpm validate`; suite ×2; commit (`feat(domain): stableford engine with golden deck`, trailer as always).

---

### Task 3: Fourball match engine + golden deck

**Files:**
- Create: `packages/domain/src/scoring/fourballMatch.ts`
- Modify: `game.ts`, `result.ts`, `allowances.ts` (0.90), barrel
- Test: `packages/domain/src/scoring/fourballMatch.test.ts`

**Interfaces:**

```ts
// GameConfig member — sides are pairs
{ readonly kind: "fourball-match"; readonly id: GameId; readonly a: readonly [GolferId, GolferId]; readonly b: readonly [GolferId, GolferId]; readonly allowance?: number }
// GameState member
{ readonly kind: "fourball-match"; readonly id: GameId; readonly up: number; readonly leader?: "a" | "b"; readonly thru: number; readonly remaining: number; readonly dormie: boolean; readonly outcome?: FourballOutcome }
export type FourballOutcome = { readonly winner: "a" | "b"; readonly closing: string } | { readonly halved: true };
```

Handicapping (fixed): each player's playing handicap = `roundHalfUp(ch × (allowance ?? 0.9))`; subtract the LOWEST playing handicap from all four; dots per player via `dotsByHole(relative, teeSet)`. Cast: Ann 8→7, Bo 2→2, Cal 12→11, Dee 5→5 (rounded at 90%); low man Bo → relative Ann 5, Bo 0, Cal 9, Dee 3 → dots: Ann on SI 1–5 (holes 1,2,4,7,8), Cal on all nine, Dee on SI 1–3 (holes 2,4,7). Per hole: side's best net among players with a decided non-pickup ball; a hole is decided when all four cells exist; winner fed to `matchLadder`.

- [ ] **Step 1: Failing golden test** (complete file):

```ts
import { describe, expect, it } from "vitest";
import { gameId, golferId } from "../ids.js";
import { playGoldenRound } from "./golden/deck.js";
import { fixtureLinks } from "./golden/fixtureCourse.js";

const A = golferId("ann"); const B = golferId("bo");
const C = golferId("cal"); const D = golferId("dee");
const players = [
  { golferId: A, name: "Ann", tee: "white", courseHandicap: 8 },
  { golferId: B, name: "Bo", tee: "white", courseHandicap: 2 },
  { golferId: C, name: "Cal", tee: "white", courseHandicap: 12 },
  { golferId: D, name: "Dee", tee: "white", courseHandicap: 5 },
];
const game = { kind: "fourball-match", id: gameId("f1"), a: [A, B], b: [C, D] } as const;

describe("fourball match — golden cards", () => {
  it("90% relative strokes, best ball per side, pickup drops one ball: side A wins 3&1", () => {
    // Relative playing hcps: Ann 5, Bo 0, Cal 9, Dee 3.
    // h1–h4 halved (best nets 4/4, 4/4, 3/3, 5/5); h5 A (4 vs 5); h6 halved (3/3);
    // h7 A (4 vs 5); h8: Dee picks up, Cal's net 6 vs A's best 5 → A, 3 up with 1 to play → 3&1.
    const [state] = playGoldenRound(fixtureLinks, players, [game], {
      [A]: [5, 5, 3, 6, 4, 4, 6, 6],
      [B]: [4, 5, 4, 5, 5, 3, 4, 6],
      [C]: [5, 6, 4, 7, 6, 4, 6, 7],
      [D]: [5, 5, 4, 6, 5, 4, 6, "picked-up"],
    });
    expect(state).toMatchObject({
      kind: "fourball-match", up: 3, leader: "a", thru: 8, remaining: 1, dormie: false,
      outcome: { winner: "a", closing: "3&1" },
    });
  });
});
```

**IMPLEMENTER MUST VERIFY the card hole-by-hole against the dot allocations before implementing** (the plan author verified: h1 A-best 4 = Ann 5−1, B-best 4 = Cal 5−1; …; if you find a discrepancy, STOP and report your working — do not change the test).

- [ ] **Step 2: RED → implement over `matchLadder` → GREEN**; `resultOf` case + test. `pnpm validate`; suite ×2; commit (`feat(domain): fourball best-ball match engine over the shared ladder`).

---

### Task 4: Skins engine + concurrency deck

**Files:**
- Create: `packages/domain/src/scoring/skins.ts`
- Modify: `game.ts`, `result.ts`, `allowances.ts` (1.0), barrel
- Test: `packages/domain/src/scoring/skins.test.ts`, `packages/domain/src/scoring/concurrent.test.ts`

**Interfaces:**

```ts
// GameConfig member
{ readonly kind: "skins"; readonly id: GameId; readonly players: readonly GolferId[]; readonly allowance?: number }
// GameState member
{ readonly kind: "skins"; readonly id: GameId;
  readonly lines: readonly { golferId: GolferId; skins: number }[];
  readonly carrying: number;        // pot riding into the next undecided hole
  readonly carriedOut: number;      // pot stranded after the last hole (complete only)
  readonly complete: boolean }
```

Semantics: full-handicap net (allowance 1.0). Holes in card order; a hole is decided when every player has a cell; pot = 1 + carried; outright lowest net takes the pot, tie carries; picked-up/conceded is out of the hole (all out → carry). Skins settle sequentially, so processing stops at the first undecided hole (same decided-prefix rule as the ladder — the carryover chain cannot skip a hole).

- [ ] **Step 1: Failing golden test** — cast Ann(8 dots, all but h3), Bo(h2,h7), Cal ch12 → 12 dots (all nine + extras on SI≤3: h2,h4,h7):

```ts
const game = { kind: "skins", id: gameId("k1"), players: [A, B, C] } as const;

it("carryovers chain, outright net wins the pot, pickup is out: Ann 6, Bo 3", () => {
  // nets — Ann: 4,4,4,5,4,3,4,5,PU  Bo: 4,4,3,6,4,4,3,5,4  Cal: 5,5,3,6,5,4,4,6,5
  // h1 tie(A,B) carry→2; h2 tie(A,B) carry→3; h3 tie(B,C) carry→4; h4 Ann takes 4;
  // h5 tie(A,B) carry→2; h6 Ann takes 2; h7 Bo takes 1; h8 tie(A,B) carry→2; h9 Bo takes 2.
  const [state] = playGoldenRound(fixtureLinks, players3, [game], {
    [A]: [5, 5, 4, 6, 5, 4, 5, 6, "picked-up"],
    [B]: [4, 5, 3, 6, 4, 4, 4, 5, 4],
    [C]: [6, 7, 4, 8, 6, 5, 6, 7, 6],
  });
  expect(state).toMatchObject({
    kind: "skins", complete: true, carrying: 0, carriedOut: 0,
    lines: [
      { golferId: A, skins: 6 },
      { golferId: B, skins: 3 },
      { golferId: C, skins: 0 },
    ],
  });
});
```

Plus: a mid-round card asserting `carrying` > 0 and `complete: false`; and a card ending on a tie asserting `carriedOut`.

- [ ] **Step 2: RED → implement → GREEN**; `resultOf` case.
- [ ] **Step 3: The concurrency deck** (`concurrent.test.ts`) — the milestone's headline claim. Same log, TWO games with DIFFERENT handicapping over one set of strokes: the skins card above plus `{ kind: "stableford", id: "s9", players: [A, B, C] }` (Cal at 95% → 11 dots: all nine + extras h2, h7). Assert pre-correction: skins Ann 6 / Bo 3 / Cal 0; stableford Ann 15 / Bo 17 / Cal 10 (plan-author verified, corrected during execution — Bo h9 gross is 4: Bo pts 2,2,2,1,2,1,3,2,2; Cal nets 5,5,3,7,5,4,4,6,5 → pts 1,1,2,0,1,1,2,1,1). Then append ONE correcting `score-recorded` (later hlc): Ann h9 picked-up → 4 gross. Assert BOTH games recompute from the same cell write: skins Ann 8 / Bo 1 / Cal 0; stableford Ann 18 / Bo 17 / Cal 10. This test must construct the correction as a raw event appended to the deck's log (extend `playGoldenRound` with an optional `corrections` parameter carrying later-hlc score events — additive, existing decks untouched).
- [ ] **Step 4:** `pnpm validate`; suite ×2; commit (`feat(domain): skins with carryovers; concurrent-games deck proves one log, many games`).

---

### Task 5: The handicap engine

**Files:**
- Create: `packages/domain/src/handicap/whs.ts`, `packages/domain/src/handicap/expected.ts`
- Modify: barrel
- Test: `packages/domain/src/handicap/whs.test.ts` (+ `whs.properties.test.ts`)

**Interfaces:**

```ts
export const adjustedGrossScore: (teeSet: TeeSet, courseHandicap: number, holes: ReadonlyMap<number, HoleResult>) => number;
  // per hole: min(strokes, netDoubleBogey(par, dots)); picked-up/conceded count AT net double bogey.
  // Throws DomainError("holes-undecided") if any tee-set hole lacks a result.
export const scoreDifferential: (teeSet: TeeSet, ags: number) => number;          // (113/slope) × (AGS − rating), unrounded
export const eighteenFromNine: (nineDifferential: number, currentIndex: number) => number; // 9-hole SD + expected second-9 (WHS 2024)
export const computeIndex: (differentials: readonly number[]) => number | undefined; // most recent ≤20; best-8 avg per the WHS small-sample table; undefined under 3 scores; result rounded to 0.1
export const courseHandicapFor: (index: number, teeSet: TeeSet) => number;        // roundHalfUp(index × slope/113 + (rating − par))
```

- [ ] **Step 1 — MANDATORY SOURCE VERIFICATION.** Before writing tests: WebSearch the current USGA/R&A WHS references and pin, with cited URLs in your report: (a) the small-sample adjustment table (3 scores → lowest −2.0 … 20 → average of best 8), (b) the 2024 9-hole rule (18-hole SD = 9-hole SD + expected differential from the player's index) and its expected-differential formula/table, (c) at least two published worked examples for differentials and one for an index computation. **The plan deliberately does not supply these constants from memory — the verified sources are the spec.** If the 9-hole expected-differential source cannot be verified, STOP and report BLOCKED with what you found.
- [ ] **Step 2: Failing conformance tests** pinned to the verified worked examples (cite each source in a test comment), plus fixture-course cases: AGS on `fixtureWhite` for Ann's net golden card (pickup capped at NDB), differential arithmetic `(113/128) × (AGS − 35.8)`, `courseHandicapFor` round-trip. Property tests: index is within [min, max] of its differentials; adding a worse 21st score never raises the index once 20 exist; AGS ≤ raw gross sum when no pickups.
- [ ] **Step 3: RED → implement → GREEN.** `pnpm validate`; suite ×2; commit (`feat(domain): WHS handicap engine verified against published worked examples`).

---

### Task 6: settleRound — the immutable archive

**Files:**
- Create: `packages/domain/src/round/archive.ts`
- Modify: barrel
- Test: `packages/domain/src/round/archive.test.ts`

**Interfaces:**

```ts
export interface RoundArchive {
  readonly roundId: RoundId;
  readonly card: CourseCard;
  readonly participants: readonly Participant[];
  readonly games: readonly GameConfig[];
  readonly cells: Readonly<Record<string, ScoreCell>>;
  readonly events: readonly RoundEvent[];       // canonical domain order — the replay source
  readonly results: readonly GameResult[];
  readonly handicapping: readonly (
    | { readonly golferId: GolferId; readonly kind: "complete"; readonly ags: number; readonly differential: number }
    | { readonly golferId: GolferId; readonly kind: "incomplete" }
  )[];
}
export const settleRound: (events: readonly RoundEvent[]) => RoundArchive;
```

Rules (fixed): reduce internally; throw `DomainError("round-not-final")` unless status `final`; results = every game's `resultOf`, throw `DomainError("game-unresolved")` on any undefined; `handicapping` per participant — complete (all tee-set holes decided) → 18-hole-equivalent differential (9-hole tee sets emit the RAW 9-hole differential here; `eighteenFromNine` is applied by the index projection, which knows the player's index — the archive stays index-independent); archive `events` in canonical domain order with `seq` stripped from the envelope (the archive's identity is content, not ack metadata).

- [ ] **Step 1: Failing tests:** settle the concurrency deck's log → archive carries both `GameResult`s and both golfers' differentials (Ann incomplete pre-correction? no — post-correction card is complete; assert Ann/Bo/Cal all complete with hand-checked AGS); un-finalized log throws; a final log with an unresolvable game throws.
- [ ] **Step 2: Determinism tests:** `JSON.stringify(settleRound(log)) === JSON.stringify(settleRound(shuffle(log)))` (fast-check over shuffles), and double-settle byte-identical.
- [ ] **Step 3: RED → implement → GREEN.** `pnpm validate`; suite ×2.
- [ ] **Step 4: Doc reconciliation:** `docs/implementation-plan.md` M2 section only: (a) settleRound signature line `(round)` → `(events)`; (b) task 4's concurrency line names `fourballMatch + skins` — update to the pairing that actually proves the claim harder (`stableford + skins`: same strokes, different allowances per game) as executed. Nothing else.
- [ ] **Step 5: Commit** (`feat(domain): deterministic settlement into the immutable RoundArchive; M2 gate met`).

**M2 gate (from `docs/implementation-plan.md`):** every format's deck passes; handicap engine verified against published WHS worked examples; concurrency deck passes.
