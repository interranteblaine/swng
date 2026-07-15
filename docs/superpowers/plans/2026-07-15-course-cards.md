# Course Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace M6's mutable course aggregate with immutable card lineages — the server resolves and freezes the current card at round creation (the client can no longer author a card), every snapshot records `(courseId, cardId, teeId per tee)`, verification is deleted, course writes are authenticated, and courses get their own product surface.

**Architecture:** One noun end to end: a `CardRecord` wraps the exact `CourseCard` value rounds freeze (no translation function exists). A course is a lineage of write-once card items plus one mutable CURRENT pointer; every mutation is a whole-card supersession guarded by one condition (`pointer.cardId === supersedes`) surfacing one error (`card-superseded`, 409). `StartRound` becomes a reference command. The round domain (fold, scoring, settle, archive, join, peek) is untouched except two optional identity fields on types it already imports.

**Tech Stack:** TypeScript ESM monorepo (pnpm), Zod wire schemas, DynamoDB (lib-dynamodb, TransactWriteCommand), Vitest, React 19 + react-router, Playwright e2e, CDK.

**Spec:** `docs/superpowers/specs/2026-07-15-course-cards-design.md` — the authority for every behavior below.

## Global Constraints

- `pnpm validate` (lint + typecheck + build + test, hermetic) must be GREEN at every commit. The task order exists for this: additive tasks first (T1, T3), consumers shed dependencies before producers delete (T2 before T4), wire switches update ALL in-repo consumers (web pages, web-e2e helpers, root-e2e helpers) inside the same task.
- Validation bounds are copied **verbatim** from M6's `validateTeeSet` (`packages/domain/src/course/course.ts:29-35`): course name 1–80 chars, tee name 1–40 chars, par 3–6, yardage integer 1–800, rating 30–90, slope integer 55–155, holes numbered 1..N in play order, strokeIndex a permutation of 1..N, hole count 9 or 18. NEW rule on top: every tee in a card has the SAME hole count (`mismatched-hole-count`).
- Spec invariants (§10) bind every task; the load-bearing ones: cards are immutable/write-once/never deleted (`attribute_not_exists`, not convention); the stored unit is the frozen unit (`startRound` freezes `CardRecord.card` verbatim); tee identity is recorded at write time, never inferred (server-minted `TeeId`s; submitted ids must exist in the superseded card); staleness anywhere is 409 `card-superseded`; `enteredBy` is auth-derived, never wire-supplied; the old `card:` field on StartRound is GONE, not tolerated.
- Identity fields are **optional on the value types** (`CourseCard.source?`, `TeeSet.teeId?`) so fixtures and frozen decks compile untouched — required **by construction** at the write path (every stored/frozen card has them).
- No `Date.now()`/`randomUUID` inside domain functions — time and ids arrive as inputs (`nowMs`, pre-minted ids), the standing convention.
- Commit after each task, message style `feat(scope): …` / `refactor(scope): …`, ending with the Claude Code co-author trailer.
- Route arithmetic when done: 37 → **36 HTTP** (38 total with the two WS routes); anonymous-throttled set 9 → **6**.
- Things the CONTROLLER does after all tasks (not in any task): final whole-branch review, beta deploy, run the scrap script, re-enter Casa Verde by hand (live walk), `pnpm e2e:beta` ×2, `pnpm e2e:field`, `pnpm test:contract`, CLAUDE.md/docs updates.

## File Map

| Task | Creates | Modifies | Deletes |
|---|---|---|---|
| T1 | — | `packages/domain/src/ids.ts`, `packages/domain/src/course/card.ts`, `packages/domain/src/course/course.ts`, `packages/domain/src/course/course.test.ts` (or the module's existing test file) | — |
| T2 | — | `apps/web/src/courses/CourseSummaryCard.tsx` + test, `apps/web/src/api.ts` | verify UI/api fn |
| T3 | `packages/application/src/ports/cardStore.ts`, `packages/adapters-dynamodb/src/createDynamoCardStore.ts`, `packages/adapters-dynamodb/src/contract/cardStore.contract.test.ts` | `packages/adapters-dynamodb/src/keys.ts`, `packages/adapters-dynamodb/src/index.ts`, `packages/application/src/index.ts` | — |
| T4 | `packages/application/src/courses/supersedeCard.ts` | `packages/contracts/src/{ids,round,courses}.ts`, `packages/application/src/courses/{createCourse,getCourse,searchCourses,courseView}.ts` + `courseSlice.test.ts`, `packages/lambda/src/http/{routes,errorMapping}.ts`, `packages/lambda/src/compositionRoot.ts`, `apps/web/src/api.ts`, `apps/web/src/courses/{CourseSummaryCard,AddCoursePage,CourseSearch}.tsx` + tests, `apps/web/src/routes/{CreateRoundPage,ProfilePage}.tsx`, `apps/web/src/App.tsx`, `apps/web/e2e/support.ts` | `packages/application/src/courses/{addTeeSet,verifyTeeSet}.ts`, `packages/application/src/ports/courseStore.ts`, `packages/adapters-dynamodb/src/createDynamoCourseStore.ts`, `packages/adapters-dynamodb/src/contract/courseStore.contract.test.ts`, `apps/web/src/courses/EditCoursePage.tsx` + test, old domain model (`Course`/`TeeSetVersion`/entity fns/`courseCardOf`) |
| T5 | — | `packages/contracts/src/commands.ts`, `packages/application/src/rounds/startRound.ts` + tests, `packages/lambda/src/compositionRoot.ts`, `apps/web/src/routes/CreateRoundPage.tsx` + test, `apps/web/e2e/support.ts` + every spec calling `startRoundDirect`/`ensureCourse`, `e2e/support/client.ts` + root-e2e specs | — |
| T6 | `apps/web/src/courses/CoursePage.tsx` + test, `apps/web/src/courses/EditCoursePage.tsx` (new implementation) + test | `apps/web/src/App.tsx`, `apps/web/src/courses/AddCoursePage.tsx` + test, `apps/web/src/courses/CourseSummaryCard.tsx` | — |
| T7 | — | `packages/domain/src/golfer/record.ts` + test, `packages/contracts/src/golfers.ts`, `packages/adapters-dynamodb/src/contract/projectionStore.contract.test.ts` | — |
| T8 | — | `apps/infra-cdk/lib/swngStack.ts`, `apps/infra-cdk/test/swngStack.test.ts` | 2 routes from tables |
| T9 | — | `apps/web/e2e/courseEntry.spec.ts` | — |
| T10 | `scripts/scrapCourseAndRoundData.mjs` | — | — |

---

### Task 1: Domain — the card model (additive)

The new model lands BESIDE the old (`Course`/`TeeSetVersion` stay until T4 deletes them) so every downstream package keeps compiling.

**Files:**
- Modify: `packages/domain/src/ids.ts`
- Modify: `packages/domain/src/course/card.ts`
- Modify: `packages/domain/src/course/course.ts` (append new model; touch nothing existing)
- Test: the existing course domain test file (find it: `ls packages/domain/src/course/*.test.ts`; if none exists co-locate a new `course.test.ts`)

**Interfaces (Produces — later tasks rely on these exact names):**
- `CardId`, `TeeId` brands + `cardId()`, `teeId()` constructors (ids.ts)
- `CardSource { cardId, courseId }`; `CourseCard.source?: CardSource`; `TeeSet.teeId?: TeeId` (card.ts)
- `EnteredBy { golferId: GolferId; name: string }`, `CardRecord`, `buildCardRecord(input)`, `validateTeeContinuity(currentCard, tees)` (course.ts)
- DomainError codes: `mismatched-hole-count`, `unknown-tee-id`, `duplicate-tee-id` (all new), plus every existing `invalid-*`/`duplicate-tee-name` code reused verbatim

- [ ] **Step 1: Brands.** In `packages/domain/src/ids.ts` add after the `CrewId` line:

```ts
export type CardId = Brand<string, "CardId">;
export type TeeId = Brand<string, "TeeId">;
```

and after `crewId`:

```ts
export const cardId = (value: string): CardId => value as CardId;
export const teeId = (value: string): TeeId => value as TeeId;
```

- [ ] **Step 2: Card value types.** In `packages/domain/src/course/card.ts`, add the import `import type { CardId, CourseId, TeeId } from "../ids.js";` and change `TeeSet`/`CourseCard` to:

```ts
export interface TeeSet {
  // Optional on the VALUE type (fixtures/decks construct cards directly; pre-scrap frozen
  // cards lack it) — present on every stored and newly-frozen card by construction
  // (buildCardRecord's invariant). Course-cards spec §3.
  readonly teeId?: TeeId;
  readonly name: string;
  readonly rating: number;
  readonly slope: number;
  readonly holes: readonly Hole[]; // 9 or 18, in play order
}

// Which course record and exact card this value was frozen from — creation-time facts,
// never dereferenced for rendering or math (spec §2: frozen values are the only inputs).
export interface CardSource {
  readonly cardId: CardId;
  readonly courseId: CourseId;
}

export interface CourseCard {
  readonly courseName: string;
  readonly source?: CardSource; // same optional-on-value-type split as TeeSet.teeId above
  readonly teeSets: readonly TeeSet[];
}
```

`Hole` and `findTeeSet` are untouched.

- [ ] **Step 3: Write the failing tests.** In the course domain test file, add (adjusting the import list to the file's existing style):

```ts
import { describe, expect, it } from "vitest";
import { buildCardRecord, validateTeeContinuity } from "./course.js";
import { cardId, courseId, golferId, teeId } from "../ids.js";
import type { TeeSet } from "./card.js";

const nineHoles = Array.from({ length: 9 }, (_, i) => ({ number: i + 1, par: 4, yardage: 400, strokeIndex: i + 1 }));
const tee = (name: string, id?: string): TeeSet => ({ ...(id ? { teeId: teeId(id) } : {}), name, rating: 71.1, slope: 129, holes: nineHoles });
const base = {
  cardId: cardId("c-1"),
  courseId: courseId("k-1"),
  courseName: "Casa Verde GC",
  enteredBy: { golferId: golferId("g-1"), name: "Blaine" },
  enteredAtMs: 1_000,
};

describe("buildCardRecord", () => {
  it("assembles a record whose card carries source and whose every tee carries its id", () => {
    const record = buildCardRecord({ ...base, teeSets: [tee("white", "t-1"), tee("blue", "t-2")] });
    expect(record.card.source).toEqual({ cardId: base.cardId, courseId: base.courseId });
    expect(record.card.teeSets.map((t) => t.teeId)).toEqual([teeId("t-1"), teeId("t-2")]);
    expect(record.provenance).toBe("community");
    expect(record.supersedes).toBeUndefined();
  });

  it("rejects a tee without an id — stored cards always carry identity", () => {
    expect(() => buildCardRecord({ ...base, teeSets: [tee("white")] })).toThrow(/tee-id/);
  });

  it("rejects duplicate tee ids in one card", () => {
    expect(() => buildCardRecord({ ...base, teeSets: [tee("white", "t-1"), tee("blue", "t-1")] })).toThrowError(
      expect.objectContaining({ code: "duplicate-tee-id" }),
    );
  });

  it("rejects mixed hole counts across tees (mismatched-hole-count)", () => {
    const eighteen = { ...tee("blue", "t-2"), holes: Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4, yardage: 400, strokeIndex: i + 1 })) };
    expect(() => buildCardRecord({ ...base, teeSets: [tee("white", "t-1"), eighteen] })).toThrowError(
      expect.objectContaining({ code: "mismatched-hole-count" }),
    );
  });

  it("keeps every M6 per-tee rule — e.g. a non-permutation strokeIndex still throws invalid-stroke-index", () => {
    const bad = { ...tee("white", "t-1"), holes: nineHoles.map((h) => ({ ...h, strokeIndex: 1 })) };
    expect(() => buildCardRecord({ ...base, teeSets: [bad] })).toThrowError(expect.objectContaining({ code: "invalid-stroke-index" }));
  });

  it("rejects case-insensitive duplicate tee names (duplicate-tee-name)", () => {
    expect(() => buildCardRecord({ ...base, teeSets: [tee("White", "t-1"), tee("WHITE", "t-2")] })).toThrowError(
      expect.objectContaining({ code: "duplicate-tee-name" }),
    );
  });
});

describe("validateTeeContinuity", () => {
  const current = buildCardRecord({ ...base, teeSets: [tee("white", "t-1")] }).card;

  it("accepts a kept id, an id-less new tee, and a rename under a kept id", () => {
    expect(() => validateTeeContinuity(current, [tee("whites", "t-1"), tee("blue")])).not.toThrow();
  });

  it("rejects an id the superseded card never had (unknown-tee-id)", () => {
    expect(() => validateTeeContinuity(current, [tee("white", "t-9")])).toThrowError(expect.objectContaining({ code: "unknown-tee-id" }));
  });

  it("rejects the same id submitted twice (duplicate-tee-id)", () => {
    expect(() => validateTeeContinuity(current, [tee("white", "t-1"), tee("blue", "t-1")])).toThrowError(
      expect.objectContaining({ code: "duplicate-tee-id" }),
    );
  });
});
```

- [ ] **Step 4: Run to verify failure.** `pnpm -F @swng/domain vitest run src/course` — expect FAIL (`buildCardRecord` not exported).

- [ ] **Step 5: Implement.** Append to `packages/domain/src/course/course.ts` (imports merged at top: `CardId`, `GolferId`, `TeeId` types from `../ids.js`; keep every existing export untouched):

```ts
// ——— Course-cards model (spec 2026-07-15) ———
// The system stores exactly one kind of thing: complete, immutable cards, in lineages.
// A CardRecord wraps the EXACT CourseCard value rounds freeze — the stored unit is the
// frozen unit; no translation function exists (spec invariant 3). The M6 aggregate above
// is deleted once the wire switches over (plan T4).

export interface EnteredBy {
  readonly golferId: GolferId;
  readonly name: string; // display name at write time, frozen — renames never rewrite attribution
}

export interface CardRecord {
  readonly cardId: CardId;
  readonly courseId: CourseId;
  readonly card: CourseCard; // card.source === { cardId, courseId }; every tee carries teeId
  readonly enteredBy: EnteredBy;
  readonly enteredAtMs: number;
  readonly provenance: Provenance;
  readonly supersedes?: CardId; // absent on lineage roots
}

// The whole-card validity rules: M6's validateTeeSet verbatim per tee, PLUS the card-level
// rules the aggregate never had — ≥1 tee, unique names, and ONE hole count across every tee
// (spec invariant 6: a frozen card cannot be internally contradictory).
export const validateCard = (card: CourseCard): void => {
  validateCourseName(card.courseName);
  if (card.teeSets.length === 0) {
    throw new DomainError("invalid-hole-count", "a card must have at least one tee set");
  }
  card.teeSets.forEach((tee) => validateTeeSet(tee));

  const lowerNames = card.teeSets.map((t) => t.name.toLowerCase());
  if (new Set(lowerNames).size !== lowerNames.length) {
    throw new DomainError("duplicate-tee-name", "tee names must be unique (case-insensitive) within a card");
  }

  const holeCounts = new Set(card.teeSets.map((t) => t.holes.length));
  if (holeCounts.size > 1) {
    throw new DomainError("mismatched-hole-count", `every tee in a card must describe the same holes; got counts ${[...holeCounts].join(", ")}`);
  }
};

// Tee identity is recorded at write time, never inferred later (spec invariant 2): a
// submitted teeId must exist in the card being superseded, and no id may appear twice.
// An id-less tee is NEW (the caller mints its id after this passes).
export const validateTeeContinuity = (currentCard: CourseCard, tees: readonly { readonly teeId?: TeeId; readonly name: string }[]): void => {
  const knownIds = new Set(currentCard.teeSets.map((t) => t.teeId).filter((id): id is TeeId => id !== undefined));
  const seen = new Set<TeeId>();
  for (const tee of tees) {
    if (tee.teeId === undefined) continue;
    if (seen.has(tee.teeId)) {
      throw new DomainError("duplicate-tee-id", `tee id "${tee.teeId}" submitted more than once`);
    }
    seen.add(tee.teeId);
    if (!knownIds.has(tee.teeId)) {
      throw new DomainError("unknown-tee-id", `tee "${tee.name}" claims id "${tee.teeId}", which the superseded card does not have`);
    }
  }
};

// Assembles + validates a CardRecord. Every input tee must already carry its (server-minted)
// teeId — an id-less tee here is a caller bug, not client input, hence a plain Error rather
// than a wire-mapped DomainError.
export const buildCardRecord = (input: {
  readonly cardId: CardId;
  readonly courseId: CourseId;
  readonly courseName: string;
  readonly teeSets: readonly TeeSet[];
  readonly enteredBy: EnteredBy;
  readonly enteredAtMs: number;
  readonly provenance?: Provenance;
  readonly supersedes?: CardId;
}): CardRecord => {
  const ids = input.teeSets.map((t) => t.teeId);
  if (ids.some((id) => id === undefined)) {
    throw new Error("buildCardRecord: every stored tee must carry a teeId (caller mints before assembling)");
  }
  if (new Set(ids).size !== ids.length) {
    throw new DomainError("duplicate-tee-id", "tee ids must be unique within a card");
  }
  const card: CourseCard = {
    courseName: input.courseName,
    source: { cardId: input.cardId, courseId: input.courseId },
    teeSets: input.teeSets,
  };
  validateCard(card);
  return {
    cardId: input.cardId,
    courseId: input.courseId,
    card,
    enteredBy: input.enteredBy,
    enteredAtMs: input.enteredAtMs,
    provenance: input.provenance ?? "community",
    ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
  };
};
```

Note `validateCourseName`/`validateTeeSet` already exist in this file — reuse them, do not copy.

- [ ] **Step 6: Run tests.** `pnpm -F @swng/domain vitest run src/course` — expect PASS (new + all existing).

- [ ] **Step 7: Validate + commit.** `pnpm validate` → green. `git add -A && git commit` — `feat(domain): the card model — immutable CardRecord lineages beside the M6 aggregate`.

---

### Task 2: Web sheds verification (consumer-first deletion)

The recorded lesson: consumers drop a dependency BEFORE the producer deletes it. After this task nothing in the repo calls `verifyTeeSet`, so T4's backend deletion can't break the web.

**Files:**
- Modify: `apps/web/src/courses/CourseSummaryCard.tsx`, `apps/web/src/courses/CourseSummaryCard.test.tsx`, `apps/web/src/api.ts`

**Interfaces:** Consumes nothing new. Produces: a `CourseSummaryCard` with no verify affordance (still on the OLD `CourseView` shape — T4 reshapes it).

- [ ] **Step 1:** In `CourseSummaryCard.tsx` delete: the `verify` async function whole (lines ~38-77), the "Verify this card" `<button>` (~111-113), the `verifyError` state + its `<p role="alert">` block, and the now-unused imports (`verifyTeeSet`, `getCourse` if only verify used it, `ApiError` if unused, `useAuth` if unused). In the per-tee metadata list, replace the verified-count badge line:

```tsx
{teeSet.name}: entered by {teeSet.enteredBy}
```

(drop the `· ✓ N verified` / `· not yet verified` ternary — honest attribution only, spec §8). Keep `onCourseRefreshed` in the props type (the edit-return flow still uses it via CreateRoundPage) — if the prop becomes unread in this file, remove it from destructuring but keep the interface field documented as edit-flow plumbing.

- [ ] **Step 2:** In `apps/web/src/api.ts` delete the `verifyTeeSet` function (~lines 219-222) and its now-unused imports (`VerifyTeeSetRequest`, `VerifyTeeSetResponse`, `verifyTeeSetResponseSchema`).

- [ ] **Step 3:** Update `CourseSummaryCard.test.tsx`: delete every verify-flow test (the prompt mock, the 409 re-fetch test); add one asserting the badge is gone:

```tsx
it("shows attribution without any verification badge", () => {
  render(<CourseSummaryCard course={courseView} selectedTee="white" onSelectTee={() => {}} />);
  expect(screen.getByText(/entered by/)).toBeInTheDocument();
  expect(screen.queryByText(/verified/i)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /verify/i })).not.toBeInTheDocument();
});
```

(match the file's existing render/fixture helpers — reuse its `courseView` fixture).

- [ ] **Step 4:** `pnpm -F @swng/web test` → PASS, then `pnpm validate` → green. Commit: `refactor(web): the verify affordance is gone — attribution only (course-cards spec §8)`.

---

### Task 3: The card store (additive port + adapter + contract tests)

New `CardStore` port and DynamoDB adapter land beside the old `CourseStore` (old use cases keep compiling); T4 switches consumers and deletes the old pair.

**Files:**
- Create: `packages/application/src/ports/cardStore.ts`
- Create: `packages/adapters-dynamodb/src/createDynamoCardStore.ts`
- Create: `packages/adapters-dynamodb/src/contract/cardStore.contract.test.ts`
- Modify: `packages/adapters-dynamodb/src/keys.ts` (add `cardSk`, `courseCurrentSk`), `packages/adapters-dynamodb/src/index.ts`, `packages/application/src/index.ts` (export the port — mirror how `courseStore.ts` is exported today)

**Interfaces (Produces):**

```ts
export interface CardStore {
  create(record: CardRecord): Promise<void>;
  supersede(record: CardRecord): Promise<void>; // record.supersedes REQUIRED; throws ApplicationError("card-superseded") if the pointer moved
  getCurrent(courseId: CourseId): Promise<CardRecord | undefined>;
  search(nameKeyPrefix: string, limit: number): Promise<readonly { courseId: CourseId; name: string; holeCount: 9 | 18 }[]>;
}
```

- [ ] **Step 1: Port.** Write `packages/application/src/ports/cardStore.ts`:

```ts
import type { CardRecord, CourseId } from "@swng/domain";

// The course system stores exactly one kind of thing: immutable cards, in lineages
// (course-cards spec §2). One mutable CURRENT pointer per lineage + one write-once item per
// card. There are NO retries and no revision counter: every write names the exact card the
// caller reviewed (record.supersedes), and a moved pointer is a 409 the human re-reviews —
// identity does the work M6's revision/pin/retry trio used to (spec §6).
export interface CardStore {
  // New lineage: pointer + first card in one transaction, both attribute_not_exists.
  create(record: CardRecord): Promise<void>;
  // Whole-card supersession: put the new card (write-once) + move the pointer, conditioned on
  // pointer.cardId === record.supersedes. Condition failure ⇒ ApplicationError("card-superseded").
  supersede(record: CardRecord): Promise<void>;
  // The lineage's current card — what getCourse serves and what startRound freezes.
  getCurrent(courseId: CourseId): Promise<CardRecord | undefined>;
  // Prefix search over CURRENT pointers only (courseNameKey normalization, same as writes).
  search(nameKeyPrefix: string, limit: number): Promise<readonly { courseId: CourseId; name: string; holeCount: 9 | 18 }[]>;
}
```

- [ ] **Step 2: Keys.** In `packages/adapters-dynamodb/src/keys.ts`, below the existing course block add:

```ts
// Course-cards spec §5: one immutable item per card under the lineage's own partition, plus
// one mutable CURRENT pointer carrying the search-GSI attributes. The pointer's sk is
// deliberately NOT the legacy "COURSE" constant — legacy single-document items are wiped at
// rollout (spec §9), never read by the new store.
export const courseCurrentSk = "CURRENT";
export const cardSk = (id: CardId): string => `CARD#${id}`;
```

(add `CardId` to the type import). Do NOT delete `courseSk` yet — the old adapter still uses it until T4.

- [ ] **Step 3: Contract tests first.** Write `packages/adapters-dynamodb/src/contract/cardStore.contract.test.ts` following `courseStore.contract.test.ts`'s exact harness idiom (`startLocalDynamo`, shared `local`, per-test random ids):

```ts
import { randomUUID } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CardRecord } from "@swng/domain";
import { buildCardRecord, cardId, courseId, fixtureWhite, golferId, teeId } from "@swng/domain";
import { createDynamoCardStore } from "../createDynamoCardStore.js";
import { cardSk, coursePk, courseCurrentSk } from "../keys.js";
import type { LocalDynamo } from "../testing/local.js";
import { startLocalDynamo } from "../testing/local.js";

let local: LocalDynamo;
beforeAll(async () => {
  local = await startLocalDynamo();
}, 120_000);
afterAll(async () => {
  await local?.stop();
});

const newStore = () => createDynamoCardStore({ client: local.client, tableName: local.coreTable });

const makeRecord = (name: string, over?: Partial<Parameters<typeof buildCardRecord>[0]>): CardRecord =>
  buildCardRecord({
    cardId: cardId(randomUUID()),
    courseId: courseId(randomUUID()),
    courseName: name,
    teeSets: [{ ...fixtureWhite, teeId: teeId(randomUUID()) }],
    enteredBy: { golferId: golferId(randomUUID()), name: "Ann" },
    enteredAtMs: 1_000,
    ...over,
  });

describe("createDynamoCardStore", () => {
  it("create + getCurrent round-trips the exact CardRecord", async () => {
    const store = newStore();
    const record = makeRecord("Casa Verde GC");
    await store.create(record);
    expect(await store.getCurrent(record.courseId)).toEqual(record);
  });

  it("getCurrent on an unknown lineage returns undefined", async () => {
    expect(await newStore().getCurrent(courseId(randomUUID()))).toBeUndefined();
  });

  it("supersede moves the pointer and keeps the old card item intact (append-only lineage)", async () => {
    const store = newStore();
    const first = makeRecord("Pine Hollow");
    await store.create(first);
    const second = buildCardRecord({
      cardId: cardId(randomUUID()),
      courseId: first.courseId,
      courseName: "Pine Hollow GC",
      teeSets: first.card.teeSets,
      enteredBy: first.enteredBy,
      enteredAtMs: 2_000,
      supersedes: first.cardId,
    });
    await store.supersede(second);
    expect(await store.getCurrent(first.courseId)).toEqual(second);
    // The superseded card is still there, byte-identical — never deleted (spec invariant 1).
    const raw = await local.client.send(
      new GetCommand({ TableName: local.coreTable, Key: { pk: coursePk(first.courseId), sk: cardSk(first.cardId) } }),
    );
    expect(raw.Item?.record).toEqual(first);
  });

  it("a stale supersedes (pointer already moved) throws card-superseded and writes nothing current", async () => {
    const store = newStore();
    const first = makeRecord("Twin Oaks");
    await store.create(first);
    const winner = buildCardRecord({ ...recordInput(first, "Twin Oaks"), enteredAtMs: 2_000, supersedes: first.cardId });
    const loser = buildCardRecord({ ...recordInput(first, "Twin Oaks"), enteredAtMs: 3_000, supersedes: first.cardId });
    await store.supersede(winner);
    await expect(store.supersede(loser)).rejects.toMatchObject({ code: "card-superseded" });
    expect((await store.getCurrent(first.courseId))?.cardId).toBe(winner.cardId);
  });

  it("search returns {courseId, name, holeCount} prefix matches over CURRENT pointers only, respecting limit", async () => {
    const store = newStore();
    const token = randomUUID().slice(0, 8);
    const a = makeRecord(`${token}a verde gc`);
    const b = makeRecord(`${token}a blanca`);
    const miss = makeRecord(`zz-${token} ridge`);
    await store.create(a);
    await store.create(b);
    await store.create(miss);
    const results = await store.search(`${token}a`, 25);
    expect(new Set(results.map((r) => r.courseId))).toEqual(new Set([a.courseId, b.courseId]));
    expect(results.every((r) => r.holeCount === a.card.teeSets[0]!.holes.length)).toBe(true);
    expect(await store.search(`${token}a`, 1)).toHaveLength(1);
  });

  it("a rename via supersede is found under its NEW normalized name, not the old", async () => {
    const store = newStore();
    const token = randomUUID().slice(0, 8);
    const first = makeRecord(`${token}-before`);
    await store.create(first);
    const renamed = buildCardRecord({ ...recordInput(first, `${token}-after`), enteredAtMs: 2_000, supersedes: first.cardId });
    await store.supersede(renamed);
    expect(await store.search(`${token}-after`, 5)).toHaveLength(1);
    expect(await store.search(`${token}-before`, 5)).toHaveLength(0);
  });
});

// helper: rebuild a valid buildCardRecord input from an existing record with a fresh cardId
const recordInput = (from: CardRecord, courseName: string) => ({
  cardId: cardId(randomUUID()),
  courseId: from.courseId,
  courseName,
  teeSets: from.card.teeSets,
  enteredBy: from.enteredBy,
});
```

(Hoist `recordInput` above its first use. `fixtureWhite` is the existing golden tee fixture — 18 holes; the exact hole count doesn't matter to these tests.)

- [ ] **Step 4: Adapter.** Write `packages/adapters-dynamodb/src/createDynamoCardStore.ts`:

```ts
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { CardRecord, CourseId } from "@swng/domain";
import { courseNameKey } from "@swng/domain";
import type { CardStore } from "@swng/application";
import { ApplicationError } from "@swng/application";
import { cardSk, courseCurrentSk, courseGsi1pk, courseIdFromPk, coursePk } from "./keys.js";

// Course-cards spec §5. Two item kinds under one lineage partition:
//   pk=COURSE#<courseId> sk=CURRENT        — mutable pointer {cardId, name, holeCount, gsi1 keys}
//   pk=COURSE#<courseId> sk=CARD#<cardId>  — write-once {record: CardRecord}
// Cards are immutable, so a torn read is unrepresentable: whichever pointer a reader sees
// names a complete, frozen item. One transaction shape per write; one 409 (card-superseded).
export const createDynamoCardStore = (config: { client: DynamoDBDocumentClient; tableName: string }): CardStore => {
  const { client, tableName } = config;

  const cardPut = (record: CardRecord) => ({
    Put: {
      TableName: tableName,
      Item: { pk: coursePk(record.courseId), sk: cardSk(record.cardId), record },
      // Write-once enforced by the database, not convention (spec invariant 1).
      ConditionExpression: "attribute_not_exists(pk)",
    },
  });

  const pointerAttrs = (record: CardRecord) => ({
    cardId: record.cardId,
    name: record.card.courseName,
    holeCount: record.card.teeSets[0]!.holes.length, // uniform across tees (validateCard)
    gsi1pk: courseGsi1pk,
    gsi1sk: courseNameKey(record.card.courseName), // the ONE normalization (domain) — search's Query uses the same
  });

  return {
    create: async (record: CardRecord) => {
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            cardPut(record),
            {
              Put: {
                TableName: tableName,
                Item: { pk: coursePk(record.courseId), sk: courseCurrentSk, ...pointerAttrs(record) },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
    },

    supersede: async (record: CardRecord) => {
      if (record.supersedes === undefined) throw new Error("supersede: record.supersedes is required");
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              cardPut(record),
              {
                Update: {
                  TableName: tableName,
                  Key: { pk: coursePk(record.courseId), sk: courseCurrentSk },
                  UpdateExpression: "SET cardId = :cardId, #name = :name, holeCount = :holeCount, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk",
                  // The one concurrency rule (spec §6): the pointer must still name the exact
                  // card the caller reviewed.
                  ConditionExpression: "cardId = :supersedes",
                  ExpressionAttributeNames: { "#name": "name" },
                  ExpressionAttributeValues: { ":supersedes": record.supersedes, ...prefixColons(pointerAttrs(record)) },
                },
              },
            ],
          }),
        );
      } catch (error) {
        if (error instanceof TransactionCanceledException && error.CancellationReasons?.some((r) => r.Code === "ConditionalCheckFailed")) {
          throw new ApplicationError("card-superseded", `course ${record.courseId}: the card being replaced is no longer current`);
        }
        throw error;
      }
    },

    getCurrent: async (id: CourseId) => {
      // Consistent on both hops: the pointer names an immutable item, so the second read can
      // only miss if it outraces replication of the very transaction that wrote both — and
      // startRound's freeze must never act on a pointer whose card it cannot read.
      const pointer = await client.send(
        new GetCommand({ TableName: tableName, Key: { pk: coursePk(id), sk: courseCurrentSk }, ConsistentRead: true }),
      );
      const current = pointer.Item as { cardId: string } | undefined;
      if (!current) return undefined;
      const card = await client.send(
        new GetCommand({ TableName: tableName, Key: { pk: coursePk(id), sk: cardSk(current.cardId as never) }, ConsistentRead: true }),
      );
      return (card.Item as { record: CardRecord } | undefined)?.record;
    },

    search: async (nameKeyPrefix: string, limit: number) => {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :gsi1pk AND begins_with(gsi1sk, :prefix)",
          ExpressionAttributeValues: { ":gsi1pk": courseGsi1pk, ":prefix": nameKeyPrefix },
          Limit: limit,
        }),
      );
      const keys = (result.Items ?? []).map((item) => ({ pk: item.pk as string, sk: courseCurrentSk }));
      if (keys.length === 0) return [];
      // gsi1's INCLUDE projection carries `name` only (unchanged from M6 — no stack change);
      // holeCount comes from a BatchGet of the ≤25 pointer items themselves. Two hops, both
      // trivial at this scale, zero infra churn (plan's deliberate trade — spec §4's search
      // response needs holeCount to distinguish routings entered as separate lineages).
      const batch = await client.send(new BatchGetCommand({ RequestItems: { [tableName]: { Keys: keys } } }));
      const byPk = new Map((batch.Responses?.[tableName] ?? []).map((item) => [item.pk as string, item]));
      return keys
        .map((key) => byPk.get(key.pk))
        .filter((item): item is Record<string, unknown> => item !== undefined)
        .map((item) => ({
          courseId: courseIdFromPk(item.pk as string),
          name: item.name as string,
          holeCount: item.holeCount as 9 | 18,
        }));
    },
  };
};

// TransactWriteCommand ExpressionAttributeValues want ":"-prefixed keys — one tiny mapper
// rather than five hand-typed pairs that could drift from pointerAttrs.
const prefixColons = (attrs: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(attrs).map(([k, v]) => [`:${k}`, v]));
```

(If `sk: cardSk(current.cardId as never)` offends the linter, type the pointer item as `{ cardId: CardId }` and import the type.)

- [ ] **Step 5: Exports.** Add `createDynamoCardStore` to `packages/adapters-dynamodb/src/index.ts` and `CardStore` (the port) to `packages/application/src/index.ts`, each beside its old counterpart.

- [ ] **Step 6: Run.** `pnpm test:contract` (needs Java/DynamoDB Local — the standing harness) → new suite PASS, old suites PASS. Then `pnpm validate` → green. Commit: `feat(adapters,application): the card store — write-once lineages, one pointer, one 409`.

---

### Task 4: The course wire switch (contracts → application → lambda → web, old model deleted)

The crux task: the course endpoints move to the card model in ONE coherent diff, updating every in-repo consumer, and the M6 aggregate is deleted whole. Steps are ordered so package suites can run between them; `pnpm validate` is the task-end gate before the single commit.

**Files:** see File Map. **Interfaces (Consumes):** T1's domain model, T3's `CardStore`. **(Produces):** the new wire shapes below — T5/T6/T9 build on them.

- [ ] **Step 1: contracts/ids.** In `packages/contracts/src/ids.ts`, add `cardIdSchema: z.ZodType<CardId>` and `teeIdSchema: z.ZodType<TeeId>` by copying `courseIdSchema`'s exact construction idiom (read the file; substitute the brand type and nothing else).

- [ ] **Step 2: contracts/round.ts.** `teeSetSchema` gains `teeId: teeIdSchema.optional()`; `courseCardSchema` gains `source: z.object({ cardId: cardIdSchema, courseId: courseIdSchema }).optional()`. Both optional — pre-scrap stored events/fixtures parse unchanged; every schema embedding the card (events, archive, peek) picks the fields up automatically.

- [ ] **Step 3: contracts/courses.ts — rewrite.** Replace the file's course-view/request section (keep `PeekRoundResponse` + its schema untouched at the bottom):

```ts
import { z } from "zod";
import type { CourseCard, CourseId } from "@swng/domain";
import { cardIdSchema, courseIdSchema } from "./ids.js";
import { courseCardSchema, holeSchema } from "./round.js";

// The wire view of a lineage's CURRENT card (course-cards spec §4): the exact frozen-able
// value plus attribution. No `name` field — the card carries courseName; no per-tee badge
// metadata — verification is gone (§8) and the audit trail stays server-side.
export interface CourseView {
  readonly courseId: CourseId;
  readonly cardId: string;
  readonly card: CourseCard;
  readonly enteredBy: string; // display name only; golferId stays server-side
  readonly updatedAtMs: number;
}

export const courseViewSchema: z.ZodType<CourseView> = z.object({
  courseId: courseIdSchema,
  cardId: z.string(),
  card: courseCardSchema,
  enteredBy: z.string(),
  updatedAtMs: z.number(),
});

// Input tees: POST mints every id (no teeId accepted — .strict() rejects it); PUT takes an
// optional teeId per the continuity rule (§3: with id = same tee, without = new, absent = removed).
const newTeeInputSchema = z
  .object({ name: z.string().min(1), rating: z.number(), slope: z.number(), holes: z.array(holeSchema).min(1).readonly() })
  .strict();
const continuingTeeInputSchema = newTeeInputSchema.extend({ teeId: z.string().min(1).optional() }).strict();

export const createCourseRequestSchema = z
  .object({ name: z.string().min(1), teeSets: z.array(newTeeInputSchema).min(1) })
  .strict();
export type CreateCourseRequest = z.infer<typeof createCourseRequestSchema>;

export const supersedeCardRequestSchema = z
  .object({ name: z.string().min(1), teeSets: z.array(continuingTeeInputSchema).min(1), supersedes: z.string().min(1) })
  .strict();
export type SupersedeCardRequest = z.infer<typeof supersedeCardRequestSchema>;

export interface CreateCourseResponse {
  readonly course: CourseView;
}
export interface SupersedeCardResponse {
  readonly course: CourseView;
}
export interface GetCourseResponse {
  readonly course: CourseView;
}
export interface SearchCoursesResponse {
  readonly courses: readonly { readonly courseId: CourseId; readonly name: string; readonly holeCount: 9 | 18 }[];
}

export const createCourseResponseSchema: z.ZodType<CreateCourseResponse> = z.object({ course: courseViewSchema });
export const supersedeCardResponseSchema: z.ZodType<SupersedeCardResponse> = z.object({ course: courseViewSchema });
export const getCourseResponseSchema: z.ZodType<GetCourseResponse> = z.object({ course: courseViewSchema });
export const searchCoursesResponseSchema: z.ZodType<SearchCoursesResponse> = z.object({
  courses: z
    .array(z.object({ courseId: courseIdSchema, name: z.string(), holeCount: z.union([z.literal(9), z.literal(18)]) }))
    .readonly(),
});
```

`holeSchema` is currently module-private in round.ts — export it. Delete `AddTeeSetRequest`/`VerifyTeeSetRequest`/`AddTeeSetResponse`/`VerifyTeeSetResponse` and their schemas.

- [ ] **Step 4: application/courses — rewrite.** `toCourseView` becomes trivial (`courseView.ts`):

```ts
import type { CardRecord } from "@swng/domain";
import type { CourseView } from "@swng/contracts";

// No translation exists — the view IS the record's card plus attribution (spec invariant 3).
export const toCourseView = (record: CardRecord): CourseView => ({
  courseId: record.courseId,
  cardId: record.cardId,
  card: record.card,
  enteredBy: record.enteredBy.name,
  updatedAtMs: record.enteredAtMs,
});
```

`createCourse.ts` (auth-derived attribution via the ONE get-or-create, same as startRound):

```ts
import { buildCardRecord, cardId as toCardId, courseId as toCourseId, teeId as toTeeId } from "@swng/domain";
import type { CreateCourseRequest, CreateCourseResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CardStore } from "../ports/cardStore.js";
import type { Clock } from "../ports/clock.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { Logger } from "../ports/logger.js";
import { ensureGolfer } from "../golfers/ensureGolfer.js";
import { toCourseView } from "./courseView.js";

export const createCourse =
  (deps: { cardStore: CardStore; golferStore: GolferStore; idGenerator: IdGenerator; clock: Clock; logger: Logger }) =>
  async (claims: AccountClaims, command: CreateCourseRequest): Promise<CreateCourseResponse> => {
    // enteredBy derives from the account, never the wire (spec invariant 7) — the same
    // get-or-create startRound uses, frozen into the record at write time.
    const author = await ensureGolfer({ golferStore: deps.golferStore, idGenerator: deps.idGenerator })(claims);
    const record = buildCardRecord({
      cardId: toCardId(deps.idGenerator.newId()),
      courseId: toCourseId(deps.idGenerator.newId()),
      courseName: command.name,
      teeSets: command.teeSets.map((tee) => ({ ...tee, teeId: toTeeId(deps.idGenerator.newId()) })),
      enteredBy: { golferId: author.id, name: author.name },
      enteredAtMs: deps.clock.now(),
    });
    await deps.cardStore.create(record);
    deps.logger.info("course-created", { courseId: record.courseId, cardId: record.cardId, name: command.name });
    return { course: toCourseView(record) };
  };
```

New `supersedeCard.ts`:

```ts
import { buildCardRecord, cardId as toCardId, teeId as toTeeId, validateTeeContinuity } from "@swng/domain";
import type { CourseId, TeeId } from "@swng/domain";
import type { SupersedeCardRequest, SupersedeCardResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { CardStore } from "../ports/cardStore.js";
import type { Clock } from "../ports/clock.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { Logger } from "../ports/logger.js";
import { ApplicationError } from "../errors.js";
import { ensureGolfer } from "../golfers/ensureGolfer.js";
import { toCourseView } from "./courseView.js";

// THE maintenance operation (spec §4): add a tee, fix numbers, rename course or tee — all one
// whole-card supersession. Two card-superseded gates: an early friendly check on read (the
// common case reports before any work), and the store's transact condition (the true arbiter
// under a race — spec §6's one rule).
export const supersedeCard =
  (deps: { cardStore: CardStore; golferStore: GolferStore; idGenerator: IdGenerator; clock: Clock; logger: Logger }) =>
  async (claims: AccountClaims, id: CourseId, command: SupersedeCardRequest): Promise<SupersedeCardResponse> => {
    const current = await deps.cardStore.getCurrent(id);
    if (!current) throw new ApplicationError("course-not-found");
    if (current.cardId !== command.supersedes) {
      throw new ApplicationError("card-superseded", `course ${id}: current card is ${current.cardId}, not ${command.supersedes}`);
    }

    const inputTees = command.teeSets.map((tee) => ({ ...tee, teeId: tee.teeId as TeeId | undefined }));
    validateTeeContinuity(current.card, inputTees); // unknown-tee-id / duplicate-tee-id (DomainError) propagate

    const author = await ensureGolfer({ golferStore: deps.golferStore, idGenerator: deps.idGenerator })(claims);
    const record = buildCardRecord({
      cardId: toCardId(deps.idGenerator.newId()),
      courseId: id,
      courseName: command.name,
      teeSets: inputTees.map((tee) => (tee.teeId !== undefined ? tee : { ...tee, teeId: toTeeId(deps.idGenerator.newId()) })),
      enteredBy: { golferId: author.id, name: author.name },
      enteredAtMs: deps.clock.now(),
      supersedes: current.cardId,
    });
    await deps.cardStore.supersede(record);
    deps.logger.info("card-superseded", { courseId: id, cardId: record.cardId, replaced: current.cardId });
    return { course: toCourseView(record) };
  };
```

`getCourse.ts`: swap `courseStore.get` → `cardStore.getCurrent`, `toCourseView(record)`. `searchCourses.ts`: swap port type only (same clamp; results now carry `holeCount`). DELETE `addTeeSet.ts` and `verifyTeeSet.ts`. Update `packages/application/src/index.ts` exports accordingly (export `supersedeCard`; drop the deleted pair; drop the old `CourseStore` port export; delete `ports/courseStore.ts`).

- [ ] **Step 5: application tests.** Rewrite `courseSlice.test.ts` against an in-memory `CardStore` fake (a `Map<CourseId, CardRecord[]>` whose `supersede` checks the last element's cardId — mirror the file's existing fake idiom and `createFixedClock`/`createNullLogger`/stub `ensureGolfer` via a fake GolferStore, the way existing golfer-slice tests stub it). Required cases: create mints distinct tee ids and returns a view whose `card.source` matches; supersede with a kept teeId preserves it and with a new tee mints one; early `card-superseded` when `supersedes` is stale; `unknown-tee-id` propagates; `course-not-found`. Run: `pnpm -F @swng/application vitest run src/courses` → PASS.

- [ ] **Step 6: lambda.** In `routes.ts`: UseCases entries become

```ts
createCourse: (claims: AccountClaims, command: CreateCourseRequest) => Promise<CreateCourseResponse>;
supersedeCard: (claims: AccountClaims, id: CourseId, command: SupersedeCardRequest) => Promise<SupersedeCardResponse>;
getCourse: (id: CourseId) => Promise<GetCourseResponse>;
searchCourses: (query: string, limit?: number) => Promise<SearchCoursesResponse>;
```

(delete `addTeeSet`/`verifyTeeSet` entries). Route table: replace the three POST course routes with

```ts
{
  method: "POST",
  path: "/courses",
  schema: createCourseRequestSchema,
  // Course-cards spec §4: writes are "golfer"-gated; enteredBy derives from the account.
  auth: "golfer",
  successStatus: 201,
  handler: async (ctx, body) => useCases.createCourse(ctx.account!, body as CreateCourseRequest),
},
{
  method: "PUT",
  path: "/courses/{courseId}",
  schema: supersedeCardRequestSchema,
  auth: "golfer", // THE maintenance operation — add tee / fix numbers / rename are all this (spec §4)
  successStatus: 200,
  handler: async (ctx, body) => useCases.supersedeCard(ctx.account!, courseId(ctx.pathParams.courseId!), body as SupersedeCardRequest),
},
```

(the two GET routes keep `auth: "none"` with their comment updated to cite the spec). In `errorMapping.ts`: add `"card-superseded": 409`, `"unknown-tee-id": 400`, `"duplicate-tee-id": 400`, `"mismatched-hole-count": 400`; DELETE `"tee-set-revised"` and `"course-conflict"` (both codes no longer exist anywhere — grep to confirm before deleting). In `compositionRoot.ts`: `const cardStore = tableCore !== undefined ? createDynamoCardStore({...}) : unavailableCardStore();` (reshape the unavailable stub to the four new methods), wire `createCourse({ cardStore, golferStore, idGenerator: ids, clock, logger })`, `supersedeCard({ ...same })`, `getCourse({ cardStore })`, `searchCourses({ cardStore })`; delete the old courseStore wiring. Update lambda's route/dispatch tests for the new table (there is a routes/dispatch test file — grep `verifyTeeSet` under `packages/lambda` and update every hit; the route-table test's expected route list loses 2 entries and gains the PUT).

- [ ] **Step 7: web api.ts.** `createCourse` gains a token (copy `createRound`'s exact authenticated-request idiom in this same file); add `supersedeCard`; delete `addTeeSet`:

```ts
export const createCourse = async (input: CreateCourseRequest, token: string): Promise<CreateCourseResponse> => { /* createRound's idiom, POST /courses */ };
export const supersedeCard = async (courseId: CourseId, input: SupersedeCardRequest, token: string): Promise<SupersedeCardResponse> => { /* PUT /courses/{courseId} */ };
```

- [ ] **Step 8: web pages — compile-correct adaptation** (the UX rework is T6; this step only tracks the new shapes):
  - `CourseSummaryCard.tsx`: `courseData.name` → `courseData.card.courseName`; the per-tee metadata `<ul>` (which read `courseData.teeSets`) becomes one attribution line: `<p className="text-sm text-slate-400">entered by {courseData.enteredBy} · updated {new Date(courseData.updatedAtMs).toLocaleDateString()}</p>`; DELETE the "Edit this card" `Link` (EditCoursePage is deleted this task; T6 restores editing from the new CoursePage). Update its test fixture to the new `CourseView` shape.
  - `CreateRoundPage.tsx`: still sends `card: courseView.card` this task (T5 switches the wire) — only fix any type fallout from the view reshape (`courseView.card` still exists; nothing else read `view.name`).
  - `AddCoursePage.tsx`: delete the "Your name" field + `enteredBy` state + auto-fill effect; gate the page on sign-in (`if (!auth.signedIn) return <SignInCta message="Sign in to add a course." returnTo="/courses/new" />;` — copy CreateRoundPage's exact CTA usage); submit becomes `await auth.withAuth((token) => createCourse({ name: name.trim(), teeSets: [{ name: teeName.trim(), rating: parsedRating, slope: parsedSlope, holes: parsedHoles }] }, token))`; navigation unchanged (`/create` with `courseId` state — T6 repoints it). `canSubmit` drops the enteredBy clause. Update its test (no name field; mock auth signed-in — copy the idiom from CreateRoundPage's test).
  - `CourseSearch.tsx`: render `{course.name} · {course.holeCount} holes` in the result button (the search response now carries holeCount).
  - `ProfilePage.tsx`: `getCourse` still returns `{course}` — its `name` read becomes `response.course.card.courseName` (find the `setHomeCourse` call around line 126).
  - DELETE `EditCoursePage.tsx` + `EditCoursePage.test.tsx`; remove its import + route from `App.tsx` (T6 recreates both).
- [ ] **Step 9: web e2e helper.** In `apps/web/e2e/support.ts`, `ensureCourse` seeds via the authenticated new wire and returns both ids (every caller updates in T5; this task keeps its signature source-compatible by returning an object):

```ts
export const ensureCourse = async (name: string, card: CourseCard, account: AccountGolfer): Promise<{ courseId: CourseId; cardId: string }> => {
  // search (unchanged normalization) → exact-name hit → GET /courses/{id} for the cardId;
  // miss → POST /courses { name, teeSets: card.teeSets } with the account's Bearer.
};
```

Implement with the file's existing raw-fetch idiom (`parse(createCourseResponseSchema, …)`); strip `teeId`/`source` from `card.teeSets` before POSTing (`createCourseRequestSchema` is `.strict()`; fixture cards have neither, so a plain map of `{name, rating, slope, holes}` is enough). Update every `ensureCourse(...)` call site across `fieldTest/killNetwork/primaryPath/courseEntry` specs to pass an already-minted account and destructure the result — the round-creation calls themselves still compile (startRoundDirect unchanged until T5).

- [ ] **Step 10: delete the old model.** From `packages/domain/src/course/course.ts` delete `TeeSetVersion`, `Course`, `createCourse`, `addTeeSet`, `verifyTeeSet`, `courseCardOf` and their tests (keep `Provenance`, `courseNameKey`, the validators, and all T1 additions). Delete `packages/adapters-dynamodb/src/createDynamoCourseStore.ts` + `contract/courseStore.contract.test.ts` + the `courseSk` export in keys.ts + the index.ts export. Grep the workspace for `courseCardOf|TeeSetVersion|addTeeSet|verifyTeeSet|tee-set-revised|course-conflict` — zero hits outside docs/specs when done.

- [ ] **Step 11: Validate + commit.** `pnpm validate` → green; `pnpm test:contract` → green (old course suite gone, card suite passes). ONE commit: `feat(courses)!: the course wire is card lineages — authenticated whole-card supersession, verify deleted, M6 aggregate deleted`.

---

### Task 5: StartRound becomes a reference command

**Files:**
- Modify: `packages/contracts/src/commands.ts`, `packages/application/src/rounds/startRound.ts` + its test file, `packages/lambda/src/compositionRoot.ts` (+ lambda tests touching startRound bodies), `apps/web/src/routes/CreateRoundPage.tsx` + test, `apps/web/e2e/support.ts` + every spec calling `startRoundDirect`, `e2e/support/client.ts` + root-e2e specs that build round-creation bodies

**Interfaces (Produces):** `StartRoundRequest = { course: { courseId, cardId }, host: { tee, courseHandicap } }`; `startRound` deps gain `cardStore: CardStore`; new wire error `card-superseded` (409) and `course-not-found` (404) on POST /rounds.

- [ ] **Step 1: contracts.** In `commands.ts` replace `startRoundRequestSchema`:

```ts
// Course-cards spec §4: a REFERENCE, never a card — the server resolves and freezes the
// lineage's current card itself (spec invariant 4/5: the client can never author a card; the
// old `card:` shape is gone, not tolerated — an old client gets 400 invalid-request).
export const startRoundRequestSchema = z.object({
  course: z.object({ courseId: courseIdSchema, cardId: cardIdSchema }),
  host: z.object({
    tee: z.string().min(1),
    courseHandicap: z.number().int(), // may be negative (plus handicap)
  }),
});
```

(import `cardIdSchema`/`courseIdSchema` from `./ids.js` — courseIdSchema may already be imported).

- [ ] **Step 2: failing tests.** In startRound's existing test file (find it beside the use case; it stubs journal/store/etc.) add a fake `cardStore` and three cases: (a) happy path freezes `record.card` VERBATIM into round-created (`expect(appendedEvents[0]).toMatchObject({ kind: "round-created", card: record.card })` and `expect(appended.card).toBe(record.card)` — same reference, the no-translation invariant); (b) `cardId` not current → rejects `ApplicationError` code `card-superseded`, nothing appended; (c) unknown courseId → `course-not-found`. Run → FAIL.

- [ ] **Step 3: implement.** In `startRound.ts`: deps gain `cardStore: CardStore`; replace the first line of the body:

```ts
// Course-cards spec §4: resolve the reference, insist on currency, freeze VERBATIM.
const record = await deps.cardStore.getCurrent(command.course.courseId);
if (!record) throw new ApplicationError("course-not-found");
if (record.cardId !== command.course.cardId) {
  throw new ApplicationError("card-superseded", `course ${command.course.courseId}: current card is ${record.cardId}`);
}
findTeeSet(record.card, command.host.tee); // unknown-tee-set (DomainError) propagates
```

then `card: record.card` in the round-created event and `record.card.courseName` in the `writePresence` call. Import `ApplicationError` from `../errors.js` and `CardStore` from the port. Run tests → PASS.

- [ ] **Step 4: composition + lambda tests.** `startRound({ ..., cardStore })` in compositionRoot. Grep `packages/lambda` tests for `card:` request bodies and update to the reference shape (mint via whatever fake stores those tests use).

- [ ] **Step 5: web.** `CreateRoundPage.tsx` submit:

```ts
const response: StartRoundResponse = await auth.withAuth((token) =>
  createRound({ course: { courseId: courseView.courseId, cardId: courseView.cardId }, host: { tee, courseHandicap: parsedHandicap } }, token),
);
```

and in the catch, before the generic message:

```ts
if (caught instanceof ApiError && caught.code === "card-superseded") {
  selectCourse(courseView.courseId); // re-fetch the now-current card (tee re-seeds via selectCourse)
  setError("This card was just updated — review the numbers before starting.");
  setSubmitting(false);
  return;
}
```

Update the page's test: the submit assertion's request body, plus one new test stubbing a `card-superseded` rejection and asserting the notice renders and `getCourse` was re-called. (`courseView.cardId` needs `cardId` in scope — it's on the new CourseView.)

- [ ] **Step 6: web e2e.** `support.ts`'s `startRoundDirect` input becomes `{ course: { courseId: CourseId; cardId: string }; tee: string; courseHandicap: number }`, body passed through verbatim. Update ALL call sites: `crewSeason.spec.ts` (seed once via `ensureCourse(courseName, card, al)` before the deck loop, pass the reference into every `startRoundDirect` — deck DATA untouched, standings stay byte-identical), `identityRecord.spec.ts` (seed once, thread the reference through `playRecordRound`), `shareLink.spec.ts`, `killNetwork.spec.ts`, `fieldTest.spec.ts` (its `ensureCourse` call already returns the reference from T4 — pass an account too). `primaryPath.spec.ts` uses the browser UI for creation — only its `ensureCourse` call gains the account argument.

- [ ] **Step 7: root e2e.** `e2e/support/client.ts` + `roundSlice.e2e.test.ts`/`syncSession.e2e.test.ts`: find where round-creation bodies are built (grep `"/rounds"` and `card`), add a course-seeding helper against the deployed API (authenticated — the root harness already mints Cognito users via `USER_PASSWORD_AUTH`), and pass the reference. Root e2e runs against beta only (`pnpm e2e:beta`), so the implementer verifies typecheck/lint here, not live behavior.

- [ ] **Step 8: Validate + commit.** `pnpm validate` → green. Commit: `feat(rounds)!: StartRound is a reference command — the server resolves and freezes the current card`.

---

### Task 6: The Courses surface — CoursePage + the whole-card editor

**Files:**
- Create: `apps/web/src/courses/CoursePage.tsx` + `CoursePage.test.tsx`
- Create: `apps/web/src/courses/EditCoursePage.tsx` + `EditCoursePage.test.tsx` (new implementation)
- Modify: `apps/web/src/App.tsx`, `apps/web/src/courses/AddCoursePage.tsx` (+ test), `apps/web/src/courses/CourseSummaryCard.tsx`

**Interfaces (Consumes):** T4's `getCourse`/`supersedeCard` api fns and `CourseView` shape.

- [ ] **Step 1: CoursePage.** New route `/courses/:courseId` — the hub (spec §7). Structure (follow EditCoursePage's old load/guard idiom for the param + fetch + error/loading states):
  - loads `getCourse(id)` on mount; state `{view, loadError}`.
  - renders: `<h1>{view.card.courseName}</h1>`; attribution `entered by {view.enteredBy} · updated {date}`; a tee `<select>` (same idiom as CourseSummaryCard) + a read-only hole table for the selected tee (three columns — hole/par/SI, plus yardage; a plain `<table>` with `text-sm`, no new abstraction); actions:

```tsx
<Link to="/create" state={{ courseId: view.courseId }} className="rounded-lg bg-emerald-600 px-4 py-3 text-center text-lg font-semibold">
  Start a round here
</Link>
<Link to={`/courses/${view.courseId}/edit`} className="text-emerald-400 underline">Edit this card</Link>
<Link to={`/courses/${view.courseId}/edit`} state={{ addTee: true }} className="text-emerald-400 underline">Add a tee</Link>
```

  - Test: renders name/attribution/tees from a stubbed `getCourse`; "Start a round here" link carries the courseId state; both edit links present.
- [ ] **Step 2: EditCoursePage (new).** Single-tee editing UX over the whole-card wire (the mobile-honest reading of spec §7 — one column fits a phone; the SUBMISSION is always the entire card):
  - Load `getCourse(id)`; hold `view`. Mode from router state: `{ addTee?: boolean }` — addTee mode starts a blank tee column (name/rating/slope empty, `defaultHoles(view.card.teeSets[0].holes.length)` — the card's own hole count, count toggle NOT rendered on an existing card, pinning `mismatched-hole-count` structurally); edit mode pre-fills the selected tee exactly as the old page did (tee picker instead of router-state teeName), keeping its `teeId`.
  - Course name is editable (a rename is just part of the new card): an input seeded from `view.card.courseName`.
  - Submit builds THE WHOLE CARD: every non-edited tee passed through verbatim from `view.card.teeSets` as `{teeId, name, rating, slope, holes}`; the edited tee replaces its original (same `teeId`, possibly new name — a tee rename); an added tee appends id-less. Then:

```ts
const response = await auth.withAuth((token) =>
  supersedeCard(id, { name: name.trim(), teeSets, supersedes: view.cardId }, token),
);
navigate(`/courses/${id}`);
```

  - 409 handling (the spec's idiom): `if (caught instanceof ApiError && caught.code === "card-superseded")` → re-fetch `getCourse`, replace `view` (and re-seed the form from the fresh card), show `"This card was just updated — review the new numbers."`. Keep the old page's FIELD_FOR_CODE inline-error mapping (add `duplicate-tee-name` → teeName).
  - Sign-in gate like AddCoursePage. The amber verification-reset warning line is DELETED (nothing to reset anymore).
  - Tests: (a) edit mode pre-fills and submits the whole card with the edited tee's `teeId` preserved and `supersedes` = loaded cardId (assert the exact request body via the mocked api fn); (b) addTee mode submits original tees verbatim + one id-less new tee; (c) 409 → re-fetch + notice.
- [ ] **Step 3: AddCoursePage lands on the course page.** `navigate(`/courses/${response.course.courseId}`)` (drop the `/create` state hand-off). Update its test's navigation assertion.
- [ ] **Step 4: CourseSummaryCard links to the hub.** Add beside "Change course": `<Link to={`/courses/${course.courseId}`} className="text-sm text-emerald-400 underline">View course</Link>` (the create-flow's path to maintenance now that the edit link lives on CoursePage).
- [ ] **Step 5: App.tsx.** Add `<Route path="/courses/:courseId" element={<CoursePage />} />` and restore `<Route path="/courses/:courseId/edit" element={<EditCoursePage />} />` (static `/courses/new` stays above them; react-router ranks static first regardless).
- [ ] **Step 6:** `pnpm -F @swng/web test` → PASS; `pnpm validate` → green. Commit: `feat(web): the Courses surface — course page hub, whole-card editor, add-a-tee exists at last`.

---

### Task 7: The history line records courseId

**Files:**
- Modify: `packages/domain/src/golfer/record.ts` + its test, `packages/contracts/src/golfers.ts`, `packages/adapters-dynamodb/src/contract/projectionStore.contract.test.ts`

- [ ] **Step 1:** `GolferRoundLine` gains `readonly courseId?: CourseId;` (import the type). In `archiveGolferLine`'s return, add `...(archive.card.source ? { courseId: archive.card.source.courseId } : {}),` after `courseName`. Comment: `// spec §4: recorded from day one because it cannot be backfilled; absent on pre-scrap archives.`
- [ ] **Step 2:** Domain test: fold a fixture archive whose card carries `source` → line has the courseId; without `source` → field absent. (Extend the existing archiveGolferLine tests' fixture builder.)
- [ ] **Step 3:** `contracts/golfers.ts`: add `courseId: courseIdSchema.optional()` to `golferRoundLineFields` (import from `./ids.js`) — `/me/record` history and `/me/rounds` pick it up automatically.
- [ ] **Step 4:** Projection contract test: extend the existing putLine/listLines round-trip case with a line carrying `courseId` and assert it survives (the store persists the line object whole; this pins that no field-list drops it).
- [ ] **Step 5:** `pnpm validate` → green; `pnpm test:contract` → green. Commit: `feat(golfers): history lines record courseId — the analytics join key, from day one`.

---

### Task 8: Infra route tables

**Files:**
- Modify: `apps/infra-cdk/lib/swngStack.ts`, `apps/infra-cdk/test/swngStack.test.ts`

- [ ] **Step 1:** In `HTTP_ROUTES` (~line 82): delete `POST /courses/{courseId}/tees` and `POST /courses/{courseId}/verify`; add `{ method: HttpMethod.PUT, path: "/courses/{courseId}" }` beside the GET. In `ANON_THROTTLED_ROUTES` (~line 148): delete all three POST course entries (writes are golfer-gated now — spec §4); the two GET course entries stay. Set count 9 → 6.
- [ ] **Step 2:** Stack tests: route list expectation loses/gains the same entries; titles and counts: "thirty-seven" → "thirty-six" (with a `− tees/verify + PUT courses from course-cards` note in the title, matching the file's convention), 39 total → 38, "all 9 tightened routes" → "all 6". The self-checking membership test (`every ANON route is a real HTTP_ROUTE`) needs no change — it's the pin that catches a typo here.
- [ ] **Step 3:** `pnpm -F @swng/infra-cdk test` (or the package's actual name — check `apps/infra-cdk/package.json`) → PASS; `pnpm validate` → green. Commit: `feat(infra): 36 HTTP routes — course writes leave the anonymous throttle set`. (Nothing stateful; RouteSettings shrinkage is deploy-safe, and the stage already DependsOn every route.)

---

### Task 9: courseEntry.spec.ts — the gate, rewritten for the new surface

**Files:**
- Modify: `apps/web/e2e/courseEntry.spec.ts`

- [ ] **Step 1:** Preserve VERBATIM: the `CASA_VERDE_HOLES` table (it IS the gate — hand-verified; do not retype a digit), the dots-assertion helpers, the singles-match hole-by-hole checks, the `DOT` glyph, `isModalPar`. Rewrite the FLOW:
  1. Pat (signed-in account, tokens injected) opens `/create`, searches the per-run course name → "No courses found" → "Add a course".
  2. AddCoursePage: NO "Your name" field (assert `getByLabel("Your name")` count 0 — the wall against wire-supplied attribution); fill name/tee ("white")/rating 71.1/slope 129; keyboard-first grid fill exactly as today.
  3. Submit lands on `/courses/{id}` (the new hub): assert the course name heading, `entered by` attribution, and the hole table shows hole 1's own par/SI from the table.
  4. NEW COVERAGE — "Add a tee": tap it, fill "blue" / 73.0 / 133, grid (reuse the same fill helper; par values may be identical to white's — dots are asserted on white), save; back on the course page assert BOTH tees in the tee select.
  5. "Start a round here" → CreateRoundPage preselected → create the round as Pat on white; Quinn joins via `joinRoundDirect` exactly as today.
  6. Dots + singles-match assertions: UNCHANGED, hole by hole.
- [ ] **Step 2:** `pnpm validate` (typecheck/lint — the spec runs live only under `pnpm e2e:field`, controller-run). Commit: `test(e2e): courseEntry drives the new Courses surface — entry, add-a-tee, round, dots unchanged`.

---

### Task 10: The scrap script

**Files:**
- Create: `scripts/scrapCourseAndRoundData.mjs`

- [ ] **Step 1:** Template on `scripts/dropCrewData.mjs` verbatim (createRequire header, `--stage`/`--dry-run` args, per-table counters). Read the four table names from `apps/infra-cdk/lib/swngStack.ts` (grep `tableName:`) and hardcode the stage-templated strings the same way dropCrewData hardcodes `swng-core-${stage}`. Behavior (spec §9, owner amendment):
  - **core table**: delete every item whose `pk` begins with `COURSE#` (legacy single-doc courses AND new-model items — full reset before Casa Verde re-entry); additionally, for every `GOLFER#`/`sk=GOLFER` item carrying a `homeCourseId` attribute, `UpdateCommand REMOVE homeCourseId` (a wiped course must not dangle from profiles). Everything else on core (golfers, SUB# pointers, crews) is untouched.
  - **rounds table**: delete ALL items (the table holds only round journals/META/OPID).
  - **snapshots table**: delete ALL items (Key is `{pk}` only — no sk).
  - **projections table**: delete ALL items (ROUND# lines, LIVE# presence, dead INDEX rows).
  - Print per-table deleted/kept counts; `--dry-run` prints without deleting. Note in the header comment: crews' counted-round references will dangle against wiped snapshots — beta crews are e2e leftovers; the controller may re-run `dropCrewData.mjs` at their discretion.
- [ ] **Step 2:** `node --check scripts/scrapCourseAndRoundData.mjs` + `pnpm lint` → clean. **Do NOT run it** — controller-run at deploy, after `--dry-run` review. Commit: `chore(scripts): the beta scrap — courses, rounds, snapshots, projections; no legacy tier ever`.

---

## Self-review checklist (performed while writing)

- **Spec coverage:** §3 model → T1; §4 wire/routes → T4/T5/T8; §5 storage → T3; §6 concurrency → T3/T4/T5; §7 web → T2/T4/T6; §8 verify deletion → T2/T4; §9 rollout → T10 + controller close-out; §4 history-line → T7; invariants 1–9 each pinned by a named test (write-once: T3 supersede test; verbatim freeze: T5 `toBe` reference test; continuity: T1+T4 tests; same-hole-count: T1 + T6's structural no-toggle; auth-derived enteredBy: T4 schema `.strict()` + T9's no-name-field assertion).
- **Green-per-commit:** T1/T3 additive; T2 before T4 (consumer-first); T4/T5 update every in-repo consumer inside the task; EditCoursePage deleted in T4 and recreated in T6 (no red window — route and imports removed with it).
- **Type consistency:** `CardStore` methods (`create/supersede/getCurrent/search`) used identically in T3/T4/T5; `CourseView {courseId, cardId, card, enteredBy, updatedAtMs}` consistent across T4 steps 3/7/8 and T6; `ensureCourse(name, card, account) → {courseId, cardId}` consistent T4 step 9 / T5 step 6.
