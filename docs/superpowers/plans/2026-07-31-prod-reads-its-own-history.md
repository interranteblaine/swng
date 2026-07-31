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
- Prod facts, verified read-only 2026-07-31 by scanning all three tables:
  - **6 golfers, 3 snapshots, 304 rounds-table items** (150 opId tombstones, 4 META, 150 events), **8 projection lines.**
  - Stored participant shape: `{courseHandicap, golferId, name, tee}` — no `strokes`, on all 9 `participant-joined` events and all 8 archive roster entries.
  - **3 `participant-handicap-set` events**, a retired event KIND, one on each of the 3 finished rounds, each carrying `courseHandicap`. Load-bearing: they correct Pita 0→36, Blaine 37→20, Blaine 16→13.
  - Projection lines carry `courseHandicap` plus retired `ags`/`differential`, and every field the current type requires except `strokes`.
  - Needs no handling, confirmed by reading: `game-added.config` carries retired `allowance: 1`; archives carry a retired `handicapping` array; skins configs carry no `scoring` and take the existing `.default("net")`. All 123 `score-recorded` cells are `strokes` — zero `conceded`.

---

## Task 1: The legacy arm

**Files:**
- Modify: `packages/contracts/src/round.ts` — `participantSchema`, `rosterEntrySchema`, and the `roundEventSchema` / `roundArchiveSchemaImpl.events` doors
- Modify: `packages/adapters-dynamodb/src/createDynamoProjectionStore.ts` — `listLines`' map
- Test: `packages/contracts/src/round.test.ts`, and a projection-store test alongside the existing adapter tests

**Interfaces:**
- Produces: stored round schemas that accept `strokes` OR `courseHandicap` and always yield `strokes`; a retired-event-kind translation. Consumed unchanged by every existing reader.

**The four sites, all of which must land together** (spec §4, "one rule, one definition, every door"):

1. `participantSchema` — the `participant-joined` arm's seat.
2. `rosterEntrySchema` — the settled roster inside `roundArchiveSchema`.
3. The retired **event kind**: `participant-handicap-set {golferId, courseHandicap}` reads as `participant-strokes-set {golferId, strokes}`. This must apply on **every** door that parses a stored event — `roundEventSchema` (used by both the client's pull loop and the server's `parseStoredEvent`) AND `roundArchiveSchemaImpl.events`. Leaving the archive door on the raw union is the drift bug this step exists to prevent.
4. `createDynamoProjectionStore.listLines` — map `courseHandicap` to `strokes` on the stored line. **Normalise only; do not introduce a stored-line schema** (spec §4 explains why, and that file's own comment recommending the cast be closed stays as-is).

Write the mapping ONCE and reference it from all four; do not spell `?? courseHandicap` in four places.

- [ ] **Step 1: Write the failing tests**

```ts
it("parses a participant stored before the typed-strokes arc — courseHandicap IS strokes", () => {
  const parsed = participantSchema.parse({ golferId: "g1", name: "Ann", tee: "white", courseHandicap: 14 });
  expect(parsed.strokes).toBe(14);
});

it("parses a participant stored after it, unchanged", () => {
  expect(participantSchema.parse({ golferId: "g1", name: "Ann", tee: "white", strokes: 14 }).strokes).toBe(14);
});

it("still refuses a participant carrying neither — 0 is a legal number, not a fallback", () => {
  expect(() => participantSchema.parse({ golferId: "g1", name: "Ann", tee: "white" })).toThrow();
});

it("reads prod's retired participant-handicap-set as a strokes correction", () => {
  const parsed = parse(roundEventSchema, {
    kind: "participant-handicap-set",
    courseHandicap: 20,
    golferId: "facc2215-df17-4e01-9cdd-e9333389c49e",
    authorId: "facc2215-df17-4e01-9cdd-e9333389c49e",
    opId: "b1db2cfd-e5ca-498a-ad5d-1b612543e760",
    hlc: { deviceId: "server", wallMs: 1785160365213, counter: 0 },
    seq: 4,
  });
  expect(parsed).toMatchObject({ kind: "participant-strokes-set", golferId: "facc2215-df17-4e01-9cdd-e9333389c49e", strokes: 20 });
});

it("reads that same retired kind through the archive door too", () => {
  // The archive parses its own `events` array. A normalisation applied to roundEventSchema but
  // not here would load a live round correctly and the finished one off the wrong number.
  const archive = { ...validArchive, events: [...validArchive.events, legacyHandicapSetEvent] };
  expect(parse(roundArchiveSchema, archive).events.at(-1)).toMatchObject({ kind: "participant-strokes-set", strokes: 20 });
});
```

Use the values above verbatim — they are copied from prod's actual stored records.

- [ ] **Step 2: Run them and watch the legacy cases fail**

Run: `pnpm -F @swng/contracts vitest run src/round.test.ts`
Expected: the three legacy cases FAIL; the post-arc and the refuses-neither cases pass.

- [ ] **Step 3: Add the arm**

Participant: both numbers optional on the way in, a `.transform` yielding `strokes: strokes ?? courseHandicap`, a `.refine` rejecting when neither was present. Keep `strokes` UNBOUNDED (Arc A's placement rule — the bounded copy lives in `commands.ts`).

Event kind: translate to `participant-strokes-set`. **Known hazard, flagged so it is not discovered late:** a `.transform` inside a `z.discriminatedUnion` member may not stay discriminable in zod 4. If it does not, normalise ahead of the union and point BOTH doors at the normalising schema — leave `roundEventSchemaImpl` itself unannotated and unchanged so `round.test.ts`'s compile-time parity check keeps checking the modern union (a legacy stored shape is not a `RoundEvent`, and the parity check should not be loosened to pretend otherwise).

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

The retired participant-handicap-set event translates the same way. It is not
cosmetic: all three of prod's finished rounds had a number corrected mid-round,
so dropping it would render each of them off the pre-correction number, quietly.

Exact here and NOT on beta, which had run the intermediate relative-to-par
model where the same field could be either an absolute number or an already
hand-typed difference."
```

---

## Task 2: Prove it on the real bytes, read-only

**Files:**
- Create: `scripts/checkProdRoundsParse.mjs`

- [ ] **Step 1: Write the script**

Reads, never writes. Takes `--stage` (default `prod`). Scans **all three** tables — rounds, snapshots, and projections — and for each record:

- rounds-table items carrying an `event`: parse with `roundEventSchema`
- snapshots: parse with `roundArchiveSchema`
- projection items carrying a `line`: assert the normalised `strokes` is a number

Print one line per record — `ok` / `FAILED <reason>` — then a summary count per table. **Exit non-zero if any record fails**, so it can gate a deploy.

For the two shapes prod is known to carry, print the translated value, not just `ok`: a
`participant-joined` should report the strokes it resolved to, and a `participant-handicap-set`
should report `→ participant-strokes-set N`. A check that only says "parsed" cannot distinguish a
faithful translation from a confident wrong one, and the numbers are hand-verifiable against the
plan's Global Constraints (Pita 0→36, Blaine 37→20, Blaine 16→13).

It must contain no delete, put, or update call of any kind. Say so in a header comment, and make the AWS client construction read-only-by-inspection (only `ScanCommand` imported).

- [ ] **Step 2: Run it against prod BEFORE deploying**

Run: `AWS_PROFILE=swng node scripts/checkProdRoundsParse.mjs --stage prod`
Expected: exit 0, with 150 events, 3 snapshots and 8 projection lines all `ok` — and the three translated corrections reading 36, 20 and 13. Record the output in the arc's ledger.

If ANY record fails, stop and report — do not deploy, and do not "fix" it by touching data.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(scripts): a read-only check that prod's stored rounds parse"
```

---

## Task 3: Prod deploy (CONTROLLER-RUN)

Run it — this is the same controller-run deploy cycle as every other stage, including prod's own
launch (Arc C, 2026-07-24). Nothing here is an owner decision; it is execution behind gates, and
Task 2 is the gate that makes it safe. An earlier draft of this plan marked it "owner-triggered"
out of caution about the word "prod"; that was hedging, not judgment.

**The one live-environment fact, stated rather than asked about:** prod serves 6 real accounts,
and between Step 3 and Step 4 the deployed web bundle is the pre-arc one, whose create/join
request shape the new lambda rejects. Anyone using prod in that window cannot start or join a
round. Run Steps 3 and 4 back to back so it is seconds, and do not begin the sequence if a real
round is known to be in progress.

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

**Spec coverage.** §1 → context. §2's five read paths → T1's four sites (the archive's roster and its embedded events are two of them). §3's non-goals → the Global Constraints and T3 Step 7's count check. §4 → T1. §5 → T1's comment. §6 → T2 and T3.

**What the first draft of this plan missed, recorded because the lesson is reusable.** It named `participant-joined` and stopped, because that is the shape the *rename* touched. Prod's actual bytes carry a second casualty the rename never mentioned — a whole retired event KIND — and it was found by scanning the three tables and printing key sets, not by reasoning about the diff. The general form: **a compatibility gate is derived from reading the old data, never from reading the change that broke it.**

**The thing a reviewer must not "simplify".** The arm is deliberately permissive on the way IN and strict on the way OUT: both fields optional, then a refine that rejects when neither is present. Collapsing that to `strokes: z.number().optional().default(0)` would silently seat every unreadable participant at 0 strokes — the exact silent-wrong-number failure this arc exists to prevent, and no test that only checks "it parses" would catch it.

**Type consistency.** `strokes: number` remains required on the parsed output everywhere; only the accepted INPUT widens. No consumer changes.

**Ordering.** T1 before T2 (nothing to verify until the arm exists). T2 before T3, and T2 is what makes T3 safe to start.
