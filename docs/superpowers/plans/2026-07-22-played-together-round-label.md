# "Played together" canonical round label — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** The crew "Played together" list renders each shared round as the canonical
`roundLabel` ("Casa Verde GC · Sat, Jul 12"), a whole-row link, instead of a bare
`toLocaleDateString`.

**Architecture:** Extract the in-list day-collision helper (today inline in `HomePage`) into
`roundLabel.ts` as `dayCollisionChecker` and reuse it in both `HomePage` and `SeasonPanel`; grow
`SharedRoundView` on the wire with the `courseName` (required) + `createdAt?` (optional) that
`roundLabel` needs — populated server-side in `getSeasonStandings` from the same member line it
already reads for `finalizedAt` (no new lookup); render `roundLabel` in `SeasonPanel`. Spec
(binding): `docs/superpowers/specs/2026-07-22-played-together-round-label-design.md`.

**Tech Stack:** TypeScript ESM monorepo; `@swng/contracts` (Zod), `@swng/application`,
`apps/web` (React 19); Vitest.

## Global Constraints

- `pnpm validate` green at EVERY commit; local `main`, never push. Prefix node tooling with
  `env -u NODE_OPTIONS` (sandbox `NODE_OPTIONS` references a missing preload file).
- Canonical designation is `roundLabel({ courseName, createdAt? }, { withTime })` from
  `apps/web/src/roundLabel.ts`, LOCAL zone (omit `timeZone` — the product default). Never
  `new Date(...).toLocaleDateString()` for a round.
- The day-collision rule (append the tee time iff a round shares course+day with ANOTHER in the
  SAME list) is ONE shared helper, `dayCollisionChecker`, computed over exactly the rounds being
  listed. `HomePage`'s behavior must not change (its collision beats stay green).
- Wire growth is ADDITIVE but `courseName` is REQUIRED → **deploy LAMBDA-FIRST**. No migration,
  no wipe (compute-on-read from `GolferRoundLine`s already stored; `createdAt?` tolerates absent).
- This is presentation + additive-wire only: no crew fold, no season model, no route change. The
  frozen-deck numbers in `crewSeason.spec` do not move.
- `roundLabel`/`roundDayKey`/collision are presentation (dates), NOT golf compute — not on the
  ESLint compute fence.

---

### Task 1: Extract `dayCollisionChecker` into `roundLabel.ts`; reuse in `HomePage`

**Files:**
- Modify: `apps/web/src/roundLabel.ts` (add `dayCollisionChecker`)
- Test: `apps/web/src/roundLabel.test.ts`
- Modify: `apps/web/src/routes/HomePage.tsx` (replace the inline `dayKeyCounts`/`collidesOnDay`
  with the shared helper)

**Interfaces:**
- Consumes: existing `roundDayKey(designation, { timeZone? })` and `RoundDesignation` from
  `roundLabel.ts`.
- Produces: `dayCollisionChecker(rounds: readonly RoundDesignation[], opts?: { timeZone?: string }):
  (round: RoundDesignation) => boolean` — used by Task 3.

- [ ] **Step 1: Write the failing test** — append to `apps/web/src/roundLabel.test.ts`:

```ts
describe("dayCollisionChecker — in-list same-course-same-day flagging", () => {
  const casaMorning = { courseName: "Casa Verde GC", createdAt: Date.UTC(2025, 6, 12, 7, 58) };
  const casaAfternoon = { courseName: "Casa Verde GC", createdAt: Date.UTC(2025, 6, 12, 15, 30) };
  const casaNextDay = { courseName: "Casa Verde GC", createdAt: Date.UTC(2025, 6, 13, 7, 58) };
  const pebble = { courseName: "Pebble Beach", createdAt: Date.UTC(2025, 6, 12, 7, 58) };
  const noDate = { courseName: "Casa Verde GC" };

  it("flags both rounds that share course AND day", () => {
    const collides = dayCollisionChecker([casaMorning, casaAfternoon], { timeZone: "UTC" });
    expect(collides(casaMorning)).toBe(true);
    expect(collides(casaAfternoon)).toBe(true);
  });

  it("flags neither when the day differs", () => {
    const collides = dayCollisionChecker([casaMorning, casaNextDay], { timeZone: "UTC" });
    expect(collides(casaMorning)).toBe(false);
    expect(collides(casaNextDay)).toBe(false);
  });

  it("flags neither when the course differs", () => {
    const collides = dayCollisionChecker([casaMorning, pebble], { timeZone: "UTC" });
    expect(collides(casaMorning)).toBe(false);
    expect(collides(pebble)).toBe(false);
  });

  it("a round with no createdAt never collides", () => {
    const collides = dayCollisionChecker([noDate, { courseName: "Casa Verde GC" }], { timeZone: "UTC" });
    expect(collides(noDate)).toBe(false);
  });

  it("defaults to the local zone (matches an explicit local timeZone)", () => {
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const a = { courseName: "X", createdAt: Date.UTC(2025, 6, 12, 12, 0) };
    const b = { courseName: "X", createdAt: Date.UTC(2025, 6, 12, 13, 0) };
    expect(dayCollisionChecker([a, b])(a)).toBe(dayCollisionChecker([a, b], { timeZone: localZone })(a));
  });
});
```

Add `dayCollisionChecker` to the existing import in `roundLabel.test.ts`
(`import { dayCollisionChecker, roundDayKey, roundLabel } from "./roundLabel";`).

- [ ] **Step 2: Run it, verify it fails** — `env -u NODE_OPTIONS pnpm -F @swng/web exec vitest run src/roundLabel.test.ts` → FAIL (`dayCollisionChecker` not exported).

- [ ] **Step 3: Implement** — append to `apps/web/src/roundLabel.ts` (after `roundDayKey`):

```ts
// A predicate over a list: true for a designation that shares course+day with ANOTHER in the
// same list (so its roundLabel should render withTime to disambiguate — the "two indistinguishable
// Walker rounds" bug). Local-zone by default, same basis as roundLabel/roundDayKey; a designation
// with no createdAt has no day and never collides. The ONE canonical in-list collision helper —
// HomePage and the crew "Played together" list both use it (spec 2026-07-22 §4).
export const dayCollisionChecker = (rounds: readonly RoundDesignation[], { timeZone }: RoundDayKeyOptions = {}): ((round: RoundDesignation) => boolean) => {
  const counts = new Map<string, number>();
  for (const round of rounds) {
    const key = roundDayKey(round, { timeZone });
    if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (round) => {
    const key = roundDayKey(round, { timeZone });
    return key !== undefined && (counts.get(key) ?? 0) > 1;
  };
};
```

- [ ] **Step 4: Run the test, verify it passes** — same command → PASS.

- [ ] **Step 5: Refactor `HomePage` to the shared helper** — in `apps/web/src/routes/HomePage.tsx`:
  add `dayCollisionChecker` to the `roundLabel` import (`import { dayCollisionChecker, roundDayKey, roundLabel } from "../roundLabel";` — `roundDayKey` may become unused; drop it from the import if so). Replace the inline block (the `// The canonical designation …` comment, the `dayKeyCounts` map, and the `collidesOnDay` arrow — currently lines ~115–127) with:

```tsx
  // The canonical designation (spec §5): course + date, tee time appended only to disambiguate two
  // rounds that share course and day, computed across exactly the rounds this list renders — the
  // ONE shared dayCollisionChecker (spec 2026-07-22 §4).
  const collidesOnDay = dayCollisionChecker(liveRounds ?? []);
```

Leave the `roundLabel(..., { withTime: collidesOnDay(round) })` call at line ~217 unchanged.

- [ ] **Step 6: Full validate** — `env -u NODE_OPTIONS pnpm validate` exit 0 (HomePage's own collision beats in `HomePage.test.tsx` stay green — proof the extraction is behavior-preserving).

- [ ] **Step 7: Commit** — `refactor(web): one shared dayCollisionChecker for the canonical round-list label`

---

### Task 2: Wire + server — `SharedRoundView` gains `courseName`/`createdAt`, populated by `getSeasonStandings`

**Files:**
- Modify: `packages/contracts/src/crews.ts` (`SharedRoundView` + `sharedRoundViewSchema`)
- Test: `packages/contracts/src/crews.test.ts`
- Modify: `packages/application/src/crews/getSeasonStandings.ts`
- Test: the existing `getSeasonStandings` coverage in
  `packages/application/src/crews/seasonSlice.test.ts` (add course/created assertions)

**Interfaces:**
- Produces: `SharedRoundView = { roundId, finalizedAt, courseName, createdAt? }` — consumed by Task 3.

This is ONE atomic commit: adding the REQUIRED `courseName` to the schema without populating it in
`getSeasonStandings` would fail `tsc` (the response builder omits it), so schema + server land
together to keep validate green.

- [ ] **Step 1: Contract test (failing)** — in `packages/contracts/src/crews.test.ts`, extend the
  `sharedRoundViewSchema`/`seasonStandingsResponseSchema` coverage:

```ts
it("sharedRoundViewSchema round-trips courseName and an optional createdAt", () => {
  const withDate = { roundId: "r1", finalizedAt: 1_700_000_000_000, courseName: "Casa Verde GC", createdAt: 1_699_000_000_000 };
  expect(sharedRoundViewSchema.parse(withDate)).toEqual(withDate);
  const noDate = { roundId: "r2", finalizedAt: 1_700_000_000_000, courseName: "Casa Verde GC" };
  expect(sharedRoundViewSchema.parse(noDate)).toEqual(noDate);
});

it("sharedRoundViewSchema rejects a missing courseName", () => {
  expect(() => sharedRoundViewSchema.parse({ roundId: "r1", finalizedAt: 1, createdAt: 1 })).toThrow();
});
```

If `sharedRoundViewSchema` is not already exported from `crews.ts`, export it (it is a module-local
`const` today — add `export` so the test can import it; harmless, it is a schema).

- [ ] **Step 2: Run it, verify it fails** — `env -u NODE_OPTIONS pnpm -F @swng/contracts exec vitest run src/crews.test.ts` → FAIL.

- [ ] **Step 3: Grow the wire** — in `packages/contracts/src/crews.ts`, replace the
  `SharedRoundView` interface + schema:

```ts
export interface SharedRoundView {
  readonly roundId: RoundId;
  readonly finalizedAt: number;
  // The canonical round designation's inputs (spec 2026-07-22 §3): courseName is REQUIRED (it is
  // required on GolferRoundLine, the line this is derived from); createdAt is OPTIONAL, matching
  // the golfer-record history line — a pre-createdAtMs line renders as its bare course name.
  readonly courseName: string;
  readonly createdAt?: number;
}
export const sharedRoundViewSchema: z.ZodType<SharedRoundView> = z.object({
  roundId: roundIdSchema,
  finalizedAt: z.number().int(),
  courseName: z.string(),
  createdAt: z.number().int().optional(),
});
```

- [ ] **Step 4: Server populates them** — in `packages/application/src/crews/getSeasonStandings.ts`,
  replace the `finalizedByRound` map + `rounds` build (the three lines under the "Shared rounds
  newest-first" comment) with a line-keyed map so the same authoritative holder line yields all
  three facts:

```ts
    // Shared rounds newest-first by finalizedAtMs; any holder's line is authoritative for a given
    // roundId (a round finalizes once — same finalizedAt, frozen courseName, createdAt on every
    // participant's line), so the first holder found supplies the canonical designation (spec §3).
    const lineByRound = new Map<RoundId, (typeof members)[number]["lines"][number]>();
    for (const { lines } of members) for (const line of lines) if (!lineByRound.has(line.roundId)) lineByRound.set(line.roundId, line);
    const rounds = shared
      .map((roundId) => {
        const line = lineByRound.get(roundId)!;
        return { roundId, finalizedAt: line.finalizedAtMs, courseName: line.courseName, createdAt: line.createdAtMs };
      })
      .sort((a, b) => b.finalizedAt - a.finalizedAt);
```

- [ ] **Step 5: Slice test** — in the existing `getSeasonStandings` describe in
  `seasonSlice.test.ts`, extend the shared-round assertion (test 8's analogue, where ≥2 members
  share a round) to assert the returned `rounds[0]` carries the member line's `courseName` and its
  `createdAt` (`createdAtMs`). If the fixture lines lack `courseName`/`createdAtMs`, add them (the
  fixture builds `StoredLine`s — set a `courseName` and a `createdAtMs`).

- [ ] **Step 6: Full validate + contract tests** — `env -u NODE_OPTIONS pnpm validate` exit 0;
  `env -u NODE_OPTIONS pnpm test:contract` NOT required (no `adapters-dynamodb` change).

- [ ] **Step 7: Commit** — `feat(crews): shared rounds carry courseName + createdAt for the canonical label`

---

### Task 3: `SeasonPanel` renders the canonical `roundLabel`

**Files:**
- Modify: `apps/web/src/crews/SeasonPanel.tsx`
- Test: `apps/web/src/crews/SeasonPanel.test.tsx`

**Interfaces:**
- Consumes: `roundLabel` + `dayCollisionChecker` (Task 1) from `../roundLabel`; the wire fields
  `round.courseName`/`round.createdAt` (Task 2).

- [ ] **Step 1: Failing unit test** — add to `apps/web/src/crews/SeasonPanel.test.tsx` a render
  where `standings.rounds` has two shared rounds, one pair same-course-same-day:

```ts
it("Played together renders each round's canonical label, whole-row link, with the tee time only on a same-day collision", async () => {
  signInAsAnn();
  const day = Date.UTC(2026, 6, 12, 14, 0);
  mockedGetSeasonStandings.mockResolvedValue({
    ...baseStandings,
    rounds: [
      { roundId: roundId("r-morning"), finalizedAt: day + 1, courseName: "Casa Verde GC", createdAt: Date.UTC(2026, 6, 12, 8, 0) },
      { roundId: roundId("r-afternoon"), finalizedAt: day + 2, courseName: "Casa Verde GC", createdAt: Date.UTC(2026, 6, 12, 15, 0) },
    ],
  });
  renderPanel();
  // Same course + day → both carry the tee time (withTime); links point at /rounds/:id.
  const links = await screen.findAllByRole("link", { name: /Casa Verde GC · /i });
  expect(links).toHaveLength(2);
  expect(links.map((l) => l.getAttribute("href"))).toEqual(["/rounds/r-morning", "/rounds/r-afternoon"]);
  // No bare locale date anywhere in the section.
  expect(screen.queryByText(new Date(day + 1).toLocaleDateString())).toBeNull();
});
```

(Use the file's existing `roundId` import + `renderPanel`/`baseStandings`/`signInAsAnn` helpers;
match the exact `roundLabel` string via `roundLabel({...}, { withTime: true })` if the test asserts
full text — a regex on the course prefix as above is sufficient and zone-robust.)

- [ ] **Step 2: Run it, verify it fails** — `env -u NODE_OPTIONS pnpm -F @swng/web exec vitest run src/crews/SeasonPanel.test.tsx` → FAIL.

- [ ] **Step 3: Implement** — in `apps/web/src/crews/SeasonPanel.tsx`: import
  `roundLabel` + `dayCollisionChecker` from `../roundLabel`. Just before the `standings.rounds.map`
  (line ~356), compute `const roundCollidesOnDay = dayCollisionChecker(standings.rounds);`. Replace
  the row body:

```tsx
            {standings.rounds.map((round) => (
              <li key={round.roundId} className={`${cardBox} flex items-center justify-between gap-2 p-3`}>
                <Link to={`/rounds/${round.roundId}`} className="font-mono text-forest underline decoration-fairway">
                  {roundLabel({ courseName: round.courseName, createdAt: round.createdAt }, { withTime: roundCollidesOnDay(round) })}
                </Link>
              </li>
            ))}
```

- [ ] **Step 4: Run the test, verify it passes** — same command → PASS.

- [ ] **Step 5: Full validate** — `env -u NODE_OPTIONS pnpm validate` exit 0.

- [ ] **Step 6: Commit** — `feat(web): the crew "Played together" list renders the canonical roundLabel`

---

### Task 4: E2e — the "Played together" beat asserts the round's course name

**Files:**
- Modify: `apps/web/e2e/crewSeason.spec.ts`

**Interfaces:** consumes the live standings response (Task 2 server) + rendered panel (Task 3).

- [ ] **Step 1: Tighten the beat** — in the test where Bo joins and the shared round materializes
  (test 8, the "Played together" assertion), change the assertion from "a row exists under Played
  together" to asserting the row's link text CONTAINS the shared round's course name (the deck's
  course — "Casa Verde GC" or whatever `seasonGames`/the deck course resolves to; read it from the
  same course the deck rounds were played on). Assert the row is a link to `/rounds/{roundId}` for
  the known shared roundId. Do NOT touch any frozen-deck number (H2H, skins, Stableford, scoreboard
  literals stay byte-identical).

- [ ] **Step 2: Typecheck/lint the e2e workspace** — `env -u NODE_OPTIONS pnpm validate` exit 0
  (the live run is the controller's close-out, not this task).

- [ ] **Step 3: Commit** — `test(e2e): Played together asserts the shared round's canonical label`

---

### Close-out (controller-run — NOT a task)

`validate` → `deploy:beta` LAMBDA-FIRST (required `courseName` wire field) → `publish:web:beta` →
`e2e:beta` ×2 → `crewSeason` live ×2 → full `e2e:field` → a USE pass on beta.swng.golf: seed a crew
where two accounts share a finalized round, open the crew page, and confirm the "Played together"
row reads "‹course› · ‹date›" as a link (not a bare locale date) → docs sweep (CLAUDE.md close-out
record; the spec is self-contained). NO wipe.
