# Relative-to-Par Strokes Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Revised 2026-07-29** after an adversarial review of the first draft. The task boundaries moved: see "Why the boundaries are where they are" below before reordering anything.

**Goal:** Replace the WHS/swng index pipeline with one number a golfer states in plain golf terms — what they normally shoot relative to par — from which strokes are derived by the fold as the difference from the lowest in the field.

**Architecture:** What a player asserts becomes a `StrokeBasis` object (`normally-shoots` or `strokes`) on the participant. Strokes stop being asserted: `reduceRound` derives them across the present roster and every reader consumes the derived value. Rating, slope, allowances, differentials and adjusted gross score are deleted whole; a golfer's record becomes a distribution over `score − par`.

**Tech Stack:** TypeScript (ESM, nodenext), pnpm workspaces, Vitest, Zod (contracts), React 19 + Tailwind 4 (web), AWS CDK (infra), Playwright (field e2e).

## Status — read this first (2026-07-29)

**Nothing is implemented.** This arc is docs-only so far: the spec and this plan. No file under
`packages/` or `apps/` has been touched. Start at Task 1.

**The review gate is met — do not re-run it.** Three reviews ran against these documents: two
scoped passes, then one **open** review (no checklist, reviewer's own judgment) which returned
*ready to implement*. Every Critical and Important from all three is fixed, each recorded in the
commit message that fixed it — `c51e333`, `2e78dbc`, `5a80bc7`. The spec's §11 carries the
design-level revision record.

**Execution mode:** subagent-driven, a fresh agent per task with a review between tasks. This is
the repo default and not a question to re-ask.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-29-relative-to-par-strokes-model-design.md`. Every decision is there; this plan implements it and adds nothing.
- **`pnpm validate` must exit 0 at every commit.**
- **`validate` typechecks the e2e suites.** `package.json:14` → `pnpm -r typecheck`; `e2e/package.json:8` has its own; `apps/web/tsconfig.json:19` includes `"e2e"`. **Every task that changes a wire or domain type must fix the e2e call sites in the SAME commit.** Task 8 is oracle re-derivation and locator reconciliation only — it cannot be where the compile errors get fixed.
- **Beta only.** No `deploy:prod`, no `publish:web:prod`, no change to `STAGE_CONFIG`'s `prod` entry.
- **No migration, no tolerate-old-data machinery.** Beta round data is wiped in Task 9.
- **Language, verbatim:** the join question is `What do you normally shoot, relative to par?`; the measured value is **average**. Never "index", "handicap", "your number", "your usual", "form", or "adjusted score" in user-facing copy.
- **One sign convention, and no special notation** (spec §4). Every signed number on screen is vs-par and renders through `formatOverPar` in `scoring/present.ts`: `+26` over, `E` level, `−2` under. Golf's plus-handicap convention is deleted with the index that required it.
- **`strokes` can never be negative** (spec §2a). Bounded at `min(0)` at the request ingress, and `resolveStrokes` cannot produce one. This is what makes `packages/domain/src/handicap/` — `strokeGrant`, `formatCourseHandicap`, `formatHandicapIndex`, `indexSourcePhrase` — and `allocateStrokes`' negative branch dead code rather than a judgement call. **The word "handicap" leaves the vocabulary too:** `participant-basis-set`, `setBasis.ts`, `POST /rounds/{roundId}/basis`, `basisCorrection.spec.ts`.
- **The compute fence stays enforced.** New domain compute goes in the ESLint banlist in `eslint.config.mjs` and is re-exported through `@swng/client` for web use.
- **Frozen decks** keep their hand-designed **scores** byte-identical. Only expected results are re-derived, by hand, with the derivation in the commit message.

### Why the boundaries are where they are

Three constraints fix the order and cannot be relaxed:

1. `Participant` and `GolferMetrics` are imported by every layer, so Tasks 3 and 5 are **single atomic commits** across domain → contracts → application → adapters → web → e2e.
2. `packages/client/src/scoring.ts:49-60` re-exports `defaultAllowance`, `handicappingFor`, `courseHandicapFor`, `courseHandicapFromRatingSlopePar` and `unratedCourseHandicap`. Deleting any of them breaks that file and its web consumers in the same commit.
3. **Task 4 exists to make Task 5 possible.** `ResultsView.tsx` imports `handicappingFor`; if Task 5 deleted that function while ResultsView still used it, Task 5 would swallow the whole results rewrite. Task 4 rewrites ResultsView to stop *using* it first, while the function still exists. Same trick is unavailable for `crew/scoreboard.ts` (its `netPer18` reads `line.ags`, and the replacement needs `averageOf`), so the scoreboard swap lives inside Task 5.

---

## File Structure

**New**

| File | Responsibility |
|---|---|
| `packages/domain/src/scoring/strokeBasis.ts` | `StrokeBasis` and `resolveStrokes` — the ONE resolution rule |
| `packages/domain/src/golfer/average.ts` | `averageOf`, `spreadOf`, `averageHistory` |

**Deleted**

`packages/domain/src/scoring/allowances.ts` (+test) · `packages/domain/src/handicap/whs.ts` (+`whs.test.ts`, `whs.properties.test.ts`) · `apps/web/src/ui/vsPar.ts`

---

## Task 1: One stroke rule for every game; delete allowances

**Files:**
- Create: `packages/domain/src/scoring/strokeBasis.ts` + test
- Delete: `packages/domain/src/scoring/allowances.ts` + test
- Modify: `packages/domain/src/scoring/{allocation,game,present}.ts`, the five engines, `packages/domain/src/index.ts`, `packages/client/src/scoring.ts`, `packages/contracts/src/{round,commands}.ts`, `apps/web/src/round/AddGameForm.tsx`, `apps/web/src/round/dots.ts`, `apps/web/src/games/GamePanel.tsx`, `apps/web/src/games/describeGame.ts`, `eslint.config.mjs`
- Re-derive: `packages/domain/src/scoring/golden/fieldDeck18.ts` expectations + the five engine tests

**Interfaces:**
- Produces: `StrokeBasis`, `resolveStrokes(bases, holeCount): ReadonlyMap<GolferId, number>` (Tasks 3, 5), `gameTreatment(config): string` (Task 4).

- [ ] **Step 1: Write the failing test for `resolveStrokes`**

Create `packages/domain/src/scoring/strokeBasis.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { anchorOf, resolveStrokes } from "./strokeBasis.js";
import type { GolferId } from "../ids.js";

const g = (s: string) => s as GolferId;
const shoots = (id: string, overPar: number) => ({ golferId: g(id), basis: { kind: "normally-shoots" as const, overPar } });
const takes = (id: string, strokes: number) => ({ golferId: g(id), basis: { kind: "strokes" as const, strokes } });
// Every call passes an explicit anchor — resolveStrokes has no fallback (spec §2b).
const resolve = (bases: Parameters<typeof resolveStrokes>[0], holes: number) => resolveStrokes(bases, holes, anchorOf(bases));

describe("resolveStrokes", () => {
  it("takes the difference from the lowest stated normal score", () => {
    const s = resolve([shoots("blaine", 30), shoots("ravi", 10)], 18);
    expect(s.get(g("blaine"))).toBe(20);
    expect(s.get(g("ravi"))).toBe(0);
  });

  it("gives a player who stated strokes exactly what they said", () => {
    const s = resolve([takes("blaine", 18), shoots("ravi", 10)], 18);
    expect(s.get(g("blaine"))).toBe(18);
    expect(s.get(g("ravi"))).toBe(0);
  });

  it("allocates nothing when only one player's level is known", () => {
    // Spec §2b: strokes cannot be allocated against an unknown level. Correct, not a failure.
    const s = resolve([shoots("blaine", 30), takes("ravi", 0)], 18);
    expect(s.get(g("blaine"))).toBe(0);
    expect(s.get(g("ravi"))).toBe(0);
  });

  it("anchors a lone player against himself", () => {
    expect(resolve([shoots("blaine", 30)], 18).get(g("blaine"))).toBe(0);
  });

  it("halves the difference once, at the end, on a nine-hole card", () => {
    const s = resolve([shoots("blaine", 30), shoots("ravi", 10)], 9);
    expect(s.get(g("blaine"))).toBe(10);
  });

  it("rounds a halved odd difference half-up", () => {
    const s = resolve([shoots("blaine", 25), shoots("ravi", 10)], 9);
    expect(s.get(g("blaine"))).toBe(8); // 15 / 2 = 7.5 → 8
  });

  it("never halves a literal strokes assertion", () => {
    expect(resolve([takes("blaine", 9)], 9).get(g("blaine"))).toBe(9);
  });

  it("clamps a below-zero difference to zero", () => {
    // The departed-player path (spec §2b): reduceRound anchors on the PRESENT field, so a
    // departed player better than everyone still there would otherwise resolve negative. After
    // Task 5 the card renders "●".repeat(dots) and repeat() throws RangeError on a negative, so
    // this clamp is the thing standing between that path and a crash on the live card.
    const s = resolveStrokes([shoots("early", 2)], 18, 10); // anchor from the surviving field
    expect(s.get(g("early"))).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -F @swng/domain vitest run src/scoring/strokeBasis.test.ts`
Expected: FAIL — `Cannot find module './strokeBasis.js'`

- [ ] **Step 3: Implement `strokeBasis.ts`**

```ts
import type { GolferId } from "../ids.js";
import { roundHalfUp } from "./strokes.js";

// What a player asserts about their game (spec §2a) — an object, not an integer. A group saying
// "just give him 18" is the SECOND constructor, not a fudge of the first, so nobody ever
// distorts a true fact about themselves to get the strokes they want.
export type StrokeBasis =
  | { readonly kind: "normally-shoots"; readonly overPar: number }
  | { readonly kind: "strokes"; readonly strokes: number };

// The ONE resolution rule (spec §2b): strokes are the difference from the lowest in the field.
// The anchor is the lowest stated `normally-shoots`; a player who stated strokes gets exactly
// what they said and never enters the anchor.
//
// `holeCount` halves the DIFFERENCE once, at the end — never each player's number first, which
// would round twice. A literal strokes assertion is never halved: it is already a statement
// about this round.
//
// With no stated normal score there is no anchor and nothing to be relative to, so a normal-
// score player gets 0. Correct, not degenerate: strokes cannot be allocated when only one
// person's level is known.
//
// Callers pass only the PRESENT field — reduceRound filters departed seats before calling
// (spec §2b), because a wrong-round joiner who left must not anchor everyone's card.
// The anchor for a field: the lowest stated `normally-shoots` among its members, or undefined
// when nobody stated one. Exported so every caller scopes its OWN field and passes the result.
export const anchorOf = (bases: readonly { readonly basis: StrokeBasis }[]): number | undefined => {
  const stated = bases.flatMap(({ basis }) => (basis.kind === "normally-shoots" ? [basis.overPar] : []));
  return stated.length > 0 ? Math.min(...stated) : undefined;
};

// `anchor` is REQUIRED and this function has NO fallback of its own — deliberately. A fallback
// that computed the anchor from `bases` would silently re-admit a departed player whenever nobody
// still present had stated a normal score, since callers pass the full roster (departed included)
// as `bases` and scope only the ANCHOR to the present field (spec §2b).
export const resolveStrokes = (
  bases: readonly { readonly golferId: GolferId; readonly basis: StrokeBasis }[],
  holeCount: number,
  anchor: number | undefined,
): ReadonlyMap<GolferId, number> => {
  return new Map(
    bases.map(({ golferId, basis }) => {
      if (basis.kind === "strokes") return [golferId, basis.strokes];
      // Clamped at zero — never negative (spec §2b). A departed player better than the surviving
      // anchor was the anchor while they were there and never received a stroke; and after Task 5
      // the card renders "●".repeat(dots), which throws RangeError on a negative.
      const difference = anchor === undefined ? 0 : Math.max(0, basis.overPar - anchor);
      return [golferId, holeCount === 9 ? roundHalfUp(difference / 2) : difference];
    }),
  );
};
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm -F @swng/domain vitest run src/scoring/strokeBasis.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Write the failing allocation test**

Add to `packages/domain/src/scoring/allocation.test.ts`. **The file has no participant-builder helper and no `card` constant** — participants are inline object literals and the card in scope is `fixtureLinks18` (imported at `:11`). Add a local builder and use that card. Keep `courseHandicap` for now; Task 3 renames it.

```ts
const p = (id: string, courseHandicap: number): Participant =>
  ({ golferId: id as GolferId, name: id, tee: "white", courseHandicap });
```

```ts
describe("gameStrokeAllocation", () => {
  const roster = [p("ann", 0), p("bo", 20), p("cy", 25), p("dee", 40)];

  it("allocates off the lowest in that game's OWN field, not the round's", () => {
    const allocation = gameStrokeAllocation(
      { kind: "stroke-play", id: gameId("g1"), scoring: "net", players: [golferId("bo"), golferId("cy")] },
      roster,
      fixtureLinks18,
    );
    expect(totalDots(allocation.get(golferId("bo"))!)).toBe(0);
    expect(totalDots(allocation.get(golferId("cy"))!)).toBe(5);
  });

  it("allocates nothing for a gross game", () => {
    const allocation = gameStrokeAllocation(
      { kind: "skins", id: gameId("g2"), scoring: "gross", players: [golferId("bo"), golferId("cy")] },
      roster,
      fixtureLinks18,
    );
    expect(allocation.size).toBe(0);
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `pnpm -F @swng/domain vitest run src/scoring/allocation.test.ts`
Expected: FAIL — stroke-play currently allocates each player's own 95%-adjusted handicap, so `bo` gets 19.

- [ ] **Step 7: Replace `gameStrokeAllocation` with one implementation**

In `allocation.ts`, delete the five-arm `switch` and replace with:

```ts
// ONE rule for every kind (spec §3): the game's field is its own members, strokes are the
// difference from the lowest among them, allocated by stroke index. The switch this replaced
// encoded five conventions and a hidden allowance percentage; there is nothing per-kind left.
export const gameStrokeAllocation = (
  config: GameConfig,
  participants: readonly RosterEntry[],
  card: CourseCard,
): ReadonlyMap<GolferId, ReadonlyMap<number, number>> => {
  if ("scoring" in config && config.scoring === "gross") return new Map();
  const members = gameMembers(config);
  const holeCount = card.teeSets[0]?.holes.length ?? 18;
  const bases = members.map((id) => ({ golferId: id, basis: basisOf(participantFor(participants, id)) }));
  // A game's frozen players[] never drops a member who leaves, so the game's field excludes
  // departed players from its ANCHOR exactly as the card's does (spec §2b) — otherwise a
  // wrong-round joiner still anchors whichever game he was added to before leaving.
  const present = bases.filter(({ golferId }) => participantFor(participants, golferId).departed !== true);
  const strokes = resolveStrokes(bases, holeCount, anchorOf(present));
  return new Map(
    members.map((id) => [id, dotsByHole(strokes.get(id)!, findTeeSet(card, participantFor(participants, id).tee))]),
  );
};
```

Add the temporary shim, deleted in Task 3 Step 5:

```ts
// TEMPORARY (deleted in Task 3, when Participant.basis replaces courseHandicap): today's stored
// integer is read as an absolute "normally shoots" figure, which is what the rule expects.
const basisOf = (participant: Participant): StrokeBasis => ({ kind: "normally-shoots", overPar: participant.courseHandicap });
```

Delete `allowances.ts` + test. Remove `allowance` from all five `GameConfig` arms; add `readonly scoring: "gross" | "net"` to the `skins` arm of both `GameConfig` and `GameState`.

- [ ] **Step 8: Replace `allowancePhrase` with `gameTreatment`**

In `scoring/present.ts`, delete `allowancePhrase` and `strokePlayTreatment`; add the one function that covers every kind including gross (spec §3):

```ts
// One treatment line for every kind, gross included — the ONE copy every panel and the
// add-game preview render through. Replaces allowancePhrase + strokePlayTreatment, whose split
// left the non-stroke-play kinds rendering a percentage that no longer exists.
export const gameTreatment = (config: GameConfig): string => {
  if ("scoring" in config && config.scoring === "gross") return "Gross — raw scores, no strokes";
  switch (config.kind) {
    case "stroke-play":
    case "skins":
    case "stableford":
      return "Net — uses the strokes on the card";
    case "singles-match":
      return "Strokes are the difference between you two";
    case "fourball-match":
      return "Everyone plays off the lowest of the four";
  }
};
```

Rewrite `strokesNote` to name the field rather than a percentage, and return `undefined` for a gross game.

- [ ] **Step 9: Follow the compiler out to the web**

Run `pnpm build` and fix in order:
- The five engines drop `playingHandicap`/`defaultAllowance`; `skins.ts` gains the gross branch (skip the dots lookup entirely).
- `packages/client/src/scoring.ts:49-60` drops `defaultAllowance` from its re-export list.
- `contracts/{round,commands}.ts` drop `allowance` from every game schema; the skins schema gains `scoring: z.enum(["gross", "net"])`.
- `apps/web/src/games/GamePanel.tsx:65` renders `gameTreatment(config)` instead of `allowancePhrase`; `describeGame.ts` follows.
- `apps/web/src/round/dots.ts` — `strokesSummary` returns nothing for a gross game (its all-zero copy "No strokes — everyone plays off 0" is false for a game with no strokes by definition).
- `AddGameForm.tsx` — delete the allowance percent input and the "Adjust" disclosure; add a gross/net radio to the skins branch mirroring stroke play's.
- `eslint.config.mjs` — banlist gains `resolveStrokes` and `anchorOf`, loses `defaultAllowance`.
- Any e2e spec that adds a game with an allowance.

- [ ] **Step 10: Re-derive the golden deck expectations by hand**

`golden/fieldDeck18.ts` keeps its hole-by-hole scores byte-identical; its expected standings change. Per kind:

- **stroke-play, stableford, skins** — change: each player was allocated their own handicap (×0.95 for the first two), now the difference from the game's lowest.
- **fourball-match** — changes: same relative allocation, but the 90% is gone. Deck CHs 8/2/15/5 gave dots 5/0/12/3; they now give 6/0/13/3.
- **singles-match** — **unchanged**: `allocation.ts:46-59` already allocated the 100% difference off the lower player.

Compute each by hand, run `dotsByHole` over the fixture course's stroke index, and put the derivation in the commit message.

- [ ] **Step 11: Gate and commit**

Run: `pnpm validate` → exit 0.

```bash
git add -A
git commit -m "feat(scoring): one stroke rule for every game; delete the allowance table

Every game allocates off the lowest in its OWN field, by stroke index. The
five-arm per-kind switch and the 95/90/100 allowance table are deleted; skins
gains a gross/net choice; allowancePhrase becomes gameTreatment, which covers
every kind including gross.

Golden deck scores byte-identical; expectations re-derived by hand:
<paste the derivation>"
```

---

## Task 2: A conceded hole carries its score

**Files:**
- Modify: `packages/domain/src/round/holeResult.ts`, `packages/contracts/src/{round,commands}.ts`, the five engines (`{strokePlay,stableford,skins,singlesMatch,fourballMatch}.ts` — Step 4 changes all of them), `apps/web/src/round/{ScorePad,ScorecardGrid}.tsx`
- **Compile-forced by the required `strokes` field** — every existing bare `{ kind: "conceded" }` literal, all in this commit: `packages/domain/src/scoring/golden/deck.ts:18,53-54` (`toResult` builds one; `fieldDeck18` contains NO conceded cell, so the honest fix is dropping `"conceded"` from `FixtureScores` entirely), `packages/domain/src/handicap/whs.test.ts:34,102-104`, `packages/domain/src/golfer/record.test.ts:91,138,147`, `packages/domain/src/round/state.test.ts:94`, `packages/domain/src/round/archive.test.ts:433`, `packages/domain/src/scoring/fourballMatch.test.ts:38-43`, `apps/web/src/games/describeGame.test.ts:135`, `apps/web/src/round/ScorecardGrid.test.tsx:231`
- **Behaviour-flipped tests:** `packages/domain/src/scoring/singlesMatch.test.ts:37` asserts "a conceded hole is lost" — the reversed semantics. Rewrite it, don't delete it.
- Test: `packages/contracts/src/round.test.ts`, the four engine tests in Step 4, `apps/web/src/round/ScorePad.test.tsx`

Golden-deck **expectations do not move** on this task: `fieldDeck18.ts:44` holds one picked-up cell and no conceded one, and `crewSeasonDeck.ts` has neither.

- [ ] **Step 1: Write the failing contract test**

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

```ts
  // The hole was decided but the player would have finished it — the score the group says out
  // loud. A CONCEDED HOLE IS A SCORED HOLE EVERYWHERE (spec §2d): every engine, the card's
  // totals and the average treat it exactly as a `strokes` cell, because you made the 4. Only
  // two places distinguish it — the card's `5c` glyph, and fullyHoledOut, which gates Best and
  // the milestones and has always excluded it.
  | { readonly kind: "conceded"; readonly strokes: number }
```

Mirror it in `contracts/round.ts`'s stored-event schema (**unbounded** — Arc A's placement rule) and in `contracts/commands.ts:104-107`'s `scoreResultInputArms` (**bounded**, `z.number().int().min(1).max(30)`, matching the existing `strokes` arm). The `[A] extends [B]` exhaustiveness guard fails the build if type and schema diverge; it does **not** catch a missing bound, so add it deliberately.

- [ ] **Step 4: Make a conceded hole score like the number it carries**

A conceded hole is a scored hole in every engine (spec §2d). **No engine has a `case "conceded"` arm** — each gates on `cell.result.kind === "strokes"` (`skins.ts:38`, `strokePlay.ts:29`, `stableford.ts:28`, and the equivalent in `singlesMatch.ts`/`fourballMatch.ts`) and treats everything else as "no competitive score". The change is to broaden each guard to accept `"conceded"` too and read `.strokes` off whichever arm matched.

```ts
// singlesMatch.test.ts — you made the 4, so you win the hole.
it("scores a conceded hole at the number it carries", () => {
  const state = stateWith({ ann: { kind: "strokes", strokes: 5 }, bo: { kind: "conceded", strokes: 4 } });
  expect(scoreSinglesMatch(config, state).leader).toBe(golferId("bo"));
});

// stableford.test.ts — a conceded par is worth its points, not zero.
it("scores a conceded hole's Stableford points", () => {
  const state = stateWith({ ann: { kind: "conceded", strokes: 4 } }); // par 4, no dots
  expect(scoreStableford(config, state).lines[0]!.points).toBe(2);
});

// skins.test.ts — a conceded low score takes the skin.
it("lets a conceded hole win a skin", () => {
  const state = stateWith({ ann: { kind: "strokes", strokes: 5 }, bo: { kind: "conceded", strokes: 4 } });
  expect(scoreSkins(config, state).lines.find((l) => l.golferId === golferId("bo"))!.skins).toBe(1);
});

// strokePlay.test.ts — the net-double-bogey cap now applies to a PICKED-UP hole only.
it("totals a conceded hole at its score and caps only a pickup", () => {
  const state = stateWith({ ann: { kind: "conceded", strokes: 4 } });
  expect(scoreStrokePlay(config, state).lines[0]!.gross.total).toBe(4);
});
```

`strokePlay.ts:40`'s `netDoubleBogey(hole.par, holeDots) - holeDots` stays, narrowed to the `picked-up` branch — the only kind with no number to use. `stableford.ts`'s "picked-up/conceded score zero points outright" comment narrows to picked-up as well.

- [ ] **Step 5: Update the pad and the glyph**

`ScorePad.tsx`: `Conceded` becomes a disclosure revealing the same number row, labelled `Conceded — what would you have made?`. Scoring stays two taps; conceding costs three. Comment it as a deliberate deviation from `product.md` §9 for a rarer, deliberate act.

`ScorecardGrid.tsx`'s `glyphFor`: render a conceded hole as `` `${result.strokes}c` ``.

- [ ] **Step 6: Gate and commit**

Run: `pnpm validate` → exit 0.

```bash
git add -A
git commit -m "feat(round): a conceded hole carries the score you would have made"
```

---

## Task 3: `StrokeBasis` replaces `courseHandicap`; the fold derives strokes

**One atomic commit across every layer including e2e.**

**Files:**
- Modify: `packages/domain/src/round/{participant,state,events}.ts`, `packages/domain/src/scoring/allocation.ts`, `packages/domain/src/golfer/record.ts`, `packages/contracts/src/{round,commands}.ts`, `packages/application/src/rounds/{startRound,joinRound,setHandicap}.ts`, `packages/client/src/scoring.ts`, `apps/web/src/routes/{JoinRoundPage,CreateRoundPage,RoundPage}.tsx`, `apps/web/src/round/SetupPanel.tsx`
- E2E (same commit): `apps/web/e2e/support.ts`, every spec calling its join helper, `e2e/roundSlice.e2e.test.ts`, `e2e/syncSession.e2e.test.ts`, `apps/web/e2e/crewSeasonDeck.ts:174-177`
- Test: every `*.test.ts` carrying a `courseHandicap:` fixture

**Interfaces:**
- Consumes: `resolveStrokes` (Task 1).
- Produces: `Participant.basis: StrokeBasis`, `RosterEntry.strokes: number` (Tasks 4, 5).

- [ ] **Step 1: Write the failing fold tests**

Add to `packages/domain/src/round/state.test.ts`:

```ts
it("derives strokes across the roster — a later, better joiner re-runs the fold", () => {
  const one = reduceRound([created(card), joined("blaine", { kind: "normally-shoots", overPar: 30 })]);
  expect(strokesOf(one, "blaine")).toBe(0);

  const two = reduceRound([
    created(card),
    joined("blaine", { kind: "normally-shoots", overPar: 30 }),
    joined("ravi", { kind: "normally-shoots", overPar: 10 }),
  ]);
  expect(strokesOf(two, "blaine")).toBe(20);
  expect(strokesOf(two, "ravi")).toBe(0);
});

it("excludes a departed player from the anchor", () => {
  // Spec §2b: a wrong-round joiner who leaves must not permanently anchor everyone's card.
  const state = reduceRound([
    created(card),
    joined("blaine", { kind: "normally-shoots", overPar: 30 }, hlc(1)),
    joined("ravi", { kind: "normally-shoots", overPar: 10 }, hlc(2)),
    joined("stray", { kind: "normally-shoots", overPar: 2 }, hlc(3)),
    left("stray", hlc(4)),
  ]);
  expect(strokesOf(state, "blaine")).toBe(20);
  expect(strokesOf(state, "ravi")).toBe(0);
});

it("applies a handicap-set basis HLC-later than the join", () => {
  const state = reduceRound([
    created(card),
    joined("blaine", { kind: "normally-shoots", overPar: 30 }, hlc(1)),
    joined("ravi", { kind: "normally-shoots", overPar: 10 }, hlc(2)),
    handicapSet("blaine", { kind: "strokes", strokes: 18 }, hlc(3)),
  ]);
  expect(strokesOf(state, "blaine")).toBe(18);
  // The stated normal score is REPLACED by the new assertion, not fudged.
  expect(basisOf(state, "blaine")).toEqual({ kind: "strokes", strokes: 18 });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm -F @swng/domain vitest run src/round/state.test.ts`
Expected: FAIL — `strokes` does not exist on the roster entry.

- [ ] **Step 3: Change the participant**

```ts
import type { StrokeBasis } from "../scoring/strokeBasis.js";

export interface Participant {
  readonly golferId: GolferId;
  readonly name: string;
  readonly tee: string;         // TeeSet name within the round's frozen CourseCard
  readonly basis: StrokeBasis;  // what this player ASSERTED — never a derived number
}

export interface RosterEntry extends Participant {
  readonly departed?: boolean;
  // DERIVED by reduceRound across the PRESENT roster (spec §2b). No client asserts it and no
  // request body accepts it; the sealed archive freezes it because a snapshot must be
  // self-contained.
  readonly strokes: number;
}
```

- [ ] **Step 4: Derive strokes in the fold**

In `state.ts`, `participant-handicap-set` carries `basis: StrokeBasis` (mirror in `events.ts`); keep the HLC rule byte-identical. After the roster map is built:

```ts
// Strokes are the fold's output (spec §2b). Departed seats stay on the roster — their scored
// holes still settle — but are excluded from the ANCHOR: a wrong-round joiner who left must not
// set everyone else's dots. The anchor is computed from the PRESENT field and applied to
// everyone, so a departed player resolves against the surviving anchor (clamped at zero inside
// resolveStrokes — they were the anchor while they were there).
const holeCount = card.teeSets[0]?.holes.length ?? 18;
const present = roster.filter((entry) => entry.departed !== true);
const strokes = resolveStrokes(
  roster.map(({ golferId, basis }) => ({ golferId, basis })),
  holeCount,
  anchorOf(present), // the anchor is scoped to the PRESENT field; resolveStrokes has no fallback
);
const participants = roster.map((entry) => ({ ...entry, strokes: strokes.get(entry.golferId)! }));
```

**One pass, one anchor.** Do not compute a second anchor over the departed players — that would resolve two departed players against each other rather than against the surviving field, which is a third behaviour neither the spec nor this plan sanctions.

- [ ] **Step 5: Delete the Task 1 shim; rename the card allocator**

Remove `basisOf` from `allocation.ts`; read `participant.basis`. Rename `courseHandicapAllocation` → `roundStrokeAllocation` reading the derived value:

```ts
export const roundStrokeAllocation = (
  participants: readonly RosterEntry[],
  card: CourseCard,
): ReadonlyMap<GolferId, ReadonlyMap<number, number>> =>
  new Map(participants.map((p) => [p.golferId, dotsByHole(p.strokes, findTeeSet(card, p.tee))]));
```

Update `client/scoring.ts`'s re-export and the ESLint banlist to the new name.

- [ ] **Step 6: Change the wire**

In `contracts/commands.ts`, define once and use for `JoinRoundRequest`, `StartRoundRequest`'s host, and the set-handicap body:

```ts
export const strokeBasisSchema = z.discriminatedUnion("kind", [
  // Signed: a golfer who shoots two under par states -2.
  z.object({ kind: z.literal("normally-shoots"), overPar: z.number().int().min(-20).max(100) }),
  // NOT signed. Under a relative model the anchor is the best player at 0 and nobody gives
  // strokes back — giving A two is the same round as taking two from B, which is what the rule
  // already produces. min(0) makes the plus-handicap case unrepresentable (spec §2a).
  z.object({ kind: z.literal("strokes"), strokes: z.number().int().min(0).max(100) }),
]);
```

Bounds follow Arc A's placement rule: **request schemas only**. `contracts/round.ts:171`'s stored-event arm takes an **unbounded** twin.

Rename in the same commit: the event `participant-handicap-set` → `participant-basis-set`, `packages/application/src/rounds/setHandicap.ts` → `setBasis.ts`, and `routes.ts:329`'s `/rounds/{roundId}/handicap` → `/rounds/{roundId}/basis` (with its comment at `:94`).

**Two of the rename sites are typecheck-invisible and must be done by hand:**

- `apps/infra-cdk/lib/swngStack.ts:97` — `HTTP_ROUTES` carries the route as a string literal, and `apps/infra-cdk/test/swngStack.test.ts:753` pins it. Caught only by `test/routesParity.test.ts` in validate's *test* phase, not by the compiler. (Deploy safety verified: `/handicap` is **not** in `ANON_THROTTLED_ROUTES` (`swngStack.ts:194`), so no stage `RouteSettings` key names it and the stage-`DependsOn`-every-route guard regenerates cleanly — this is not a deploy-#9-class wedge.)
- `apps/web/src/api.ts:185-190` — the URL is built from a template string, and `api.test.ts:951` pins whatever both sides happen to say, so a missed rename stays green until the live gate.

- [ ] **Step 7: Change the join and roster surfaces**

`JoinRoundPage.tsx` — replace the strokes field with one number input labelled **`What do you normally shoot, relative to par?`**. Delete `resolveIndex`, `courseHandicapFromRatingSlopePar`, `unratedCourseHandicap`, `formatHandicapIndex` and the whole `suggestion` block. Leave the pre-fill unwired with a `// Task 5: seed from record.metrics.average` comment. Submit `{ code, tee, basis: { kind: "normally-shoots", overPar: parsed } }`.

`SetupPanel.tsx` — the roster row reads `name — tee — normally +30 · gets 20`, EDIT edits the **basis**, and a second control `Give strokes directly` writes `{ kind: "strokes", strokes }`. Keep the mutual-exclusion test and add a plus-handicap fixture.

`RoundPage.tsx:279,337-340` — the set-handicap call sends a basis.

- [ ] **Step 8: Sweep the e2e call sites in this commit**

`apps/web/e2e/support.ts:196-201`'s join helper sends `basis`. Every browser spec filling the join form targets the new label — read `JoinRoundPage.tsx`'s JSX for the accessible name, do not take it from this plan. `crewSeasonDeck.ts:174-177`'s four `courseHandicap: 0` participants become `basis: { kind: "normally-shoots", overPar: 0 }` — **all four are 0, so no deck expectation moves.**

- [ ] **Step 9: Gate and commit**

Run: `pnpm validate` → exit 0 (this is the long compiler-driven sweep).

```bash
git add -A
git commit -m "feat(round): StrokeBasis replaces courseHandicap; the fold derives strokes

What a player asserts is an object, not an integer. Strokes are no longer
asserted — reduceRound resolves them across the PRESENT roster as the
difference from the lowest in the field, so a fifth player joining re-runs the
fold and a departed wrong-round joiner cannot anchor anyone."
```

---

## Task 4: The card reads like a scorecard; the finished round stops speaking WHS

Web-only and additive. **It exists to get `ResultsView` off `handicappingFor` before Task 5 deletes that function** — otherwise the results rewrite would be swallowed into Task 5's already-atomic commit.

**Files:**
- Modify: `apps/web/src/round/{ScorecardGrid,ResultsView}.tsx` + tests

- [ ] **Step 1: Write the failing totals test**

```tsx
it("totals the card like a scorecard — OUT, IN and TOT, gross and net", () => {
  render(<ScorecardGrid state={stateWithFullCard} recordScore={() => {}} />);
  const tot = screen.getByRole("row", { name: /tot/i });
  expect(within(tot).getByText("72")).toBeTruthy();  // par
  expect(within(tot).getByText("96")).toBeTruthy();  // Blaine gross
  expect(within(tot).getByText("76")).toBeTruthy();  // Blaine net
});

it("counts a conceded hole in the totals at its recorded score", () => {
  // Spec §4: any other rule makes the finalized card disagree with the same round's line in
  // the golfer's record, which reads conceded strokes.
  render(<ScorecardGrid state={stateWithOneConcededFive} recordScore={() => {}} />);
  expect(within(screen.getByRole("row", { name: /tot/i })).getByText("96")).toBeTruthy();
});

it("dashes a segment containing a pickup", () => {
  render(<ScorecardGrid state={stateWithOnePickup} recordScore={() => {}} />);
  expect(within(screen.getByRole("row", { name: /out/i })).getByText("–")).toBeTruthy();
});
```

- [ ] **Step 2: Run and watch fail**

Run: `pnpm -F @swng/web vitest run src/round/ScorecardGrid.test.tsx`
Expected: FAIL — no row named TOT exists.

- [ ] **Step 3: Add the totals rows**

Add a `<tfoot>` after `</tbody>` with `OUT` (holes 1–9), `IN` (10–18, omitted on a 9-hole card) and `TOT`. The hole column carries the par sum; each player column carries gross over net via the same `netStrokes(gross, dots)` the cells use. A segment total counts `strokes` and `conceded` cells; any `picked-up` or missing cell in the segment renders `–`.

- [ ] **Step 4: Rewrite the finished round**

In `ResultsView.tsx`, delete `deriveHandicapping`, the `handicappingFor` import, the `response.handicapping` prop path, and the "Posted to handicaps" section. Replace with:

```tsx
<h2>Final totals</h2>
<p>Par {parTotal}</p>
<ul aria-label="Final totals">
  {state.participants.map((p) => (
    <li key={p.golferId}>
      <GolferLink golferId={p.golferId} name={p.name} />
      {` — ${grossOf(p)} gross · ${strokesLabel(p.strokes)} · ${grossOf(p) - p.strokes} net`}
    </li>
  ))}
</ul>
```

Strokes are non-negative by construction (spec §2a), so the column is `−${p.strokes}` for a receiver and `0` otherwise — no formatter, no grant branch, no plus convention. **Do NOT reach for `formatCourseHandicap`**: it renders a negative as `+N`, so a 20-stroke receiver would come out `"+20"` — in golf, a plus-20 who *gives* 20. It is deleted in Task 5 for exactly this reason.

Add a why-comment: no fourth column, because net already ranks players against their own stated level (spec §4).

- [ ] **Step 5: Gate and commit**

Run: `pnpm validate` → exit 0.

```bash
git add -A
git commit -m "feat(web): scorecard totals row; the finished round shows gross, strokes and net"
```

---

## Task 5: Delete WHS; the average replaces the index

**One atomic commit across every layer including e2e.** Everything here is forced by one deletion set and cannot be split — see "Why the boundaries are where they are".

**Files:**
- Create: `packages/domain/src/golfer/average.ts` + test
- Delete: `packages/domain/src/handicap/whs.ts` + its two tests, `apps/web/src/ui/vsPar.ts`
- Modify: `packages/domain/src/golfer/{golfer,record,metrics,analytics}.ts`, `packages/domain/src/handicap/present.ts` (+test), `packages/domain/src/scoring/allocation.ts`, `packages/domain/src/round/archive.ts`, `packages/domain/src/crew/scoreboard.ts` (+test), `packages/domain/src/index.ts`, `packages/client/src/scoring.ts`, `packages/contracts/src/{golfers,commands,crews}.ts`, `packages/application/src/rounds/finalizeRound.ts`, `packages/application/src/golfers/{recordOf,getMyRecord,getMyRounds,getGolfer,getMyGolfer,golferView,updateMyGolfer,ensureGolfer}.ts`, `packages/application/src/crews/getSeasonStandings.ts`, `packages/application/src/testing/fakes.ts`, `packages/adapters-dynamodb/src/createDynamoGolferStore.ts`, `apps/web/src/routes/ProfilePage.tsx`, `apps/web/src/golfers/{GolferPage,RecordSections}.tsx`, `apps/web/src/crews/SeasonPanel.tsx`, `apps/web/src/routes/JoinRoundPage.tsx`, `eslint.config.mjs`
- **Compile-forced, same commit:** every `*.test.ts` carrying a `handicapping:` fixture — `domain/src/crew/{analytics,ledger}.test.ts`, `application/src/crews/seasonSlice.test.ts`, `application/src/projections/{projectionSlice,rebuildProjections}.test.ts`, `application/src/rounds/getRoundArchive.test.ts`, `lambda/src/compositionRoot.test.ts`, `adapters-dynamodb/src/contract/{journal,snapshotStore}.contract.test.ts`, `adapters-dynamodb/src/parseSnapshotStreamImage.test.ts` (the last three also carry `courseHandicap:` literals for Task 3)
- E2E (same commit): `identityRecord.spec.ts`, `crewSeason.spec.ts:160,341,362`, `crewSeasonDeck.ts:252-259`

- [ ] **Step 1: Write the failing average test**

Create `packages/domain/src/golfer/average.test.ts`. Build fixtures from **integer per-hole scores** so the arithmetic is exact:

```ts
import { describe, expect, it } from "vitest";
import { averageOf, spreadOf } from "./average.js";
import type { GolferRoundLine } from "./record.js";

// n holes of par 4; `perHole` is each hole's gross. 18 × 4 = par 72.
const line = (id: string, holes: 9 | 18, perHole: number): GolferRoundLine => ({
  roundId: id as GolferRoundLine["roundId"],
  courseName: "Test", tee: "white", holes, par: holes * 4, strokes: 0,
  distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  holeResults: Array.from({ length: holes }, (_, i) => ({ hole: i + 1, par: 4, result: { kind: "strokes" as const, strokes: perHole } })),
});

describe("averageOf", () => {
  it("averages score minus par over finished rounds", () => {
    // 5/hole → 90 (+18); 6/hole → 108 (+36). Mean 27.
    expect(averageOf([line("a", 18, 5), line("b", 18, 6)])).toBe(27);
  });

  it("counts a nine-hole round doubled", () => {
    // 9 × 6 = 54 on par 36 → +18, contributes +36.
    expect(averageOf([line("a", 9, 6)])).toBe(36);
  });

  it("counts a round containing a conceded hole", () => {
    const base = line("a", 18, 5);
    const conceded = { ...base, holeResults: base.holeResults!.map((h, i) => (i === 0 ? { ...h, result: { kind: "conceded" as const, strokes: 5 } } : h)) };
    expect(averageOf([conceded])).toBe(18);
  });

  it("skips a round containing a pickup — there is no score", () => {
    const base = line("a", 18, 5);
    const pickedUp = { ...base, holeResults: base.holeResults!.map((h, i) => (i === 0 ? { ...h, result: { kind: "picked-up" as const } } : h)) };
    expect(averageOf([pickedUp])).toBeUndefined();
  });

  it("skips a round whose card has a gap", () => {
    const base = line("a", 18, 5);
    expect(averageOf([{ ...base, holeResults: base.holeResults!.slice(1) }])).toBeUndefined();
  });

  it("uses only the last 10 finished rounds", () => {
    const lines = [...Array.from({ length: 10 }, (_, i) => line(`old${i}`, 18, 6)), ...Array.from({ length: 10 }, (_, i) => line(`new${i}`, 18, 5))];
    expect(averageOf(lines)).toBe(18); // the older +36 rounds fall out of the window
  });

  it("is undefined with no finished rounds", () => {
    expect(averageOf([])).toBeUndefined();
  });
});

describe("spreadOf", () => {
  it("is undefined below five finished rounds", () => {
    expect(spreadOf(Array.from({ length: 4 }, (_, i) => line(`r${i}`, 18, 5)))).toBeUndefined();
  });

  it("is zero for five identical rounds", () => {
    expect(spreadOf(Array.from({ length: 5 }, (_, i) => line(`r${i}`, 18, 5)))).toBe(0);
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `pnpm -F @swng/domain vitest run src/golfer/average.test.ts`
Expected: FAIL — `Cannot find module './average.js'`

- [ ] **Step 3: Add the two predicates to `analytics.ts`**

```ts
// Every hole has a NUMBER — a stroke count or a conceded score (spec §2d). Distinct from
// fullyHoledOut, which is stricter (a conceded putt means you did not hole out) and still gates
// Best and the milestones. This one gates the average, which is why match rounds count.
export const hasCompleteScore = (line: GolferRoundLine): boolean =>
  line.holeResults !== undefined &&
  line.holeResults.length === line.holes &&
  line.holeResults.every((h) => h.result.kind === "strokes" || h.result.kind === "conceded");

// Sum over a line with a complete score — call only when hasCompleteScore(line).
export const scoreOf = (line: GolferRoundLine): number =>
  line.holeResults!.reduce((sum, h) => sum + (h.result.kind === "strokes" || h.result.kind === "conceded" ? h.result.strokes : 0), 0);
```

- [ ] **Step 4: Implement `average.ts`**

```ts
import type { RoundId } from "../ids.js";
import { roundHalfUp } from "../scoring/strokes.js";
import { hasCompleteScore, scoreOf } from "./analytics.js";
import type { GolferRoundLine } from "./record.js";

// What you normally shoot relative to par, per 18 holes (spec §2c). A golfer can check it by
// adding up the rounds on their own profile — which is the whole point. A nine-hole round
// contributes its figure DOUBLED: imperfect and accepted (spec §2d).
export const AVERAGE_WINDOW = 10;
const SPREAD_MIN_ROUNDS = 5;

export const overPar = (line: GolferRoundLine): number => {
  const raw = scoreOf(line) - line.par;
  return line.holes === 9 ? raw * 2 : raw;
};

// Only rounds with a score. A pickup means there is no score, so no number is invented for it.
export const scoredOverPar = (lines: readonly GolferRoundLine[]): readonly number[] =>
  lines.filter(hasCompleteScore).map(overPar);

const meanOf = (values: readonly number[]): number => values.reduce((s, v) => s + v, 0) / values.length;

// Exported so the crew board can average its OWN set (every finished round in the season
// window) without re-deriving the arithmetic — the board must not silently apply this file's
// rolling 10 on top of the season window (spec §6).
export const averageOfValues = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : roundHalfUp(meanOf(values));

export const spreadOfValues = (values: readonly number[]): number | undefined => {
  if (values.length < SPREAD_MIN_ROUNDS) return undefined;
  const mean = meanOf(values);
  return roundHalfUp(Math.sqrt(meanOf(values.map((v) => (v - mean) ** 2))) * 10) / 10;
};

export const averageOf = (lines: readonly GolferRoundLine[]): number | undefined =>
  averageOfValues(scoredOverPar(lines).slice(-AVERAGE_WINDOW));

export const spreadOf = (lines: readonly GolferRoundLine[]): number | undefined =>
  spreadOfValues(scoredOverPar(lines).slice(-AVERAGE_WINDOW));

export interface AveragePoint {
  readonly roundId: RoundId;
  readonly average: number;
}

// One point per CONTRIBUTING round — a round with a pickup is not a data point.
export const averageHistory = (lines: readonly GolferRoundLine[]): readonly AveragePoint[] => {
  const window: number[] = [];
  const points: AveragePoint[] = [];
  for (const line of lines) {
    if (!hasCompleteScore(line)) continue;
    window.push(overPar(line));
    if (window.length > AVERAGE_WINDOW) window.shift();
    points.push({ roundId: line.roundId, average: averageOfValues(window)! });
  }
  return points;
};
```

- [ ] **Step 5: Add `formatOverPar`; delete `packages/domain/src/handicap/` entirely**

In `scoring/present.ts`, beside `underPar` — its own family, not a handicap module:

```ts
// A vs-par number: positive is over par, E is level, minus is under. The ONE signed-number
// convention left in the product (spec §4). Golf's "+2 means better than scratch" notation
// existed only because a handicap index is a number where lower is better; a vs-par score has
// no such problem. Absorbs apps/web/src/ui/vsPar.ts so there is one copy.
export const formatOverPar = (value: number): string => (value === 0 ? "E" : value > 0 ? `+${value}` : `${value}`);
```

Then `rm -r packages/domain/src/handicap/` — `present.ts`, `present.test.ts` and the already-deleted `whs.*`. That removes `formatHandicapIndex`, `formatCourseHandicap`, `strokeGrant` and `indexSourcePhrase` together, which is correct: every one of them exists to render a NEGATIVE stroke count, and `strokes` is bounded at zero (Task 3 Step 6).

Delete `apps/web/src/ui/vsPar.ts`. Delete `allocateStrokes`' negative branch (`strokes.ts:12-22`) and **every test that depends on it**: `allocation.test.ts:106`, `SetupPanel.test.tsx:261-274`, `strokes.test.ts:38-40` (`allocateStrokes(-2, …)`), `strokes.test.ts:72-74` (negative-dots `netStrokes`), and `strokes.properties.test.ts:17`'s `fc.integer({ min: -18 … })` generator, which must be re-floored at 0. Simplify `ScorecardGrid.tsx:92-100` to `"●".repeat(dots)` (the hollow `○` give-back glyph has no reachable state — and `repeat` throws `RangeError` on a negative, which is why Task 1's clamp is load-bearing) and `dots.ts:27`'s `strokesSummary` to drop its grant branch.

- [ ] **Step 6: Delete WHS and reshape the metrics**

- `rm packages/domain/src/handicap/whs.ts packages/domain/src/handicap/whs.test.ts packages/domain/src/handicap/whs.properties.test.ts`
- `golfer/golfer.ts`: delete `IndexSource`, `HandicapProfile`, `Golfer.handicap`.
- `golfer/metrics.ts`: delete `IndexMetric`, `IndexPoint`, `detailsOf`, `indexHistoryOf`, `resolveIndex`, `ResolvedIndex`. `GolferMetrics` becomes `{ average?, spread?, typicalEighteen, averageHistory, bests, milestones }`.
- `golfer/record.ts`: `courseHandicap` → `strokes`; add `normallyShoots?: number` (from `participant.basis` when it is a `normally-shoots`) and `score?: number` (`scoreOf(line)` when `hasCompleteScore`); delete `ags`/`differential`. Also **count conceded cells in the distribution** at `record.ts:52-56` — they carry a number now, and leaving them out would make "your typical 18" disagree with the average built from the same card (spec §2d).
- `golfer/courseRecord.ts:35`: count conceded cells in the per-hole insights, same reason.
- `scoring/allocation.ts`: delete `handicappingFor`. `round/archive.ts`: delete `RoundArchive.handicapping`.
- `client/scoring.ts:49-60`: drop `handicappingFor`, `courseHandicapFor`, `courseHandicapFromRatingSlopePar`, `unratedCourseHandicap`. **Add nothing.** `averageOf`/`spreadOf` are server-computed and served — re-exporting them would invite a fence-legal but boundary-wrong on-device average — and `formatOverPar` is a presentation formatter the web imports directly, like `underPar` already does (`ScorecardGrid.tsx:3`).
- `domain/index.ts` and `eslint.config.mjs`: exports and banlist follow.

- [ ] **Step 7: Swap the crew scoreboard in the same commit**

`crew/scoreboard.ts`'s `netPer18` reads `line.ags`, which no longer exists. Replace:

```ts
export interface ScoreboardLine {
  readonly golferId: GolferId;
  readonly rounds: number;
  readonly average?: number;
  readonly spread?: number;
  readonly best18?: { readonly gross: number; readonly toPar: number };
}
```

`average`/`spread` fold `averageOfValues`/`spreadOfValues` over `scoredOverPar(windowed)` — **every** finished round in the window, with **no `.slice(-10)`** (spec §6: `Rounds 12` beside an average of 10 of them would be a lie on the same row). Delete `netPer18`, `NET_PER_18_MIN_ROUNDS`, `index`, `indexDelta` and the `golferMetrics` import. Total order: `average` ascending with absent LAST, then `rounds` descending, then `golferId`.

- [ ] **Step 8: Follow the compiler through application, adapters, web and e2e**

- `finalizeRound.ts:61,90` stop returning `handicapping`; `contracts/commands.ts:173,213-222` drop `handicappingEntrySchema` and the response field.
- `recordOf.ts`/`getMyRecord.ts`/`getGolfer.ts`: serve the new metrics; `toWireLine` maps `strokes`/`normallyShoots`, drops `ags`/`differential`.
- `golferView.ts`/`updateMyGolfer.ts`/`ensureGolfer.ts:34`/`testing/fakes.ts:247`: drop `indexSource` from the view, the PUT body and every mint.
- `adapters-dynamodb/src/createDynamoGolferStore.ts` (`:15,29,51,57-61,106`): drop the `indexSource` attribute and its legacy fold; update the contract tests.
- `ProfilePage.tsx`: delete the whole "Your index" section — source picker, `Use this`, override box, the `applyGolfer` index path. Name and home course only.
- `GolferPage.tsx:4,80,87`: drop `resolveIndex`/`indexSourcePhrase`/`formatHandicapIndex`.
- `CreateRoundPage.tsx:6,130-133` and `JoinRoundPage.tsx:5,130-133`: delete the `strokeGrant` "You give N" branch — the lead is just the number.
- `SetupPanel.tsx:2,157`: `— CH {formatCourseHandicap(...)}` becomes `— gets {p.strokes}`.
- `RecordSections.tsx:4,19,158,165`: headline `What you shoot` rendering `metrics.average` through **`formatOverPar`**, subtitle `your last 10 finished rounds, score minus par`. The chart plots `averageHistory` as ONE line — delete the WHS series, its legend marker and the two-line caption; keep the 20-point window, nice-bounds/min-span-4 axis, endpoint emphasis and date anchors. Axis tick labels move from `formatCourseHandicap` to `formatOverPar` — note this **flips their sign rendering**, which is the point: a tick at −2 on an average chart means two under par, not a plus-2 handicap.
- `SeasonPanel.tsx` + `contracts/crews.ts`: headers `Rounds · Average · Spread · Best`; `average` through `formatOverPar`, `spread` as `±N.N`, `—` where absent.
- `JoinRoundPage.tsx`: wire the pre-fill to `record.metrics.average` (removing Task 3's `// Task 5` comment); blank when absent — no floor, no fallback.
- E2E: `identityRecord.spec.ts`'s `differential`/`index` assertions become `average`/`spread` computed by hand from the seeded rounds; `crewSeason.spec.ts:160,341,362` and `crewSeasonDeck.ts:252-259` drop `netPer18`/`index` and assert `average`/`spread`. **The deck's CHs are all 0, so no scoring number moves — only the removed columns.**

- [ ] **Step 9: Gate and commit**

Run: `pnpm validate` → exit 0. Then `pnpm test:contract` → green.

```bash
git add -A
git commit -m "feat(golfer): delete the WHS/swng index; the average replaces it

One number from the last 10 finished rounds, score minus par, a nine-hole round
counting doubled. A round containing a pickup has no score and does not
contribute; a conceded hole carries one, so match rounds count. Rating, slope,
differentials, adjusted gross score, the index-source model and
RoundArchive.handicapping are deleted whole. formatOverPar absorbs the web's
vsPar.ts as the one vs-par renderer."
```

---

## Task 6: The crew board's head-to-head line

Additive on top of Task 5's board.

**Files:** `apps/web/src/crews/SeasonPanel.tsx` + test

- [ ] **Step 1: Write the failing test**

```tsx
it("names the strokes between two members who have both played", () => {
  render(<SeasonPanel standings={twoMembersAt26And10} />);
  expect(screen.getByText("If you played tomorrow, Blaine gets 16.")).toBeTruthy();
});

it("says nothing about a pair where either has no average", () => {
  render(<SeasonPanel standings={oneMemberWithNoRounds} />);
  expect(screen.queryByText(/If you played tomorrow/)).toBeNull();
});
```

- [ ] **Step 2: Run and watch fail, then implement**

Run: `pnpm -F @swng/web vitest run src/crews/SeasonPanel.test.tsx` → FAIL.

Render **one** line, for the closest pair by average among members who both have one — not every pair. A 12-member crew has 66 pairs, and spec §6 shows a single callout. A subtraction of two served numbers is not a golf result, so the compute fence does not apply. Add a why-comment recording spec §6: this applies the same *rule* the round applies, over the board's season numbers — it is not a promise about what the round will produce, which is why the copy says "if you played tomorrow".

- [ ] **Step 3: Gate and commit**

Run: `pnpm validate` → exit 0.

```bash
git add -A
git commit -m "feat(crew): name the strokes between two members who never played together"
```

---

## Task 7: The docs say what the product now is

**Files:** `docs/product.md`, `docs/architecture.md`, `CLAUDE.md`

- [ ] **Step 1: Replace `product.md` §5's index pillar**

```markdown
- **What you shoot.** One number: what you normally shoot relative to par, averaged from
  your last ten finished rounds. Not an index, not slope-adjusted, not best-8-of-20 — a
  number you can check by adding up your own scorecards. It is also, exactly, the strokes
  you take: state +30 against a mate's +10 and you get 20, allocated by the card's stroke
  index. The first-tee negotiation is over before it starts, and nobody had to trust
  arithmetic they cannot see.
```

- [ ] **Step 2: Amend §1, §4 and §6**

- §1: "most golfers' handicaps are unofficial, stale, or vibes" now resolves by *asking for the vibe in plain words and replacing it with real scores*, not by computing a WHS-faithful index.
- §4: "Handicaps are already known, so strokes are computed" → "Everyone states what they normally shoot; swng takes the difference."
- §6: **Crew handicaps** → **The crew board** — rounds, average, spread, best, and the head-to-head strokes line.
- §10 (`product.md:118`): "**Official handicap-network integration.** The swng Index is deliberately honest-unofficial" — the pillar it names no longer exists. Reword to keep the non-goal (no official posting) without referencing a deleted index.

- [ ] **Step 3: `architecture.md` and `CLAUDE.md`**

Add `scoring/strokeBasis.ts` and `golfer/average.ts` to "Where golf logic lives"; delete `handicap/whs.ts` and `scoring/allowances.ts`. Add the arc paragraph to `CLAUDE.md` in the existing convention: what changed, what was deleted whole, the gates, beta-only, never pushed.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: the product is what you shoot relative to par, not an index"
```

---

## Task 8: E2E oracles and locators

Compile errors were fixed inside Tasks 1, 3 and 5. **This task is behavioural only**: oracles that are now wrong, and locators that broke on changed copy.

**Files:** `apps/web/e2e/{courseEntry,fieldTest,crewSeason,identityRecord,unratedCourse,handicapCorrection,shareLink,killNetwork,primaryPath}.spec.ts`

- [ ] **Step 1: Re-derive `fieldDeck18`-driven browser oracles**

`fieldTest.spec.ts` asserts live standings from the deck. Task 1 moved stroke-play, stableford, skins and four-ball results; re-derive each asserted figure by hand and record the derivation in the commit message.

- [ ] **Step 2: Reconcile every changed locator against the JSX**

Read the components, not this plan. Changed copy: the join label, `gameTreatment`'s five lines, `strokesNote`, the add-game form's gross/net radios, the profile headline and subtitle, `Final totals`, the card's `OUT`/`IN`/`TOT` rows, and the crew board headers.

- [ ] **Step 3: Rename `handicapCorrection.spec.ts` → `basisCorrection.spec.ts` and rework it**

`git mv` it, then assert both that the game chip moves and that the roster shows the new stated number. Add a beat that uses `Give strokes directly` so both constructors are covered live.

- [ ] **Step 4: `unratedCourse.spec.ts`**

Rated and unrated are no longer different code paths — nothing computes from rating or slope. Keep the spec as proof that a blank-rating card enters, plays and finalizes; delete its index-bootstrap assertions.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm validate` → exit 0.

```bash
git add -A
git commit -m "test(e2e): re-derive the oracles and reconcile the locators"
```

---

## Task 9: Beta close-out

**Controller-run. Beta only.**

- [ ] **Step 1:** `pnpm validate` → exit 0; `pnpm test:contract` → green.
- [ ] **Step 2:** `pnpm deploy:beta` → `UPDATE_COMPLETE`. **Lambda first** — `basis` and the reshaped metrics are new required wire fields, so an old bundle against a new lambda fails only on submit while a new bundle against an old lambda fails on load.
- [ ] **Step 3: Wipe round data — NOT courses.** `scrapCourseAndRoundData.mjs`'s first pass deletes every `COURSE#` item and strips `homeCourseId` from every golfer. This arc does not touch the course model, and Casa Verde GC / Sandy Hollow Nine are the field-test fixtures — so that pass must not run. **It has an explicit opt-out: `--keep-courses`** (added by the whole-branch fix wave; before it, the flagless script made the documented "skip that pass" instruction unexecutable, and the field specs re-seed courses so no gate would have caught the loss).

```bash
node scripts/scrapCourseAndRoundData.mjs --stage beta --keep-courses --dry-run   # read the counts first
node scripts/scrapCourseAndRoundData.mjs --stage beta --keep-courses
```

Confirm the transcript's first line reads `SKIPPED the swng-core-beta course pass (--keep-courses)`, then record the rounds/snapshots/projections deleted counts.
- [ ] **Step 4:** `pnpm publish:web:beta` — record the bundle hash, confirm the CloudFront invalidation completed.
- [ ] **Step 5:** `pnpm e2e:beta` ×2 → green both runs. `pnpm e2e:field` → all specs green.
- [ ] **Step 6: Adversarial USE pass on deployed `beta.swng.golf`.** Two throwaway accounts, phone viewport, real PKCE. Reproduce the owner's own field report:

1. Join stating `+30`; second account joins stating `+10`.
2. Card shows 20 dots on the 20 hardest holes for the first, none for the second.
3. Add net skins and gross skins as two games; read each panel's treatment line — the gross one must show no strokes summary at all.
4. Score a hole, concede a hole, pick up a hole; check all three pad states and the `5c` glyph.
5. Read the totals row: `OUT` / `IN` / `TOT`, gross over net, par totalled, the conceded hole counted.
6. Finalize; read gross · strokes · net with no "adjusted score" anywhere and the strokes shown as `−20`, not `+20`. Grep the deployed bundle for the word "handicap" — it must not appear in any user-facing string.
7. Profile: `What you shoot`, the ten rows, one chart line, no index picker.
8. Crew board: `Rounds · Average · Spread · Best` and the "If you played tomorrow" line.

Console clean. Delete both throwaway Cognito users.

- [ ] **Step 7:** Final commit.

---

## Self-Review

**Spec coverage.** §1 → T7. §2a/§2b → T1, T3. §2c → T3, T5. §2d → T2, T5. §3 → T1. §4 → T4 (+ the sign constraint, global). §5 → T5. §6 → T5 (board), T6 (head-to-head). §7 → T1, T5. §8 → T2, T3, T5, T9. §9 → T1, T3, T5, T7. §10 → the beta-only constraint and T9. §11 is the revision record and needs no task.

**Type consistency.** `StrokeBasis` (T1) → `Participant.basis` (T3) → `GolferRoundLine.normallyShoots` (T5). `resolveStrokes` (T1) → `reduceRound` (T3) → `gameStrokeAllocation` (T1). `hasCompleteScore`/`scoreOf` → `scoredOverPar`/`averageOfValues`/`spreadOfValues` → `averageOf`/`spreadOf` (all T5) → `crewScoreboard` (T5 Step 7, using the `*Values` pair so the rolling 10 is not applied on top of the season window). `roundStrokeAllocation` is the renamed `courseHandicapAllocation`, used under that one name from T3 onward. `formatOverPar` (T5, in `scoring/present.ts`) is the ONLY signed-number renderer left; nothing survives in `handicap/` because nothing survives that renders a negative stroke count.

**Declared shims, both deleted at a named step:** T1 Step 7's `basisOf` (deleted T3 Step 5); T3 Step 7's unwired join pre-fill (wired T5 Step 8).

**Revision record.** The first draft was reviewed adversarially and failed on four counts, all fixed here: (1) e2e compiles inside `validate`, so the sweep moved into Tasks 1/3/5 and Task 8 became behavioural-only; (2) Task 4's old deletion set broke files owned by other tasks — the boundaries were redrawn so the results rewrite lands *before* `handicappingFor` dies and the scoreboard swap lands *inside* the WHS deletion; (3) `formatCourseHandicap(-strokes)` and `formatHandicapIndex(average)` both inverted their numbers' signs — `formatOverPar` and an explicit global constraint replace them; (4) the crew board would have applied a rolling-10 window on top of the season window — it now uses the `*Values` helpers over the whole windowed set.
