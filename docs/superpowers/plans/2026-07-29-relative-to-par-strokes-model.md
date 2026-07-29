# Relative-to-Par Strokes Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the WHS/swng index pipeline with one number a golfer states in plain golf terms — what they normally shoot relative to par — from which strokes are derived by the fold as the difference from the lowest in the field.

**Architecture:** What a player asserts becomes a `StrokeBasis` object (`normally-shoots` or `strokes`), stored on the participant. Strokes stop being stored: `reduceRound` derives them across the roster and every reader consumes the derived value, exactly as scores fold into standings. Rating, slope, allowances, differentials and adjusted gross score are deleted whole; a golfer's record becomes a distribution over `score − par`.

**Tech Stack:** TypeScript (ESM, nodenext), pnpm workspaces, Vitest, Zod (contracts), React 19 + Tailwind 4 (web), AWS CDK (infra), Playwright (field e2e).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-29-relative-to-par-strokes-model-design.md`. Every decision is there; this plan implements it and adds nothing.
- **`pnpm validate` must exit 0 at every commit.** Lint + typecheck + build + test. A task that would leave the tree red must land as one atomic commit across layers — several below do, and say so.
- **Beta only.** No `deploy:prod`, no `publish:web:prod`, no changes to `STAGE_CONFIG`'s `prod` entry.
- **No migration, no tolerate-old-data machinery.** Beta round data is wiped in Task 9. Stored `courseHandicap` is semantically ambiguous under the new model (some values are absolute, some are already differences), so there is nothing honest to migrate.
- **Language, verbatim:** the join question is `What do you normally shoot, relative to par?`; the measured value is called **average**. Never "index", "handicap", "your number", "your usual", "form", or "adjusted score" in user-facing copy.
- **`handicap/present.ts` survives untouched** — `formatHandicapIndex`, `formatCourseHandicap`, `strokeGrant`, and the whole-tree grep gate that forbids a bare signed render. A player can shoot under par; golf's plus convention stays.
- **The compute fence stays enforced.** `apps/web/src` may not import golf compute from `@swng/domain`; new compute goes in the domain and is re-exported through `@swng/client`. Any new domain compute function must be added to the ESLint banlist in `eslint.config.mjs`.
- **Frozen decks:** `packages/domain/src/scoring/golden/fieldDeck18.ts` and `apps/web/e2e/crewSeasonDeck.ts` keep their hand-designed **scores** byte-identical. Only *expected results* are re-derived, and only in Task 1, by hand, with the derivation shown in the commit message.

---

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `packages/domain/src/scoring/strokeBasis.ts` | The `StrokeBasis` type and `resolveStrokes` — the ONE resolution rule |
| `packages/domain/src/golfer/average.ts` | `averageOf`, `spreadOf`, `averageHistory` over round lines |

**Deleted files**

| File | Why |
|---|---|
| `packages/domain/src/scoring/allowances.ts` (+ test) | The allowance table is deleted |
| `packages/domain/src/handicap/whs.ts` (+ `whs.test.ts`, `whs.properties.test.ts`) | The whole WHS pipeline |

**Heavily modified**

| File | Change |
|---|---|
| `packages/domain/src/round/participant.ts` | `courseHandicap: number` → `basis: StrokeBasis`; `RosterEntry.strokes: number` (fold-derived) |
| `packages/domain/src/round/state.ts` | `reduceRound` derives `strokes` via `resolveStrokes` |
| `packages/domain/src/round/events.ts` | `participant-handicap-set` carries a `StrokeBasis` |
| `packages/domain/src/round/holeResult.ts` | `conceded` carries `strokes` |
| `packages/domain/src/scoring/allocation.ts` | One allocation rule for all five kinds; `handicappingFor` → `cardTotalFor` |
| `packages/domain/src/scoring/game.ts` | `allowance` deleted from all arms; `skins` gains `scoring` |
| `packages/domain/src/scoring/present.ts` | `allowancePhrase` deleted; treatment/notes rewritten |
| `packages/domain/src/golfer/{record,metrics,analytics}.ts` | Line shape, metrics shape, `hasCompleteScore` |
| `packages/domain/src/golfer/golfer.ts` | `HandicapProfile`/`IndexSource` deleted |
| `packages/domain/src/crew/scoreboard.ts` | `Average · Spread · Best` |
| `packages/contracts/src/{round,commands,golfers,crews}.ts` | Wire shapes |
| `packages/application/src/{rounds,golfers,crews,projections}/*` | Use cases and the projector |
| `apps/web/src/**` | Join, roster, card, results, profile, chart, crew board, add-game form |

---

## Task 1: One stroke rule for every game; delete allowances

Games stop re-deriving strokes from a hidden percentage. Every game applies one rule to its own field. Skins gains a gross/net choice.

**Files:**
- Create: `packages/domain/src/scoring/strokeBasis.ts`, `packages/domain/src/scoring/strokeBasis.test.ts`
- Delete: `packages/domain/src/scoring/allowances.ts`, `packages/domain/src/scoring/allowances.test.ts`
- Modify: `packages/domain/src/scoring/allocation.ts`, `packages/domain/src/scoring/game.ts`, `packages/domain/src/scoring/present.ts`, `packages/domain/src/scoring/{strokePlay,stableford,skins,singlesMatch,fourballMatch}.ts`, `packages/domain/src/index.ts`, `packages/contracts/src/round.ts`, `packages/contracts/src/commands.ts`, `apps/web/src/round/AddGameForm.tsx`, `apps/web/src/games/describeGame.ts`, `eslint.config.mjs`
- Re-derive: `packages/domain/src/scoring/golden/fieldDeck18.ts` expectations, `packages/domain/src/scoring/fieldDeck18.test.ts`, every engine test's expected values

**Interfaces:**
- Produces: `StrokeBasis`, `resolveStrokes(bases, holeCount): ReadonlyMap<GolferId, number>` — consumed by Tasks 3 and 6.
- Produces: `gameStrokeAllocation(config, participants, card)` with the same signature as today but one implementation for all kinds.

- [ ] **Step 1: Write the failing test for `resolveStrokes`**

Create `packages/domain/src/scoring/strokeBasis.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveStrokes } from "./strokeBasis.js";
import type { GolferId } from "../ids.js";

const g = (s: string) => s as GolferId;

describe("resolveStrokes", () => {
  it("takes the difference from the lowest stated normal score", () => {
    const strokes = resolveStrokes(
      [
        { golferId: g("blaine"), basis: { kind: "normally-shoots", overPar: 30 } },
        { golferId: g("ravi"), basis: { kind: "normally-shoots", overPar: 10 } },
      ],
      18,
    );
    expect(strokes.get(g("blaine"))).toBe(20);
    expect(strokes.get(g("ravi"))).toBe(0);
  });

  it("gives a player who stated strokes exactly what they said", () => {
    const strokes = resolveStrokes(
      [
        { golferId: g("blaine"), basis: { kind: "strokes", strokes: 18 } },
        { golferId: g("ravi"), basis: { kind: "normally-shoots", overPar: 10 } },
      ],
      18,
    );
    expect(strokes.get(g("blaine"))).toBe(18);
    expect(strokes.get(g("ravi"))).toBe(0);
  });

  it("allocates nothing when only one player's level is known", () => {
    // Spec §2b: strokes cannot be allocated against an unknown level. This is the
    // correct answer, not a failure — the fix is visible on screen.
    const strokes = resolveStrokes(
      [
        { golferId: g("blaine"), basis: { kind: "normally-shoots", overPar: 30 } },
        { golferId: g("ravi"), basis: { kind: "strokes", strokes: 0 } },
      ],
      18,
    );
    expect(strokes.get(g("blaine"))).toBe(0);
    expect(strokes.get(g("ravi"))).toBe(0);
  });

  it("halves the difference once, at the end, on a nine-hole card", () => {
    const strokes = resolveStrokes(
      [
        { golferId: g("blaine"), basis: { kind: "normally-shoots", overPar: 30 } },
        { golferId: g("ravi"), basis: { kind: "normally-shoots", overPar: 10 } },
      ],
      9,
    );
    expect(strokes.get(g("blaine"))).toBe(10);
    expect(strokes.get(g("ravi"))).toBe(0);
  });

  it("rounds a halved odd difference half-up", () => {
    const strokes = resolveStrokes(
      [
        { golferId: g("blaine"), basis: { kind: "normally-shoots", overPar: 25 } },
        { golferId: g("ravi"), basis: { kind: "normally-shoots", overPar: 10 } },
      ],
      9,
    );
    expect(strokes.get(g("blaine"))).toBe(8); // 15 / 2 = 7.5 → 8
  });

  it("never halves a literal strokes assertion", () => {
    const strokes = resolveStrokes([{ golferId: g("blaine"), basis: { kind: "strokes", strokes: 9 } }], 9);
    expect(strokes.get(g("blaine"))).toBe(9);
  });

  it("keeps a plus player's give-back negative", () => {
    const strokes = resolveStrokes(
      [
        { golferId: g("pro"), basis: { kind: "strokes", strokes: -2 } },
        { golferId: g("ravi"), basis: { kind: "normally-shoots", overPar: 10 } },
      ],
      18,
    );
    expect(strokes.get(g("pro"))).toBe(-2);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -F @swng/domain vitest run src/scoring/strokeBasis.test.ts`
Expected: FAIL — `Cannot find module './strokeBasis.js'`

- [ ] **Step 3: Implement `strokeBasis.ts`**

Create `packages/domain/src/scoring/strokeBasis.ts`:

```ts
import type { GolferId } from "../ids.js";
import { roundHalfUp } from "./strokes.js";

// What a player asserts about their game (spec §2a) — an object, not an integer. A group
// saying "just give him 18" is the SECOND constructor, not a fudge of the first, so nobody
// ever distorts a true fact about themselves to get the strokes they want.
export type StrokeBasis =
  | { readonly kind: "normally-shoots"; readonly overPar: number }
  | { readonly kind: "strokes"; readonly strokes: number };

// The ONE resolution rule (spec §2b): strokes are the difference from the lowest in the
// field. The anchor is the lowest stated `normally-shoots` on the roster; a player who
// stated strokes gets exactly what they said and never enters the anchor.
//
// `holeCount` halves the DIFFERENCE once, at the end — never each player's number first,
// which would round twice for no reason. A literal strokes assertion is never halved: it is
// already a statement about this round.
//
// With no stated normal score there is no anchor and nothing to be relative to, so every
// normal-score player gets 0. That is the correct answer, not a degenerate case: strokes
// cannot be allocated when only one person's level is known.
export const resolveStrokes = (
  bases: readonly { readonly golferId: GolferId; readonly basis: StrokeBasis }[],
  holeCount: number,
): ReadonlyMap<GolferId, number> => {
  const stated = bases.flatMap(({ basis }) => (basis.kind === "normally-shoots" ? [basis.overPar] : []));
  const anchor = stated.length > 0 ? Math.min(...stated) : undefined;
  return new Map(
    bases.map(({ golferId, basis }) => {
      if (basis.kind === "strokes") return [golferId, basis.strokes];
      const difference = anchor === undefined ? 0 : basis.overPar - anchor;
      return [golferId, holeCount === 9 ? roundHalfUp(difference / 2) : difference];
    }),
  );
};
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm -F @swng/domain vitest run src/scoring/strokeBasis.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit the new rule**

```bash
git add packages/domain/src/scoring/strokeBasis.ts packages/domain/src/scoring/strokeBasis.test.ts
git commit -m "feat(domain): StrokeBasis and the one stroke-resolution rule"
```

- [ ] **Step 6: Write the failing test for the unified game allocation**

Add to `packages/domain/src/scoring/allocation.test.ts` (keep every existing test; they will be updated in step 8):

```ts
it("allocates every game kind off the lowest in that game's own field", () => {
  // Four players in the round; a two-man stroke-play game between the middle two.
  // The game's anchor is the lower of THOSE TWO (spec §2b: the field is what you're
  // looking at), not the round's best player.
  const participants = [
    p("ann", 0), p("bo", 20), p("cy", 25), p("dee", 40),
  ];
  const allocation = gameStrokeAllocation(
    { kind: "stroke-play", id: gameId("g1"), scoring: "net", players: [golferId("bo"), golferId("cy")] },
    participants,
    card,
  );
  expect(totalDots(allocation.get(golferId("bo"))!)).toBe(0);
  expect(totalDots(allocation.get(golferId("cy"))!)).toBe(5);
});

it("allocates nothing for a gross game", () => {
  const allocation = gameStrokeAllocation(
    { kind: "skins", id: gameId("g2"), scoring: "gross", players: [golferId("bo"), golferId("cy")] },
    participants,
    card,
  );
  expect(allocation.size).toBe(0);
});
```

Use the file's existing `p`/`card`/`golferId`/`gameId` helpers; if `p` currently builds a participant with `courseHandicap`, keep it as-is for this task — the field is renamed in Task 3.

- [ ] **Step 7: Run it and watch it fail**

Run: `pnpm -F @swng/domain vitest run src/scoring/allocation.test.ts`
Expected: FAIL — stroke-play currently allocates each player's own 95%-adjusted handicap, so `bo` gets 19 dots, not 0.

- [ ] **Step 8: Replace `gameStrokeAllocation` with one implementation**

In `packages/domain/src/scoring/allocation.ts`, delete the five-arm `switch` entirely and replace with:

```ts
// ONE rule for every kind (spec §3): the game's field is its own members, strokes are the
// difference from the lowest among them, allocated by stroke index. The per-kind switch this
// replaced encoded five different conventions and a hidden allowance percentage; there is now
// nothing per-kind left to encode. A gross game allocates nothing at all, by definition.
export const gameStrokeAllocation = (
  config: GameConfig,
  participants: readonly Participant[],
  card: CourseCard,
): ReadonlyMap<GolferId, ReadonlyMap<number, number>> => {
  if ("scoring" in config && config.scoring === "gross") return new Map();
  const members = gameMembers(config);
  const holeCount = card.teeSets[0]?.holes.length ?? 18;
  const strokes = resolveStrokes(
    members.map((id) => ({ golferId: id, basis: basisOf(participantFor(participants, id)) })),
    holeCount,
  );
  return new Map(
    members.map((id) => [id, dotsByHole(strokes.get(id)!, findTeeSet(card, participantFor(participants, id).tee))]),
  );
};
```

Add a temporary shim at the top of the file so this task compiles before Task 3 renames the field:

```ts
// TEMPORARY (deleted in Task 3, when `Participant.basis` replaces `courseHandicap`): today's
// stored integer is read as an absolute "normally shoots" figure, which is what the resolution
// rule expects.
const basisOf = (participant: Participant): StrokeBasis => ({ kind: "normally-shoots", overPar: participant.courseHandicap });
```

Delete `packages/domain/src/scoring/allowances.ts` and its test. Remove the `allowance` field from all five `GameConfig` arms in `game.ts`, add `readonly scoring: "gross" | "net"` to the `skins` arm and to the `skins` variant of `GameState`, and delete `allowancePhrase` from `present.ts`.

Rewrite the two surviving copy functions in `present.ts`:

```ts
export const strokePlayTreatment = (scoring: "gross" | "net"): string =>
  scoring === "net" ? "Net — uses the strokes on the card" : "Gross — raw scores, no strokes";

export const strokesNote = (kind: GameKind): string | undefined => {
  switch (kind) {
    case "singles-match":
      return "Strokes are the difference between you two.";
    case "fourball-match":
      return "Everyone plays off the lowest of the four.";
    case "stroke-play":
    case "stableford":
    case "skins":
      return "Strokes are the difference from the lowest player in this game.";
  }
};
```

- [ ] **Step 9: Follow the compiler through the engines and the wire**

Run `pnpm -F @swng/domain build` and fix every error. Expect: the five engines each drop their `playingHandicap`/`defaultAllowance` import and read dots from `gameStrokeAllocation`; `skins.ts` gains the gross branch (skip the dots lookup entirely when `scoring === "gross"`).

Then `pnpm -F @swng/contracts build`: drop `allowance` from every game schema in `round.ts` and `commands.ts`, and add `scoring: z.enum(["gross", "net"])` to the skins schema.

- [ ] **Step 10: Re-derive the golden deck expectations by hand**

`packages/domain/src/scoring/golden/fieldDeck18.ts` keeps its hole-by-hole scores **byte-identical**. Its expected standings change because stroke play and stableford no longer apply 95% and skins no longer plays each golfer off their own full handicap.

For each game in the deck: compute each member's strokes as `theirs − min(field)`, run `dotsByHole` over the fixture course's stroke index, and hand-compute the result. Write the derivation into the commit message so a reviewer can check it without re-running the engine.

Do the same for the per-engine tests (`strokePlay.test.ts`, `stableford.test.ts`, `skins.test.ts`, `singlesMatch.test.ts`, `fourballMatch.test.ts`) — singles-match and four-ball expectations should be **unchanged**, since those two already allocated off the field's lowest at 100% and 90% respectively; only four-ball's 90% removal moves its numbers.

- [ ] **Step 11: Update the add-game form and the fence**

In `apps/web/src/round/AddGameForm.tsx`, delete the allowance percent input and the "Adjust" disclosure entirely. Add a gross/net radio to the skins branch, matching the existing stroke-play one.

In `eslint.config.mjs`, add `resolveStrokes` to the `apps/web/src` compute banlist.

- [ ] **Step 12: Run the full gate**

Run: `pnpm validate`
Expected: exit 0.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat(scoring): one stroke rule for every game; delete the allowance table

Every game allocates off the lowest in its OWN field, by stroke index. The
five-arm per-kind switch and the 95/90/100 allowance table are deleted. Skins
gains a gross/net choice.

Golden deck scores are byte-identical; expectations re-derived by hand:
<paste the derivation>"
```

---

## Task 2: A conceded hole carries its score

**Files:**
- Modify: `packages/domain/src/round/holeResult.ts`, `packages/domain/src/round/state.ts`, `packages/contracts/src/round.ts`, `apps/web/src/round/ScorePad.tsx`, `apps/web/src/round/ScorecardGrid.tsx`
- Test: `packages/domain/src/round/state.test.ts`, `apps/web/src/round/ScorePad.test.tsx`, `packages/contracts/src/round.test.ts`

**Interfaces:**
- Produces: `HoleResult`'s `conceded` arm as `{ kind: "conceded"; strokes: number }` — consumed by Task 4's `hasCompleteScore`.

- [ ] **Step 1: Write the failing contract test**

Add to `packages/contracts/src/round.test.ts`:

```ts
it("requires a score on a conceded hole", () => {
  expect(() => holeResultSchema.parse({ kind: "conceded" })).toThrow();
  expect(holeResultSchema.parse({ kind: "conceded", strokes: 5 })).toEqual({ kind: "conceded", strokes: 5 });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -F @swng/contracts vitest run src/round.test.ts`
Expected: FAIL — a bare `{ kind: "conceded" }` currently parses.

- [ ] **Step 3: Add the field**

In `packages/domain/src/round/holeResult.ts`:

```ts
export type HoleResult =
  | { readonly kind: "strokes"; readonly strokes: number }
  | { readonly kind: "picked-up" }
  // The hole was decided but the player would have finished it — the score the group says out
  // loud ("he gave me the second putt, put me down for 5"). SCORING ENGINES IGNORE THIS NUMBER:
  // the concession already decided the hole, so recording a 5 cannot change a match. The
  // golfer's record reads it, which is what keeps match-play rounds countable (spec §2d).
  | { readonly kind: "conceded"; readonly strokes: number }
  | { readonly kind: "cleared" };
```

Mirror it in the contracts schema. The domain's `[A] extends [B]` exhaustiveness guard on `holeResultSchema` (Arc A) will fail the build if the schema and the type diverge — that is the intended safety net.

- [ ] **Step 4: Prove the engines still ignore the number**

Add to `packages/domain/src/scoring/singlesMatch.test.ts`:

```ts
it("ignores the score on a conceded hole — the concession already decided it", () => {
  const conceded = scoreSinglesMatch(config, stateWith({ ann: { kind: "strokes", strokes: 4 }, bo: { kind: "conceded", strokes: 5 } }));
  const conceded99 = scoreSinglesMatch(config, stateWith({ ann: { kind: "strokes", strokes: 4 }, bo: { kind: "conceded", strokes: 99 } }));
  expect(conceded).toEqual(conceded99);
});
```

Follow the compiler: every `case "conceded":` in the engines already treats it as "not a competitive score" and needs no change beyond the type widening.

- [ ] **Step 5: Update the ScorePad**

In `apps/web/src/round/ScorePad.tsx`, `Conceded` becomes a disclosure that reveals the same number row, labelled `Conceded — what would you have made?`. Scoring stays two taps (cell → number); conceding costs three (cell → `Conceded` → number). Add a comment naming this as a deliberate deviation from `product.md` §9's two-tap rule for a rarer, deliberate act.

In `ScorecardGrid.tsx`'s `glyphFor`, render a conceded hole as its number with a marker: `` `${result.strokes}c` ``.

- [ ] **Step 6: Run the gate and commit**

Run: `pnpm validate`
Expected: exit 0.

```bash
git add -A
git commit -m "feat(round): a conceded hole carries the score you would have made"
```

---

## Task 3: `StrokeBasis` replaces `courseHandicap`; the fold derives strokes

**One atomic commit** — `Participant` is imported by every layer, so an intermediate state does not compile.

**Files:**
- Modify: `packages/domain/src/round/{participant,state,events,archive}.ts`, `packages/domain/src/scoring/allocation.ts`, `packages/domain/src/golfer/record.ts`, `packages/contracts/src/{round,commands}.ts`, `packages/application/src/rounds/{startRound,joinRound,setHandicap}.ts`, `packages/client/src/scoring.ts`, `apps/web/src/routes/JoinRoundPage.tsx`, `apps/web/src/round/SetupPanel.tsx`, `apps/web/src/routes/CreateRoundPage.tsx`
- Test: every `*.test.ts` in the `courseHandicap` grep list

**Interfaces:**
- Consumes: `resolveStrokes` from Task 1.
- Produces: `Participant.basis: StrokeBasis`, `RosterEntry.strokes: number` — consumed by Tasks 4, 5, 6.

- [ ] **Step 1: Write the failing fold test**

Add to `packages/domain/src/round/state.test.ts`:

```ts
it("derives strokes across the roster — a later, better joiner re-runs the fold", () => {
  const one = reduceRound([created(card), joined("blaine", { kind: "normally-shoots", overPar: 30 })]);
  expect(one.participants.find((p) => p.golferId === golferId("blaine"))!.strokes).toBe(0);

  const two = reduceRound([
    created(card),
    joined("blaine", { kind: "normally-shoots", overPar: 30 }),
    joined("ravi", { kind: "normally-shoots", overPar: 10 }),
  ]);
  expect(two.participants.find((p) => p.golferId === golferId("blaine"))!.strokes).toBe(20);
  expect(two.participants.find((p) => p.golferId === golferId("ravi"))!.strokes).toBe(0);
});

it("applies a handicap-set basis that is HLC-later than the join", () => {
  const state = reduceRound([
    created(card),
    joined("blaine", { kind: "normally-shoots", overPar: 30 }, hlc(1)),
    joined("ravi", { kind: "normally-shoots", overPar: 10 }, hlc(2)),
    handicapSet("blaine", { kind: "strokes", strokes: 18 }, hlc(3)),
  ]);
  expect(state.participants.find((p) => p.golferId === golferId("blaine"))!.strokes).toBe(18);
  // The stated normal score is replaced by the new assertion, not fudged.
  expect(state.participants.find((p) => p.golferId === golferId("blaine"))!.basis).toEqual({ kind: "strokes", strokes: 18 });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -F @swng/domain vitest run src/round/state.test.ts`
Expected: FAIL — `strokes` does not exist on the roster entry.

- [ ] **Step 3: Change the participant and the fold**

`packages/domain/src/round/participant.ts`:

```ts
import type { StrokeBasis } from "../scoring/strokeBasis.js";
import type { GolferId } from "../ids.js";

export interface Participant {
  readonly golferId: GolferId;
  readonly name: string;
  readonly tee: string;         // TeeSet name within the round's frozen CourseCard
  readonly basis: StrokeBasis;  // what this player ASSERTED — never a derived number
}

export interface RosterEntry extends Participant {
  readonly departed?: boolean;
  // DERIVED by reduceRound across the whole roster (spec §2b), stored nowhere. A fifth player
  // joining just re-runs the fold — there is no correction event and no stale number.
  readonly strokes: number;
}
```

In `packages/domain/src/round/state.ts`, `participant-handicap-set` carries `basis: StrokeBasis` instead of `courseHandicap: number` (mirror in `events.ts`). Keep the HLC rule byte-identical: a set applies iff strictly later than that golfer's latest join. After the roster map is built, add the derivation:

```ts
// Strokes are the fold's output, not a stored field (spec §2b). The card's first tee set gives
// the hole count — real courses share hole counts across tees, the canonicalHoles precedent.
const strokes = resolveStrokes(
  roster.map((entry) => ({ golferId: entry.golferId, basis: entry.basis })),
  card.teeSets[0]?.holes.length ?? 18,
);
const participants = roster.map((entry) => ({ ...entry, strokes: strokes.get(entry.golferId)! }));
```

- [ ] **Step 4: Delete the Task 1 shim and follow the compiler**

Remove `basisOf` from `allocation.ts` and read `participant.basis` directly. Rename `courseHandicapAllocation` → `roundStrokeAllocation`, reading the fold-derived value:

```ts
// The STANDARD CARD's dots: each player's derived strokes for THIS round, allocated by stroke
// index. The card never changes with the chip selection (spec 2026-07-19 §2a); a game's own
// field may resolve differently, and that game's panel states its own line.
export const roundStrokeAllocation = (
  participants: readonly RosterEntry[],
  card: CourseCard,
): ReadonlyMap<GolferId, ReadonlyMap<number, number>> =>
  new Map(participants.map((p) => [p.golferId, dotsByHole(p.strokes, findTeeSet(card, p.tee))]));
```

Update the ESLint banlist and the `@swng/client` re-export to the new name.

- [ ] **Step 5: Change the wire**

`packages/contracts/src/commands.ts`: `JoinRoundRequest.courseHandicap: number` → `basis: strokeBasisSchema`. Same for `StartRoundRequest`'s host and the set-handicap request body. Define once:

```ts
export const strokeBasisSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("normally-shoots"), overPar: z.number().int().min(-20).max(100) }),
  z.object({ kind: z.literal("strokes"), strokes: z.number().int().min(-20).max(100) }),
]);
```

Bounds match Arc A's widened `courseHandicap` range and its placement rule: request schemas only, never a stored-fold path.

`packages/contracts/src/round.ts`: the participant schema carries `basis`; `RosterEntry`'s `strokes` is response-only.

- [ ] **Step 6: Change the join surface**

`apps/web/src/routes/JoinRoundPage.tsx`:
- Replace the `Strokes you get here` field with a single number input labelled **`What do you normally shoot, relative to par?`**.
- Delete `resolveIndex`, `courseHandicapFromRatingSlopePar`, `unratedCourseHandicap`, the `formatHandicapIndex` derivation note, and the whole `suggestion` block. The pre-fill comes from `record.metrics.average` (added in Task 4 — until then, seed from the last stated value only and leave a `// Task 4` comment).
- Submit `{ code, tee, basis: { kind: "normally-shoots", overPar: parsed } }`.

`apps/web/src/round/SetupPanel.tsx`: the roster row shows `name — tee — normally +30 · gets 20`, and EDIT edits the **basis**. Add a second control, `Give strokes directly`, which writes `{ kind: "strokes", strokes }` — the two constructors, not two ways to edit one number. Keep the existing mutual-exclusion test (static span vs input) and add a plus-handicap fixture.

- [ ] **Step 7: Run the gate**

Run: `pnpm validate`
Expected: exit 0. Expect a long compiler-driven sweep across the test files in the grep list; every `courseHandicap: N` fixture becomes `basis: { kind: "normally-shoots", overPar: N }`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(round): StrokeBasis replaces courseHandicap; the fold derives strokes

What a player asserts is an object, not an integer. Strokes are no longer
stored — reduceRound resolves them across the roster as the difference from
the lowest in the field, so a fifth player joining just re-runs the fold."
```

---

## Task 4: Delete WHS; the average replaces the index

**One atomic commit** — `GolferMetrics` and `GolferRoundLine` are imported by every layer.

**Files:**
- Create: `packages/domain/src/golfer/average.ts` + test
- Delete: `packages/domain/src/handicap/whs.ts`, `whs.test.ts`, `whs.properties.test.ts`
- Modify: `packages/domain/src/golfer/{golfer,record,metrics,analytics}.ts`, `packages/domain/src/scoring/allocation.ts`, `packages/contracts/src/golfers.ts`, `packages/application/src/golfers/{recordOf,getMyRecord,getMyRounds,golferView,updateMyGolfer}.ts`, `packages/application/src/projections/projectArchive.ts`, `packages/adapters-dynamodb/src/golferStore.ts`, `apps/web/src/routes/ProfilePage.tsx`, `apps/web/src/golfers/RecordSections.tsx`, `apps/web/src/courses/CourseRecordSection.tsx`

**Interfaces:**
- Produces: `averageOf(lines): number | undefined`, `spreadOf(lines): number | undefined`, `averageHistory(lines): readonly AveragePoint[]`, `hasCompleteScore(line): boolean` — consumed by Task 6.

- [ ] **Step 1: Write the failing test for the average**

Create `packages/domain/src/golfer/average.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { averageOf, spreadOf } from "./average.js";
import type { GolferRoundLine } from "./record.js";

const line = (holes: 9 | 18, par: number, scores: number[]): GolferRoundLine => ({
  roundId: `r${scores.join("")}` as GolferRoundLine["roundId"],
  courseName: "Test", tee: "white", holes, par, strokes: 0,
  distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  holeResults: scores.map((s, i) => ({ hole: i + 1, par: par / holes, result: { kind: "strokes" as const, strokes: s } })),
});

// par 72 over 18 holes of par 4
const eighteen = (gross: number) => line(18, 72, Array.from({ length: 18 }, () => gross / 18));

describe("averageOf", () => {
  it("averages score minus par over finished rounds", () => {
    expect(averageOf([eighteen(90), eighteen(94), eighteen(98)])).toBe(22); // +18, +22, +26
  });

  it("counts a nine-hole round doubled", () => {
    // 9 holes of par 4 = par 36; a 52 is +16 and contributes +32.
    const nine = line(9, 36, Array.from({ length: 9 }, () => 52 / 9));
    expect(averageOf([nine])).toBe(32);
  });

  it("counts a round containing a conceded hole", () => {
    const withConcession = { ...eighteen(90), holeResults: eighteen(90).holeResults!.map((h, i) => (i === 0 ? { ...h, result: { kind: "conceded" as const, strokes: 5 } } : h)) };
    expect(averageOf([withConcession])).toBeDefined();
  });

  it("skips a round containing a pickup — there is no score", () => {
    const withPickup = { ...eighteen(90), holeResults: eighteen(90).holeResults!.slice(1) };
    expect(averageOf([withPickup])).toBeUndefined();
  });

  it("uses only the last 10 finished rounds", () => {
    const lines = [...Array.from({ length: 10 }, () => eighteen(108)), ...Array.from({ length: 10 }, () => eighteen(90))];
    expect(averageOf(lines)).toBe(18); // the older +36 rounds fall out of the window
  });

  it("is undefined with no finished rounds", () => {
    expect(averageOf([])).toBeUndefined();
  });
});

describe("spreadOf", () => {
  it("is undefined below five finished rounds", () => {
    expect(spreadOf([eighteen(90), eighteen(90), eighteen(90), eighteen(90)])).toBeUndefined();
  });

  it("is zero for five identical rounds", () => {
    expect(spreadOf(Array.from({ length: 5 }, () => eighteen(90)))).toBe(0);
  });

  it("reports the standard deviation to one decimal", () => {
    // +14, +18, +18, +18, +22 → mean 18, population variance 6.4, sd 2.529… → 2.5
    expect(spreadOf([eighteen(86), eighteen(90), eighteen(90), eighteen(90), eighteen(94)])).toBe(2.5);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -F @swng/domain vitest run src/golfer/average.test.ts`
Expected: FAIL — `Cannot find module './average.js'`

- [ ] **Step 3: Implement `average.ts` and `hasCompleteScore`**

Add to `packages/domain/src/golfer/analytics.ts`:

```ts
// Every hole has a NUMBER — a stroke count or a conceded score (spec §2d). Distinct from
// fullyHoledOut, which is stricter (a conceded putt means you did not hole out) and still gates
// Best and the milestones. This one gates the average, which is why match-play rounds count.
export const hasCompleteScore = (line: GolferRoundLine): boolean =>
  line.holeResults !== undefined &&
  line.holeResults.length === line.holes &&
  line.holeResults.every((h) => h.result.kind === "strokes" || h.result.kind === "conceded");

// Sum over a line with a complete score — call only when hasCompleteScore(line).
export const scoreOf = (line: GolferRoundLine): number =>
  line.holeResults!.reduce((sum, h) => sum + (h.result.kind === "strokes" || h.result.kind === "conceded" ? h.result.strokes : 0), 0);
```

Create `packages/domain/src/golfer/average.ts`:

```ts
import type { RoundId } from "../ids.js";
import { roundHalfUp } from "../scoring/strokes.js";
import { hasCompleteScore, scoreOf } from "./analytics.js";
import type { GolferRoundLine } from "./record.js";

// What you normally shoot relative to par, per 18 holes (spec §2c). One number, one unit, and
// a golfer can check it by adding up the rounds on their own profile — which is the whole point.
// A nine-hole round contributes its figure DOUBLED: imperfect (nines differ, fatigue is not
// linear) and accepted, because product.md §2 names the nine-hole league as a target audience.
const WINDOW = 10;
const SPREAD_MIN_ROUNDS = 5;

const overPar = (line: GolferRoundLine): number => {
  const raw = scoreOf(line) - line.par;
  return line.holes === 9 ? raw * 2 : raw;
};

// Only rounds with a score. A pickup means there is no score, so no number is invented for it.
const scored = (lines: readonly GolferRoundLine[]): readonly number[] =>
  lines.filter(hasCompleteScore).map(overPar);

const meanOf = (values: readonly number[]): number =>
  values.reduce((sum, v) => sum + v, 0) / values.length;

export const averageOf = (lines: readonly GolferRoundLine[]): number | undefined => {
  const window = scored(lines).slice(-WINDOW);
  return window.length === 0 ? undefined : roundHalfUp(meanOf(window));
};

// Standard deviation over the same window — the most useful competitive fact about an opponent
// (spec §6). Gated at five rounds: below that it describes noise, the refusing-to-draw-noise
// discipline the index chart's own 8-round gate established.
export const spreadOf = (lines: readonly GolferRoundLine[]): number | undefined => {
  const window = scored(lines).slice(-WINDOW);
  if (window.length < SPREAD_MIN_ROUNDS) return undefined;
  const mean = meanOf(window);
  const variance = meanOf(window.map((v) => (v - mean) ** 2));
  return roundHalfUp(Math.sqrt(variance) * 10) / 10;
};

// One point on "your average over time": the average AS OF this round. Only rounds that
// contribute get a point — a round with a pickup is not a point on the line, because it is not
// a data point at all.
export interface AveragePoint {
  readonly roundId: RoundId;
  readonly average: number;
}

export const averageHistory = (lines: readonly GolferRoundLine[]): readonly AveragePoint[] => {
  const window: number[] = [];
  const points: AveragePoint[] = [];
  for (const line of lines) {
    if (!hasCompleteScore(line)) continue;
    window.push(overPar(line));
    if (window.length > WINDOW) window.shift();
    points.push({ roundId: line.roundId, average: roundHalfUp(meanOf(window)) });
  }
  return points;
};
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm -F @swng/domain vitest run src/golfer/average.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Delete WHS and reshape the metrics**

- `rm packages/domain/src/handicap/whs.ts packages/domain/src/handicap/whs.test.ts packages/domain/src/handicap/whs.properties.test.ts`
- `packages/domain/src/golfer/golfer.ts`: delete `IndexSource`, `HandicapProfile`, and `Golfer.handicap`.
- `packages/domain/src/golfer/metrics.ts`: delete `IndexMetric`, `IndexPoint`, `detailsOf`, `indexHistoryOf`, `resolveIndex`, `ResolvedIndex`. `GolferMetrics` becomes:

```ts
export interface GolferMetrics {
  readonly average?: number;                              // absent until one round has a score
  readonly spread?: number;                               // absent below five
  readonly typicalEighteen: ScoringShape;                 // unchanged
  readonly averageHistory: readonly AveragePoint[];       // oldest → newest
  readonly bests: GolferBests;
  readonly milestones: readonly Milestone[];
}
```

- `packages/domain/src/golfer/record.ts`: `courseHandicap` → `strokes`; add `normallyShoots?: number` (absent when the player stated raw strokes); delete `ags` and `differential`. `archiveGolferLine` reads `participant.strokes` and `participant.basis`.
- `packages/domain/src/scoring/allocation.ts`: delete `handicappingFor` outright. `RoundArchive.handicapping` and its wire schema go with it — the results view computes totals from the cells it already renders, and `archiveGolferLine` computes from `holeResults`.
- `packages/domain/src/index.ts`: drop every deleted export, add `averageOf`/`spreadOf`/`averageHistory`/`hasCompleteScore`/`scoreOf`.
- `eslint.config.mjs`: banlist gains the four new compute names, loses the deleted ones.

- [ ] **Step 6: Follow the compiler through application, adapters and web**

- `recordOf.ts` / `getMyRecord.ts` / `getGolfer.ts`: serve the new metrics; `toWireLine` maps `strokes`/`normallyShoots`, drops `ags`/`differential`.
- `golferView.ts` / `updateMyGolfer.ts`: drop `indexSource` from the golfer view and the PUT body.
- `adapters-dynamodb/src/golferStore.ts`: drop the `indexSource` attribute and its legacy fold. Contract tests updated.
- `ProfilePage.tsx`: delete the whole "Your index" section — the source picker, `Use this`, the override box, `applyGolfer`'s `indexSource` path. The page keeps name and home course only.
- `RecordSections.tsx`: headline becomes `What you shoot` with `metrics.average` rendered through `formatHandicapIndex`, subtitle `your last 10 finished rounds, score minus par`. The chart plots `averageHistory` as ONE line; delete the WHS series, its legend marker, and the two-line caption. Keep the 20-round window, the nice-bounds/min-span-4 axis, the endpoint emphasis, and the date anchors.

- [ ] **Step 7: Run the gate and commit**

Run: `pnpm validate` → exit 0. Then `pnpm test:contract` → all green.

```bash
git add -A
git commit -m "feat(golfer): delete the WHS/swng index; the average replaces it

One number, computed from the last 10 finished rounds as score minus par, a
nine-hole round counting doubled. A round containing a pickup has no score and
does not contribute; a conceded hole carries one, so match rounds count.
Rating, slope, differentials, adjusted gross score and the index-source model
are deleted whole."
```

---

## Task 5: The card reads like a scorecard; the finished round stops speaking WHS

**Files:**
- Modify: `apps/web/src/round/ScorecardGrid.tsx`, `apps/web/src/round/ResultsView.tsx`
- Test: `apps/web/src/round/ScorecardGrid.test.tsx`, `apps/web/src/round/ResultsView.test.tsx`

- [ ] **Step 1: Write the failing totals-row test**

Add to `apps/web/src/round/ScorecardGrid.test.tsx`:

```tsx
it("totals the card like a scorecard — OUT, IN and TOT, gross and net", () => {
  render(<ScorecardGrid state={stateWithFullCard} recordScore={() => {}} />);
  const out = screen.getByRole("row", { name: /out/i });
  expect(within(out).getByText("36")).toBeTruthy();  // par out
  const tot = screen.getByRole("row", { name: /tot/i });
  expect(within(tot).getByText("72")).toBeTruthy();  // par total
  expect(within(tot).getByText("96")).toBeTruthy();  // Blaine gross
  expect(within(tot).getByText("76")).toBeTruthy();  // Blaine net
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -F @swng/web vitest run src/round/ScorecardGrid.test.tsx`
Expected: FAIL — no row named OUT exists.

- [ ] **Step 3: Add the totals rows**

In `ScorecardGrid.tsx`, add a `<tfoot>` after `</tbody>` with `OUT` (holes 1–9), `IN` (10–18, omitted on a 9-hole card) and `TOT`. The hole column carries the par sum; each player column carries gross over net, using the same `netStrokes(gross, dots)` the cells use. A player with an unscored or picked-up hole shows `–` for that segment rather than a partial total.

Add a `subtotal` helper alongside `currentHoleNumber`, and keep the section's `readOnly` behaviour untouched.

- [ ] **Step 4: Rewrite the finished round**

In `ResultsView.tsx`, delete `deriveHandicapping`, the `handicappingFor` import, the `response.handicapping` prop path, and the whole "Posted to handicaps" section. Replace with a totals list above the card:

```tsx
<h2>Final totals</h2>
<p>Par {parTotal}</p>
<ul aria-label="Final totals">
  {state.participants.map((p) => (
    <li key={p.golferId}>
      <GolferLink golferId={p.golferId} name={p.name} />
      {` — ${gross(p)} gross · ${formatCourseHandicap(-p.strokes)} · ${gross(p) - p.strokes} net`}
    </li>
  ))}
</ul>
```

No fourth column. Net already ranks players against their own stated level (spec §4) — add that as a why-comment so a future reader does not "helpfully" add one back.

- [ ] **Step 5: Run the gate and commit**

Run: `pnpm validate` → exit 0.

```bash
git add -A
git commit -m "feat(web): scorecard totals row; the finished round shows gross, strokes and net"
```

---

## Task 6: The crew board describes the distribution

**Files:**
- Modify: `packages/domain/src/crew/scoreboard.ts` + test, `packages/contracts/src/crews.ts`, `packages/application/src/crews/getSeasonStandings.ts`, `apps/web/src/crews/SeasonPanel.tsx` + test

**Interfaces:**
- Consumes: `averageOf`, `spreadOf` from Task 4.

- [ ] **Step 1: Write the failing scoreboard test**

Replace the `netPer18`/`index`/`indexDelta` assertions in `packages/domain/src/crew/scoreboard.test.ts` with:

```ts
it("describes each member's distribution over the window", () => {
  const board = crewScoreboard([{ golferId: g("blaine"), lines: twelveLines }], window);
  expect(board[0]).toMatchObject({ rounds: 12, average: 26, spread: 4.2, best18: { gross: 88, toPar: 16 } });
});

it("omits spread below five scored rounds and still reports the average", () => {
  const board = crewScoreboard([{ golferId: g("ravi"), lines: threeLines }], window);
  expect(board[0]!.average).toBeDefined();
  expect(board[0]!.spread).toBeUndefined();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -F @swng/domain vitest run src/crew/scoreboard.test.ts`
Expected: FAIL — `average` is not on `ScoreboardLine`.

- [ ] **Step 3: Reshape `ScoreboardLine`**

```ts
export interface ScoreboardLine {
  readonly golferId: GolferId;
  readonly rounds: number;
  readonly average?: number;
  readonly spread?: number;
  readonly best18?: { readonly gross: number; readonly toPar: number };
}
```

`average`/`spread` fold `averageOf`/`spreadOf` over the **windowed** lines (not the whole career — the board describes the season). Delete `netPer18`, `NET_PER_18_MIN_ROUNDS`, `index`, `indexDelta`, and the `golferMetrics` import. The total order becomes: `average` ascending with absent LAST, then `rounds` descending, then `golferId` ascending — same shape as today's comparator, one field swapped.

- [ ] **Step 4: Add the head-to-head strokes line**

In `SeasonPanel.tsx`, under the board, render for each pair of members who both have an average:

```
If you played tomorrow, Blaine gets 16.
```

The difference of two averages **is** the strokes between them — the same subtraction the round does at join. Compute it inline from the two served `average` values (a subtraction of two served numbers is not a golf result; the compute fence does not apply, and the round's own `resolveStrokes` is not reachable from `apps/web/src`).

- [ ] **Step 5: Follow the wire and the panel**

`packages/contracts/src/crews.ts`: the standings response's scoreboard line schema swaps its fields. `SeasonPanel.tsx`'s table headers become `Rounds · Average · Spread · Best`; render `average`/`spread` through `formatHandicapIndex`/a plain `±` prefix, and `—` where absent.

- [ ] **Step 6: Run the gate and commit**

Run: `pnpm validate` → exit 0.

```bash
git add -A
git commit -m "feat(crew): the board describes the distribution — average, spread, best"
```

---

## Task 7: The docs say what the product now is

**Files:**
- Modify: `docs/product.md`, `docs/architecture.md`, `CLAUDE.md`

- [ ] **Step 1: Rewrite `product.md` §5's index pillar**

Replace **The swng Index** with:

```markdown
- **What you shoot.** One number: what you normally shoot relative to par, averaged from
  your last ten finished rounds. Not an index, not slope-adjusted, not best-8-of-20 — a
  number you can check by adding up your own scorecards. It is also, exactly, the strokes
  you take: state +30 against a mate's +10 and you get 20, allocated by the card's stroke
  index. The first-tee negotiation is over before it starts, and nobody had to trust
  arithmetic they cannot see.
```

- [ ] **Step 2: Amend §1, §4 and §6**

- §1: the "most golfers' handicaps are unofficial, stale, or vibes" paragraph now resolves by *asking for the vibe in plain words and then replacing it with real scores*, rather than by computing a WHS-faithful index.
- §4: "Handicaps are already known, so strokes are computed" → "Everyone states what they normally shoot; swng takes the difference."
- §6: **Crew handicaps** becomes **The crew board** — rounds, average, spread, best; and the line that the difference between two members' averages is the strokes between them.

- [ ] **Step 3: Update `architecture.md`'s "Where golf logic lives"**

Add `scoring/strokeBasis.ts` and `golfer/average.ts` to the domain inventory; delete `handicap/whs.ts` and `scoring/allowances.ts`.

- [ ] **Step 4: Add the arc paragraph to `CLAUDE.md`**

Follow the existing convention: what changed, what was deleted whole, what the gates were, beta-only, never pushed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: the product is what you shoot relative to par, not an index"
```

---

## Task 8: E2E reconciliation

Every spec that types a handicap, reads "adjusted score", or asserts an index must be reconciled against the real JSX and the real wire — the string-breakage lesson.

**Files:**
- Modify: `apps/web/e2e/support.ts`, `courseEntry.spec.ts`, `fieldTest.spec.ts`, `crewSeason.spec.ts`, `crewSeasonDeck.ts`, `identityRecord.spec.ts`, `unratedCourse.spec.ts`, `handicapCorrection.spec.ts`, `shareLink.spec.ts`, `killNetwork.spec.ts`, `primaryPath.spec.ts`, `e2e/roundSlice.e2e.test.ts`, `e2e/syncSession.e2e.test.ts`

- [ ] **Step 1: Sweep the join helpers**

`support.ts`'s join helper sends `basis` instead of `courseHandicap`. Every browser spec that fills the join form targets the new label — verify the accessible name against `JoinRoundPage.tsx` **by reading the JSX**, not from this plan.

- [ ] **Step 2: Re-derive `crewSeasonDeck.ts`'s expectations**

Scores stay byte-identical. Standings change because stroke play and stableford lost their 95%. Re-derive by hand and record the derivation in the commit message; the deck's own local-fold-vs-frozen backstop must still agree.

- [ ] **Step 3: Rewrite `identityRecord.spec.ts`'s record assertions**

Replace every `differential`/`index` assertion with `average`/`spread` computed by hand from the seeded rounds. `handicapCorrection.spec.ts` corrects a **basis** now — assert both that the chip moves and that the roster shows the new stated number.

- [ ] **Step 4: Fix `unratedCourse.spec.ts`**

Rated and unrated are no longer different code paths — nothing computes from rating or slope. The spec keeps its value as proof that a blank-rating card enters, plays and finalizes; delete its index-bootstrap assertions.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm -F @swng/web exec tsc --noEmit -p tsconfig.e2e.json` (or the repo's existing e2e typecheck target) → clean.

```bash
git add -A
git commit -m "test(e2e): reconcile every spec to the strokes model"
```

---

## Task 9: Beta close-out

**Controller-run. Beta only — no prod deploy, no `publish:web:prod`.**

- [ ] **Step 1: Full gate at HEAD**

Run: `pnpm validate` → exit 0. Run: `pnpm test:contract` → all green.

- [ ] **Step 2: Deploy lambda first**

Run: `pnpm deploy:beta`
Lambda-first is required: `JoinRoundRequest.basis` and the reshaped metrics are new required wire fields, so an old bundle against a new lambda fails only on submit, while a new bundle against an old lambda fails on load.
Expected: `UPDATE_COMPLETE`.

- [ ] **Step 3: Wipe beta round data**

Run: `node scripts/scrapCourseAndRoundData.mjs` (rounds, snapshots, projections; golfers and crews kept).
Every stored `courseHandicap` is semantically ambiguous under the new model, so there is nothing honest to migrate. Record the deleted counts.

- [ ] **Step 4: Publish the web bundle**

Run: `pnpm publish:web:beta`. Record the bundle hash and confirm the CloudFront invalidation completed.

- [ ] **Step 5: Run the gates**

Run: `pnpm e2e:beta` ×2 → all green both runs.
Run: `pnpm e2e:field` → all specs green.

- [ ] **Step 6: Adversarial USE pass on deployed `beta.swng.golf`**

Two throwaway accounts, phone viewport, real PKCE. Reproduce the owner's own field report end to end:

1. Join stating `+30`; second account joins stating `+10`.
2. Assert the card shows 20 dots on the 20 hardest holes for the first and none for the second.
3. Add net skins and gross skins as two games; check each panel's strokes line.
4. Score a hole, concede a hole, pick up a hole; check the pad's three states.
5. Read the totals row: `OUT` / `IN` / `TOT`, gross over net, par totalled.
6. Finalize; read gross · strokes · net with no "adjusted score" anywhere.
7. Open the profile: `What you shoot`, the ten rows, one chart line, no index picker.
8. Open the crew board: `Rounds · Average · Spread · Best` and the *"If you played tomorrow"* line.

Console must be clean. Delete both throwaway Cognito users.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "chore: close out the relative-to-par strokes arc on beta"
```

---

## Self-Review

**Spec coverage.** §1 → Task 7. §2a/§2b → Tasks 1, 3. §2c → Tasks 3, 4. §2d → Tasks 2, 4. §3 → Task 1. §4 → Task 5. §5 → Task 4. §6 → Task 6. §7 → Tasks 1, 4 (the `handicap/present.ts` survival note is a Global Constraint). §8 → Tasks 3, 4, 9. §9 → Tasks 1, 3, 4, 7. §10 → the beta-only Global Constraint and Task 9.

**Type consistency.** `StrokeBasis` (T1) → `Participant.basis` (T3) → `archiveGolferLine`'s `normallyShoots` (T4). `resolveStrokes` (T1) → `reduceRound` (T3) → `gameStrokeAllocation` (T1). `hasCompleteScore`/`scoreOf` (T4) → `averageOf`/`spreadOf` (T4) → `crewScoreboard` (T6). `roundStrokeAllocation` is the renamed `courseHandicapAllocation` and is used under that one name in T3 and T5.

**Known sequencing wrinkle, deliberate:** Task 1 introduces a `basisOf` shim so it can land before the participant field is renamed; Task 3 Step 4 deletes it. Task 3 Step 6 leaves the join pre-fill unwired with a `// Task 4` comment, which Task 4 Step 6 completes. Both are called out at the point of use so a task reviewer sees them as planned rather than as an omission.
