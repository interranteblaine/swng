# Strokes Are Typed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the derived-strokes model with one typed integer per player on the roster, and delete the machinery that derivation required.

**Architecture:** `Participant.strokes: number` is asserted, not computed. One event sets it. Games and the card read it directly, with no re-anchoring and no allowances. `StrokeBasis`, `resolveStrokes`, `anchorOf`, the halving rule, the clamp, the join-form question, `HoleResult`'s `conceded` arm and `fullyHoledOut` are deleted whole.

**Tech Stack:** TypeScript (ESM, nodenext), pnpm workspaces, Vitest, Zod (contracts), React 19 + Tailwind 4 (web), AWS CDK (infra), Playwright (field e2e).

## Status — read this first

**Nothing is implemented.** This plan supersedes the strokes mechanism built by
`docs/superpowers/plans/2026-07-29-relative-to-par-strokes-model.md`, which is deployed to beta.
Most of this plan is deletion of that work. Its record/average, card-totals, gross-net and
WHS-deletion work **stands** — do not undo it.

**Execution mode:** subagent-driven, a fresh agent per task with a review between tasks. This is
the repo default and not a question to re-ask.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-30-strokes-are-typed-design.md`. Every decision is there; this plan implements it and adds nothing.
- **`pnpm validate` must exit 0 at every commit.** It is lint + typecheck + build + test, and it **typechecks the e2e suites** (`apps/web/tsconfig.json` includes `"e2e"`; `e2e/` has its own typecheck). **Every e2e call site a task breaks must be fixed in that task's commit.**
- **A retired STRING is invisible to the compiler.** After changing or deleting user-facing copy, grep `apps/web/e2e/` and `e2e/` for the old string and treat "appears nowhere" as the completion check. This cost the previous arc a fix round with eight dead locators.
- **Bounds go on request schemas only, never on a stored/fold schema.** `contracts/round.ts`'s schemas back `roundEventSchema`, which the client parses on every pull; a required field or bound there rejects already-stored data on a read path and is invisible to every gate.
- **Frozen decks keep their hand-designed SCORES byte-identical** — `packages/domain/src/scoring/golden/fieldDeck18.ts`, `apps/web/e2e/crewSeasonDeck.ts`. Only expected results are re-derived, by hand, with the derivation in the commit message.
- **`strokes` can never be negative.** Bounded `int().min(0).max(54)` at the request ingress.
- **The compute fence** in `eslint.config.mjs` keeps golf compute out of `apps/web/src`; new domain compute joins the banlist and is re-exported through `@swng/client` when the web needs it.
- **Language:** never "index", "handicap", "your number", "your usual", "form", "adjusted score", "normally", or "anchor" in user-facing copy.
- **Beta only.** No `deploy:prod`, no `publish:web:prod`, no change to `STAGE_CONFIG`'s prod entry.

---

## File Structure

**Deleted**

| File | Why |
|---|---|
| `packages/domain/src/scoring/strokeBasis.ts` (+`.test.ts`) | `StrokeBasis`, `resolveStrokes`, `anchorOf` — the whole derivation |
| `packages/application/src/rounds/setBasis.ts` (+`.test.ts`) | renamed to `setStrokes.ts` via `git mv` |
| `apps/web/e2e/basisCorrection.spec.ts` | renamed to `strokesCorrection.spec.ts` via `git mv` |

**Modified — the load-bearing ones**

| File | Responsibility after |
|---|---|
| `packages/domain/src/round/participant.ts` | `Participant.strokes: number`, asserted; `RosterEntry` keeps only `departed?` |
| `packages/domain/src/round/state.ts` | fold applies `participant-strokes-set`; no derivation pass |
| `packages/domain/src/scoring/allocation.ts` | `gameStrokeAllocation` reads `participant.strokes` directly |
| `packages/domain/src/round/holeResult.ts` | two decided arms: `strokes`, `picked-up` |
| `packages/domain/src/golfer/analytics.ts` | `fullyHoledOut` gone; `bestsOf` uses `hasCompleteScore` |
| `apps/web/src/round/SetupPanel.tsx` | two-line roster row, one `Edit` |

---

## Task 1: A gimme is a score — delete `conceded`

**Files:**
- Modify: `packages/domain/src/round/holeResult.ts`, `packages/domain/src/golfer/analytics.ts` (+test), `packages/domain/src/golfer/courseRecord.ts` (+test), `packages/domain/src/golfer/record.ts` (+test), `packages/domain/src/crew/scoreboard.ts` (+test), `packages/contracts/src/round.ts` (+test), `packages/contracts/src/commands.ts` (+test), the five engines under `packages/domain/src/scoring/`, `apps/web/src/round/ScorePad.tsx` (+test), `apps/web/src/round/ScorecardGrid.tsx` (+test), `apps/web/src/games/describeGame.test.ts`, `apps/web/e2e/support.ts`, `apps/web/e2e/fieldTest.spec.ts`, `e2e/roundSlice.e2e.test.ts`

**Interfaces:**
- Produces: `HoleResult` with arms `strokes` / `picked-up` / `cleared`; `scoredStrokes(result): number | undefined` unchanged in signature; `bestsOf(lines)` gated on `hasCompleteScore` (Task 1), consumed by Tasks 5 and 6.

- [ ] **Step 1: Write the failing test — a gimme is just a score**

Add to `packages/domain/src/golfer/analytics.test.ts`:

```ts
it("counts a fully-scored round as a Best — there is no holed-out gate", () => {
  const line = lineWith({ holes: 18, par: 72, perHole: 4 }); // every hole a strokes cell
  expect(bestsOf([line]).best18?.gross).toBe(72);
});
```

Add to `packages/contracts/src/round.test.ts`:

```ts
it("rejects a conceded hole result — a gimme is recorded as its score", () => {
  expect(() => holeResultSchema.parse({ kind: "conceded", strokes: 4 })).toThrow();
});
```

- [ ] **Step 2: Run them and watch the contract one fail**

Run: `pnpm -F @swng/contracts vitest run src/round.test.ts`
Expected: FAIL — `{ kind: "conceded", strokes: 4 }` still parses.

- [ ] **Step 3: Delete the arm**

In `packages/domain/src/round/holeResult.ts`, remove the `conceded` arm so the union is:

```ts
export type HoleResult =
  | { readonly kind: "strokes"; readonly strokes: number }
  // The player stopped. There is NO number and nobody invents one — this is the only
  // state that keeps a round out of the average (spec §7).
  | { readonly kind: "picked-up" }
  | { readonly kind: "cleared" };
```

`scoredStrokes` narrows to the one numeric arm:

```ts
export const scoredStrokes = (result: HoleResult): number | undefined =>
  result.kind === "strokes" ? result.strokes : undefined;
```

Mirror the deletion in `contracts/round.ts`'s stored arm and `contracts/commands.ts`'s
`scoreResultInputArms`. The `[A] extends [B]` exhaustiveness pin in `commands.ts` fails the build
if type and schema diverge — keep it.

- [ ] **Step 4: Delete `fullyHoledOut`**

In `packages/domain/src/golfer/analytics.ts`, delete `fullyHoledOut` entirely and route `bestsOf`
through `hasCompleteScore`, which already means "every hole has a number":

```ts
// Best 18 is the lowest gross over a round where every hole has a score. There is no
// holed-out gate: a 79 with two gimmes is your best round (spec §7).
export const bestsOf = (lines: readonly GolferRoundLine[]): GolferBests => { /* hasCompleteScore */ };
```

Delete every `fullyHoledOut` reference in `crew/scoreboard.ts` (its `best18` fold) and in
`golfer/courseRecord.ts`, replacing each with `hasCompleteScore`.

- [ ] **Step 5: Follow the compiler out**

Run `pnpm build` and fix in order: the five engines lose any `"conceded"` mention (each already
routes through `scoredStrokes`, so most are comment-only); `record.ts`'s distribution and
`courseRecord.ts`'s per-hole aggregate drop their conceded branch; `ScorePad.tsx` loses the
`Conceded` button, the `conceding` state, the disclosure and its `key`-related comment;
`ScorecardGrid.tsx`'s `glyphFor` loses the `Nc` case.

- [ ] **Step 6: Sweep the strings and fixtures**

`grep -rn "conceded\|Conceded\|fullyHoledOut\|holed out" apps e2e packages --include="*.ts" --include="*.tsx" | grep -v /dist/` and fix every hit — including `apps/web/e2e/support.ts`'s helpers, `fieldTest.spec.ts`'s deck (its one conceded cell becomes a plain `strokes` cell **at the same number**, so no expectation moves — verify that rather than assuming), and `e2e/roundSlice.e2e.test.ts`.

- [ ] **Step 7: Gate and commit**

Run: `pnpm validate` → exit 0.

```bash
git add -A
git commit -m "feat(round): a gimme is a score — delete the conceded arm

Once conceded carried a number it behaved identically to a strokes cell in
every engine, the card's totals, the record and the course record. Two
variants that must behave identically everywhere are one variant. Its only
surviving difference was fullyHoledOut, which refused a conceded round a
Best 18 — also wrong, since a 79 with two gimmes is your best round.

Best 18 is now lowest gross over a fully-scored round. picked-up remains the
only state meaning there is no number."
```

---

## Task 2: `Participant.strokes` is typed; delete the derivation

**One atomic commit across every layer including e2e** — `Participant` is imported by every package, so this cannot be split and keep `validate` green.

**Files:**
- Delete: `packages/domain/src/scoring/strokeBasis.ts` + test
- `git mv`: `packages/application/src/rounds/setBasis.ts` → `setStrokes.ts` (+ its test)
- Modify: `packages/domain/src/round/{participant,state,events}.ts`, `packages/domain/src/scoring/allocation.ts`, `packages/domain/src/golfer/record.ts`, `packages/contracts/src/{round,commands,golfers}.ts`, `packages/application/src/rounds/{startRound,joinRound}.ts`, `packages/lambda/src/http/routes.ts`, `apps/infra-cdk/lib/swngStack.ts` (+test), `apps/web/src/api.ts` (+test), `apps/web/src/routes/{JoinRoundPage,CreateRoundPage,RoundPage}.tsx`, `apps/web/src/round/SetupPanel.tsx`
- E2E (same commit): `apps/web/e2e/support.ts`, every spec filling the join form, `e2e/roundSlice.e2e.test.ts`, `apps/web/e2e/crewSeasonDeck.ts`

**Interfaces:**
- Consumes: nothing from Task 1 beyond a green tree.
- Produces: `Participant.strokes: number`; event `participant-strokes-set { golferId, strokes }`; route `POST /rounds/{roundId}/strokes`; `JoinRoundRequest = { code, tee }`.

- [ ] **Step 1: Write the failing fold tests**

Replace the derivation block in `packages/domain/src/round/state.test.ts` with:

```ts
it("seats a player at zero strokes unless someone sets them", () => {
  const state = reduceRound([created(card), joined("blaine")]);
  expect(strokesOf(state, "blaine")).toBe(0);
});

it("applies a strokes-set that is HLC-later than the join", () => {
  const state = reduceRound([
    created(card),
    joined("blaine", hlc(1)),
    strokesSet("blaine", 20, hlc(2)),
  ]);
  expect(strokesOf(state, "blaine")).toBe(20);
});

it("ignores a strokes-set older than the golfer's latest join", () => {
  const state = reduceRound([
    created(card),
    strokesSet("blaine", 20, hlc(1)),
    joined("blaine", hlc(2)),
  ]);
  expect(strokesOf(state, "blaine")).toBe(0);
});

it("leaves one player's strokes alone when another's are set", () => {
  const state = reduceRound([
    created(card),
    joined("blaine", hlc(1)),
    joined("ravi", hlc(2)),
    strokesSet("blaine", 20, hlc(3)),
  ]);
  expect(strokesOf(state, "blaine")).toBe(20);
  expect(strokesOf(state, "ravi")).toBe(0);
});
```

That last test is the point of the whole arc: nothing about one player's number moves another's.

- [ ] **Step 2: Run and watch fail**

Run: `pnpm -F @swng/domain vitest run src/round/state.test.ts`
Expected: FAIL — `strokesSet` does not exist and the fold still derives.

- [ ] **Step 3: Change the participant**

```ts
export interface Participant {
  readonly golferId: GolferId;
  readonly name: string;
  readonly tee: string;    // TeeSet name within the round's frozen CourseCard
  // ASSERTED, never derived (spec §2). 0 until someone sets it. Nothing computes this from
  // anyone else's number: strokes are what the group agreed and typed.
  readonly strokes: number;
}

export interface RosterEntry extends Participant {
  readonly departed?: boolean;
}
```

- [ ] **Step 4: Change the fold**

In `state.ts`, `participant-joined` seats `strokes: 0`. Add `participant-strokes-set`, applying iff
HLC-later than that golfer's latest join — the identical rule the basis event used, so lift it
rather than rewriting it. **Delete the whole post-roster derivation pass** (`resolveStrokes` /
`anchorOf` / `present` filter). Mirror the event in `events.ts`.

- [ ] **Step 5: Delete the derivation and simplify allocation**

`rm packages/domain/src/scoring/strokeBasis.ts packages/domain/src/scoring/strokeBasis.test.ts`.

In `allocation.ts`, `gameStrokeAllocation` reads each member's own roster number — no anchor, no
present-field scoping:

```ts
// Every game uses the strokes on the card (spec §3). No re-anchoring to the game's own field
// and no allowance: the card and every game therefore always show the same dots.
export const gameStrokeAllocation = (
  config: GameConfig,
  participants: readonly RosterEntry[],
  card: CourseCard,
): ReadonlyMap<GolferId, ReadonlyMap<number, number>> => {
  if ("scoring" in config && config.scoring === "gross") return new Map();
  return new Map(
    gameMembers(config).map((id) => {
      const p = participantFor(participants, id);
      return [id, dotsByHole(p.strokes, findTeeSet(card, p.tee))];
    }),
  );
};
```

`roundStrokeAllocation` is now the same expression over the whole roster — keep both names (the
card and a game are different callers) but note in a comment that they agree by construction.

- [ ] **Step 6: Change the wire**

In `contracts/commands.ts`, delete `strokeBasisInputSchema` and its exhaustiveness pin. Add:

```ts
// Request ingress only — the stored event arm in round.ts stays unbounded (Arc A's placement
// rule: a bound on a stored/fold schema rejects already-stored data on a read path).
export const strokesInputSchema = z.number().int().min(0).max(54);
```

`JoinRoundRequest` becomes `{ code, tee }`; `StartRoundRequest`'s host becomes `{ tee }`; the
set-strokes body is `{ golferId, strokes }`. In `contracts/round.ts`, the stored
`participant-joined` arm carries `strokes: z.number().int()` (unbounded) and the new
`participant-strokes-set` arm replaces `participant-basis-set`.

`git mv` `setBasis.ts` → `setStrokes.ts` and rename the route to `POST /rounds/{roundId}/strokes`.

**Two rename sites are invisible to the typechecker and must be done by hand:**
- `apps/infra-cdk/lib/swngStack.ts`'s `HTTP_ROUTES` string literal, pinned by `apps/infra-cdk/test/swngStack.test.ts` and caught only by `test/routesParity.test.ts` in validate's *test* phase.
- `apps/web/src/api.ts`'s template-string URL, pinned by `api.test.ts` — which agrees with whatever both sides say, so a missed rename stays green until the live gate.

- [ ] **Step 7: Change the web**

`JoinRoundPage.tsx` — delete the `What do you normally shoot, relative to par?` field, the pre-fill
and the `GET /me/record` fetch that fed it. Submit `{ code, tee }`. `CreateRoundPage.tsx` — same
deletion; submit `{ course, host: { tee } }`.

`SetupPanel.tsx` — the roster row becomes two lines with one control:

```tsx
<li>
  <div className="flex items-baseline justify-between">
    <GolferLink golferId={p.golferId} name={p.name} />
    <button className={btnQuiet} onClick={() => setEditing(p.golferId)}>Edit</button>
  </div>
  <p className="text-sm text-fairway">{`${p.tee} · ${p.strokes} strokes`}</p>
</li>
```

Delete `Give strokes directly` and the `normally +N · gets N` composition. `Edit` opens one number
input bounded at 0, posting to the strokes route.

- [ ] **Step 8: Sweep e2e in this commit**

`apps/web/e2e/support.ts`'s join helper drops `basis`. Every spec targeting the deleted join label
must change — read the JSX for the surviving accessible names rather than guessing.
`crewSeasonDeck.ts`'s four participants become `strokes: 0` (they were all `overPar: 0` with a
common anchor, so **no deck expectation moves** — verify it).

- [ ] **Step 9: Gate and commit**

Run: `pnpm validate` → exit 0, then `pnpm test:contract`.

```bash
git add -A
git commit -m "feat(round): strokes are typed, not derived

One integer per player, asserted on the roster, default 0. StrokeBasis,
resolveStrokes, anchorOf, present-field scoping, the nine-hole halving rule
and the negative clamp are deleted: the group does the subtraction on the
first tee and types the answer, which is what they already did.

Games read the same number the card shows — no re-anchoring, no allowances."
```

---

## Task 3: The panel copy names the card again

**Files:**
- Modify: `packages/domain/src/scoring/present.ts` (+test), `apps/web/src/round/dots.ts` (+test), `apps/web/src/games/GamePanel.tsx`

- [ ] **Step 1: Write the failing test**

```ts
it("says a net game uses the strokes on the card", () => {
  expect(gameTreatment({ kind: "skins", id: gameId("g"), scoring: "net", players: [] }))
    .toBe("Net — uses the strokes on the card");
});
```

- [ ] **Step 2: Run and watch fail**

Run: `pnpm -F @swng/domain vitest run src/scoring/present.test.ts`
Expected: FAIL — still returns `Net — everyone plays off the lowest in this game`.

- [ ] **Step 3: Revert the copy**

The prior arc changed this line because a subset game re-anchored, making "the card" false. Task 2
removed the re-anchoring, so the original sentence is true again. Restore it for the stroke-play,
skins and stableford arms. `strokesNote` drops both match-kind notes about who receives — with no
relative rule there is nothing to explain.

- [ ] **Step 4: Grep the specs for the retired string**

`grep -rn "plays off the lowest" apps e2e packages | grep -v /dist/` must return nothing.

- [ ] **Step 5: Gate and commit**

Run: `pnpm validate` → exit 0.

```bash
git add -A
git commit -m "feat(scoring): a net game uses the strokes on the card, and says so"
```

---

## Task 4: Delete the crew head-to-head line

**Files:**
- Modify: `apps/web/src/crews/SeasonPanel.tsx` (+test)

- [ ] **Step 1: Write the failing test**

```ts
it("names no hypothetical match-up — the board already shows both averages", () => {
  render(<SeasonPanel standings={twoMembersAt26And10} />);
  expect(screen.queryByText(/If you played tomorrow/)).toBeNull();
});
```

- [ ] **Step 2: Run and watch fail, then delete**

Run: `pnpm -F @swng/web vitest run src/crews/SeasonPanel.test.tsx` → FAIL.

Delete `rankedByAverage`, the closest-pair scan, `strokesHeadline` and the rendered line, plus the
five tests that pinned them. This also removes the last golf arithmetic from `apps/web/src`.

- [ ] **Step 3: Gate and commit**

Run: `pnpm validate` → exit 0.

```bash
git add -A
git commit -m "feat(crew): delete the head-to-head line

Both averages are already on the board, so it only performed a subtraction the
reader can see; it named one pair by an invisible rule; and it asserted a
hypothetical about a round nobody is playing."
```

---

## Task 5: Golf logic back in the core; the fence catches re-derivation

**Files:**
- Modify: `packages/domain/src/golfer/metrics.ts`, `packages/domain/src/golfer/present.ts`, `apps/web/src/golfers/RecordSections.tsx`, `packages/client/src/scoring.ts`, `eslint.config.mjs`
- Test: `packages/domain/src/golfer/present.test.ts`, a new fence test

**Interfaces:**
- Produces: `nineHoleContribution(overPar: number): number` in `packages/domain/src/golfer/average.ts`.

- [ ] **Step 1: Write the failing test**

```ts
it("doubles a nine-hole round's contribution", () => {
  expect(nineHoleContribution(11)).toBe(22);
  expect(nineHoleContribution(-2)).toBe(-4);
});
```

- [ ] **Step 2: Run and watch fail, then implement**

Run: `pnpm -F @swng/domain vitest run src/golfer/average.test.ts` → FAIL.

```ts
// A nine counts doubled (spec 2026-07-29 §2d). This is a model rule, not a rendering — it
// belongs here, not in the component that happens to show it.
export const nineHoleContribution = (overPar: number): number => overPar * 2;
```

`RecordSections.tsx` calls it through `@swng/client` instead of computing `overPar * 2` inline;
add it to the ESLint banlist and the client re-export list.

- [ ] **Step 3: Make the fence catch re-derivation**

The fence currently bans *importing* golf compute into `apps/web/src`; it never noticed the web
recomputing a rule inline. Add a structural test that reads the web's source and fails on
arithmetic over golf quantities:

```ts
// apps/web/test/noGolfArithmetic.test.ts — lives OUTSIDE src because it reads files with
// node:fs, which apps/web/src bans (the brandTokens.test.ts precedent).
const BANNED = [/\.average\s*[-+]\s*/, /\.strokes\s*[-+]\s*/, /overPar\s*\*\s*2/];
it("computes no golf result in the web", () => {
  for (const file of walk("apps/web/src")) {
    for (const pattern of BANNED) expect(read(file)).not.toMatch(pattern);
  }
});
```

Prove it bites: reintroduce `a.average - b.average` in a scratch edit, watch the test fail, revert.

- [ ] **Step 4: Gate and commit**

Run: `pnpm validate` → exit 0.

```bash
git add -A
git commit -m "refactor(golfer): the nine-hole doubling is a model rule, and the fence now catches re-derivation"
```

---

## Task 6: The stored-data cast stops lying

**Files:**
- Modify: `packages/adapters-dynamodb/src/createDynamoEventJournal.ts`, `packages/adapters-dynamodb/src/createDynamoSnapshotStore.ts`
- Test: `packages/adapters-dynamodb/src/contract/journal.contract.test.ts`

- [ ] **Step 1: Write the failing contract test**

```ts
it("rejects a stored event that does not match the schema rather than trusting it", async () => {
  await putRawItem({ pk: roundPk(roundId), sk: evtSk(1), event: { kind: "nonsense" } });
  await expect(journal.read(roundId, 0)).rejects.toThrow(/stored-event-invalid/);
});
```

- [ ] **Step 2: Run and watch fail**

Run: `pnpm test:contract` (needs DynamoDB Local under Java)
Expected: FAIL — the cast returns the nonsense item unchecked.

- [ ] **Step 3: Parse instead of cast**

Replace `result.Items?.[0] as { event: RoundEvent }` and the snapshot store's equivalent with a
`roundEventSchema` / archive parse that throws a named `DomainError` on mismatch. The server now
validates what it reads for the same reason the client does: the type must not assert what the
read path cannot guarantee.

- [ ] **Step 4: Gate and commit**

Run: `pnpm validate` → exit 0, then `pnpm test:contract` → green.

```bash
git add -A
git commit -m "fix(adapters): parse stored events instead of asserting their shape"
```

---

## Task 7: Docs

**Files:** `docs/product.md`, `docs/architecture.md`, `docs/roadmap.md`, `docs/engineering-conventions.md`, `CLAUDE.md`

- [ ] **Step 1: Rewrite `product.md` §5's pillar**

```markdown
- **Strokes you agreed, written down.** Someone says "you get 20" and that is what the card
  shows — one number per player, editable by anyone, nothing computed behind it. Your own
  record tells you what to ask for: what you shoot, averaged from your last ten rounds. No
  index, no allowance, no conversion. The first-tee conversation still happens; swng just
  stops pretending it needs to have an opinion about it.
```

- [ ] **Step 2: Sweep the other four**

`architecture.md`'s "Where golf logic lives" drops `scoring/strokeBasis.ts`;
`engineering-conventions.md` and `roadmap.md` lose any derived-strokes language; `CLAUDE.md` gains
the arc paragraph in the established convention, **withholding gate results for Task 8**.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: strokes are typed, not derived"
```

---

## Task 8: Beta close-out

**Controller-run. Beta only.**

- [ ] **Step 1:** `pnpm validate` → 0; `pnpm test:contract` → green.
- [ ] **Step 2: Wipe beta round data BEFORE deploying.** Pre-arc participants carry a `basis` object and no `strokes`, and `strokes` is required on the wire — so a deploy-then-wipe window serves bodies neither bundle can parse. Run `node scripts/scrapCourseAndRoundData.mjs --stage beta --keep-courses --dry-run` first and confirm the `SKIPPED the swng-core-beta course pass` line, then run it for real. Record the deleted counts and re-verify the `COURSE#` and `GOLFER#` counts are unchanged.
- [ ] **Step 3:** `pnpm deploy:beta` → `UPDATE_COMPLETE`. Confirm `POST /rounds/{roundId}/strokes` exists and `/basis` does not.
- [ ] **Step 4:** `pnpm publish:web:beta` immediately after — record the bundle hash and `curl` beta.swng.golf to confirm that exact bundle is served.
- [ ] **Step 5:** `pnpm e2e:beta` ×2 → green. `pnpm e2e:field` → green.
- [ ] **Step 6: USE pass on deployed `beta.swng.golf`,** two accounts, phone viewport:
  1. Join a round — confirm no question is asked about what you normally shoot.
  2. Roster shows `name` / `tee · 0 strokes` / one `Edit`. Set 20 on one player; the other stays 0.
  3. Card shows 20 dots on the 20 hardest holes for that player, none for the other.
  4. Add net skins and gross skins; the net panel says `Net — uses the strokes on the card` and its dots match the card exactly.
  5. Score a hole; take a gimme by tapping the number — confirm no `Conceded` control exists anywhere.
  6. Pick up a hole; confirm the segment dashes.
  7. Finalize: gross · strokes · net.
  8. Profile: `What you shoot`, no input of any kind.
  9. Crew board: four columns, no "If you played tomorrow" line.
  10. Grep the deployed bundle for `handicap`, `normally`, `anchor`, `conceded` — only the sanctioned `SI = the Handicap/HDCP row on your scorecard` may survive.
- [ ] **Step 7:** Append the gate results to `CLAUDE.md` and commit.

---

## Self-Review

**Spec coverage.** §1 → T7. §2 → T2. §3 → T2, T3. §4 → unchanged, no task. §5 → T2 (deletes the join pre-fill; the profile itself is already read-only). §6 → T4. §7 → T1. §8 → T2. §9 → T1, T2, T3, T4. §10 → T5, T6. §11 → T2, T8. §12 is framing.

**Type consistency.** `Participant.strokes: number` (T2) is read by `gameStrokeAllocation` (T2) and `SetupPanel` (T2). `scoredStrokes` (T1) keeps its signature. `hasCompleteScore` (pre-existing) gains `bestsOf` as a caller (T1). `nineHoleContribution` (T5) is the only new export.

**Ordering.** T1 is first because deleting an arm from `HoleResult` is independent of the strokes work and touches the engines T2 also edits — doing it after would enlarge T2's already-atomic diff. T3 depends on T2 (the copy is only true once re-anchoring is gone). T5's fence test would fail before T4 removes the last web arithmetic, so T4 precedes it.
