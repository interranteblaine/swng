# Prod Reads Its Own History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let prod read the rounds it already has, so the typed-strokes arc can deploy there without touching a byte of stored data.

**Architecture:** One legacy arm on the stored read schemas — a participant carrying the old `courseHandicap` normalises to `strokes` at parse time. Applied at the three read sites. Nothing is rewritten.

**Tech Stack:** TypeScript (ESM, nodenext), pnpm workspaces, Vitest, Zod, AWS CDK, DynamoDB.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-31-prod-reads-its-own-history-design.md`.
- **PROD DATA IS NEVER WIPED OR REWRITTEN.** No `scrapCourseAndRoundData.mjs` against prod, no in-place backfill. Stored bytes must be byte-identical before and after this arc. A plan step that deletes prod rounds is a defect, not an option.
- **`pnpm validate` must exit 0 at every commit**; `pnpm test:contract` must stay ≥ 96.
- **Bounds stay off stored/fold schemas.** The legacy arm ADDS an accepted shape; it must not add a bound or a new requirement to `packages/contracts/src/round.ts`.
- **Beta must keep working.** Beta's data is post-arc (`strokes`), prod's is pre-arc (`courseHandicap`); both parse after this.
- Prod facts, verified read-only 2026-07-31: **6 golfers, 3 snapshots, 304 rounds-table items, 8 projection rows.** Stored participant shape on prod is `{courseHandicap, golferId, name, tee}`. Projection lines additionally carry retired `ags`/`differential` (harmless — zod strips unknown keys).

---

## Task 1: The legacy arm

**Files:**
- Modify: `packages/contracts/src/round.ts` (the participant schema backing `participant-joined` and `rosterEntrySchema`), `packages/contracts/src/golfers.ts` (`GolferRoundLine`)
- Test: `packages/contracts/src/round.test.ts`, `packages/contracts/src/golfers.test.ts`

**Interfaces:**
- Produces: stored participant + round-line schemas that accept `strokes` OR `courseHandicap` and always yield `strokes`. Consumed unchanged by every existing reader.

- [ ] **Step 1: Write the failing tests**

```ts
it("parses a participant stored before the typed-strokes arc — courseHandicap IS strokes", () => {
  const parsed = participantSchema.parse({ golferId: "g1", name: "Ann", tee: "white", courseHandicap: 14 });
  expect(parsed.strokes).toBe(14);
});

it("parses a participant stored after it, unchanged", () => {
  expect(participantSchema.parse({ golferId: "g1", name: "Ann", tee: "white", strokes: 14 }).strokes).toBe(14);
});

it("still refuses a participant carrying neither", () => {
  expect(() => participantSchema.parse({ golferId: "g1", name: "Ann", tee: "white" })).toThrow();
});

it("ignores the retired ags/differential keys a prod round line still carries", () => {
  const line = golferRoundLineSchema.parse({ ...validLine, courseHandicap: 9, ags: 84, differential: 12.3, strokes: undefined });
  expect(line.strokes).toBe(9);
  expect("ags" in line).toBe(false);
});
```

- [ ] **Step 2: Run them and watch three fail**

Run: `pnpm -F @swng/contracts vitest run src/round.test.ts src/golfers.test.ts`
Expected: the two legacy cases FAIL (`strokes` required, `courseHandicap` unknown); the post-arc and the refuses-neither cases pass.

- [ ] **Step 3: Add the arm**

In `round.ts`, replace the participant object with the spec §4 shape: both numbers optional on the way in, a `.transform` that yields `strokes: strokes ?? courseHandicap`, and a `.refine` that rejects when neither was present. Keep `strokes` UNBOUNDED (Arc A's placement rule — the bounded copy lives in `commands.ts`). Mirror it for `GolferRoundLine` in `golfers.ts`.

Comment it with the reason, not the mechanism: prod ran the 2026-07-24 code where this number was the player's own count on the card, which is what `strokes` means now — so the mapping is exact, unlike on beta, which had run an intermediate model where the same field was ambiguous.

- [ ] **Step 4: Run them and watch all pass; then the whole gate**

Run: `pnpm validate` → exit 0, then `pnpm test:contract` → ≥ 96.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(contracts): prod's stored rounds parse — courseHandicap IS strokes

Prod runs the 2026-07-24 code, where a participant's number was stored as
courseHandicap: that player's own count on the card, which is exactly what
strokes means now. The read path normalises it; nothing stored is rewritten.

Exact here and NOT on beta, which had run the intermediate relative-to-par
model where the same field could be either an absolute number or an already
hand-typed difference."
```

---

## Task 2: Prove it on the real bytes, read-only

**Files:**
- Create: `scripts/checkProdRoundsParse.mjs`

- [ ] **Step 1: Write the script**

Reads, never writes. Takes `--stage` (default `prod`). Scans the snapshots table and the rounds table, parses each record with the built `@swng/contracts` schemas, and prints one line per record: `ok` / `FAILED <reason>`, then a summary count. It must **exit non-zero if any record fails**, so it can gate a deploy.

It must contain no delete, put, or update call of any kind. Say so in a header comment, and make the AWS client construction read-only-by-inspection (only `ScanCommand`/`QueryCommand` imported).

- [ ] **Step 2: Run it against prod BEFORE deploying**

Run: `AWS_PROFILE=swng node scripts/checkProdRoundsParse.mjs --stage prod`
Expected: every one of prod's 3 snapshots and its participant-joined events reports `ok`, exit 0. Record the output in the arc's ledger.

If ANY record fails, stop and report — do not deploy, and do not "fix" it by touching data.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(scripts): a read-only check that prod's stored rounds parse"
```

---

## Task 3: Prod deploy (CONTROLLER-RUN, owner-triggered)

**Do not start this task without the owner saying so.** Tasks 1–2 are safe to land any time; this one touches the launched environment.

- [ ] **Step 1:** `pnpm validate` 0, `pnpm test:contract` ≥ 96, and Task 2's check exit 0 against prod.
- [ ] **Step 2:** `cdk diff swng-prod` — confirm the delta is lambda code + the arc's route swap ONLY. No table, pool, secret, WAF or alarm change. Any stateful diff stops the deploy.
- [ ] **Step 3:** `pnpm deploy:prod` → `UPDATE_COMPLETE`. Confirm `POST /rounds/{roundId}/strokes` exists and `/handicap` and `/basis` do not.
- [ ] **Step 4:** `pnpm publish:web:prod`; `curl -s https://swng.golf/ | grep -oE 'index-[A-Za-z0-9_-]+\.js'` to confirm the built bundle is the one served.
- [ ] **Step 5: The check that matters.** In a browser on `swng.golf`, open **each of the 3 finished rounds** and confirm the scorecard renders with each player's strokes showing the number their round was actually played off — not 0, not a dash, not an error.
- [ ] **Step 6:** Invoke `rebuildProjections` and confirm it **completes** (it stalled at page 1 before this arm existed). Then re-open a golfer's record page and confirm their history is intact.
- [ ] **Step 7:** Re-run Task 2's check against prod post-deploy; confirm still all `ok`, and confirm the stored item counts are UNCHANGED from the §1 figures (6 golfers, 3 snapshots, 304 rounds-table items, 8 projection rows). Nothing was deleted or rewritten — that is the arc's central claim and it should be verified, not assumed.
- [ ] **Step 8:** Delete the now-discharged "Standing precondition" section from `CLAUDE.md`, replace it with one line in this arc's record, and commit.

---

## Self-Review

**Spec coverage.** §1 → context. §2's three read paths → T1 (all three schemas). §3's non-goals → the Global Constraints and T3 Step 7's count check. §4 → T1. §5 → T1's comment. §6 → T2 and T3.

**The thing a reviewer must not "simplify".** The arm is deliberately permissive on the way IN and strict on the way OUT: both fields optional, then a refine that rejects when neither is present. Collapsing that to `strokes: z.number().optional().default(0)` would silently seat every unreadable participant at 0 strokes — the exact silent-wrong-number failure this arc exists to prevent, and no test that only checks "it parses" would catch it.

**Type consistency.** `strokes: number` remains required on the parsed output everywhere; only the accepted INPUT widens. No consumer changes.

**Ordering.** T1 before T2 (nothing to verify until the arm exists). T2 before T3, and T2 is what makes T3 safe to start.
