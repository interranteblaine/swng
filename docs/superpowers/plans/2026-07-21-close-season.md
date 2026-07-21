# Close Season Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** The organizer can close (and reopen) a season — the missing setter for the
already-load-bearing `CrewSeason.status`, activating the analytics arc's Stableford titles.

**Architecture:** Spec `docs/superpowers/specs/2026-07-21-close-season-design.md` (binding).
No stored-shape change; two verb routes flipping `status` via the existing `putSeason`;
titles remain a read fold. Web: organizer-only Close/Reopen + badge + teaching line.

**Tech Stack:** Existing monorepo layers (contracts/application/lambda/infra-cdk/web).

## Global Constraints

- `pnpm validate` green at EVERY commit. Single-file runs: `pnpm --filter <pkg> exec vitest run <file>`.
- No stored-shape change; nothing about a title is ever stored (analytics-arc law).
- Organizer guard = the EXISTING `removeCrewMember` idiom verbatim: load membership, `if (caller?.role !== "organizer") throw new ApplicationError("not-organizer")`.
- 409 codes wire-distinct and exact: `season-already-closed`, `season-not-closed`.
- Routes NOT anon-throttled; auth `golfer`; stack pins move 42→44 HTTP / 44→46 total (read the current pins — the analytics arc moved them to 42/44).
- Web: no new gold; `btnQuiet` verbs, `badge` for `closed`; closed seasons offer no count-a-round affordance; errors render the honest-fallback idiom.
- `crewSeason.spec.ts`: the FROZEN deck's numbers stay byte-identical. Test 9's provisional `titles: []` pin (its own comment names this arc) is the ONE sanctioned existing-assertion update — new expected titles hand-derived from the frozen deck BEFORE the live run.
- Work on local `main`; never push.

---

### Task 1: The verbs — contracts + application

**Files:**
- Modify: `packages/contracts/src/crews.ts` (two response types; reuse `crewSeasonViewSchema`)
- Modify: `packages/contracts/src/errors.ts` or wherever application error codes map to HTTP statuses (find the `ApplicationError` → status map; add both codes → 409)
- Create: `packages/application/src/crews/closeSeason.ts`, `reopenSeason.ts`
- Modify: `packages/application/src/index.ts` (export both)
- Test: `packages/application/src/crews/seasonSlice.test.ts` (extend)

**Interfaces:**
- Consumes: `CrewStore.{getSeason, putSeason}`, the membership loader `removeCrewMember.ts` uses, `AccountClaims`, `CrewSeasonView`.
- Produces (Task 2 routes these): `closeSeason(claims, crewId, seasonId): Promise<CloseSeasonResponse>` and `reopenSeason(...): Promise<ReopenSeasonResponse>`, each `{ season: CrewSeasonView }`.

- [ ] **Step 1: Failing slice tests** — organizer closes an open season → `getCrewRecords` titles appear (reuse the existing closed-season titles fixture arithmetic); reopen → titles `[]` again; close on closed → `ApplicationError("season-already-closed")`; reopen on open → `"season-not-closed"`; a non-organizer member → `"not-organizer"`; a non-member → the existing membership rejection; append-counted-round into a closed season still 409s end-to-end through the use case (the existing guard, now reachable).
- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** both use cases (mirror `removeCrewMember`'s load-and-guard shape):

```ts
export const closeSeason =
  (deps: { crewStore: CrewStore }) =>
  async (claims: AccountClaims, crewId: CrewId, seasonId: string): Promise<CloseSeasonResponse> => {
    const caller = await requireMemberRole(deps.crewStore, crewId, claims); // the removeCrewMember idiom — reuse its exact loader, do not invent a new one
    if (caller.role !== "organizer") throw new ApplicationError("not-organizer");
    const season = await deps.crewStore.getSeason(crewId, seasonId);
    if (!season) throw new ApplicationError("season-not-found"); // reuse the existing code appendCountedRound throws for a missing season
    if (season.status === "closed") throw new ApplicationError("season-already-closed");
    const closed = { ...season, status: "closed" as const };
    await deps.crewStore.putSeason(crewId, closed);
    return { season: viewOf(closed) }; // the createSeason response mapping, reused not redeclared
  };
```

`reopenSeason` is the mirror (`status !== "closed"` → `season-not-closed`; write `"open"`).
Whatever helper names the file actually has for membership-load and season→view mapping,
REUSE them (read `createSeason.ts`/`removeCrewMember.ts` first); if none exists exported,
extract the season→view mapper into one shared function rather than duplicating it.

- [ ] **Step 4: Contracts** — `closeSeasonResponseSchema`/`reopenSeasonResponseSchema` = `z.object({ season: crewSeasonViewSchema })` (the createSeason idiom); add both 409 codes to the error-code map with status 409.
- [ ] **Step 5: PASS + `pnpm validate`.** **Step 6: Commit** — `feat(contracts,application): the organizer closes a season — close/reopen verbs, titles go live`

---

### Task 2: Routes — dispatcher, composition root, CDK

**Files:**
- Modify: `packages/lambda/src/http/routes.ts` (+2), `packages/lambda/src/compositionRoot.ts`
- Modify: `apps/infra-cdk/lib/swngStack.ts` (+2 HTTP routes; NOT anon-throttled)
- Test: `packages/lambda/src/http/dispatch.test.ts`, stack tests (pins 42→44 HTTP / 44→46 total), routesParity stubs

**Interfaces:** consumes Task 1's use cases/schemas. Produces `POST /crews/{crewId}/seasons/{seasonId}/close` and `.../reopen`, auth `golfer`, 200.

- [ ] **Step 1:** Route entries — the crew-verb idiom (`POST /crews/{crewId}/transfer`) verbatim, both path params through their ctors (`crewId(...)`, seasonId as plain string per the existing season routes).
- [ ] **Step 2:** Composition wiring; dispatch tests: both routes exist, 401 bare, organizer 200 + non-organizer 403 through the REAL use case, 409 arms mapped.
- [ ] **Step 3:** CDK + pins + routesParity. **Step 4: `pnpm validate`.** **Step 5: Commit** — `feat(lambda,infra): close/reopen season routes (42→44 HTTP)`

---

### Task 3: Web — the organizer's verb, the badge, the closed door

**Files:**
- Modify: `apps/web/src/api.ts` (`closeSeason`, `reopenSeason` fetchers, schema-parsed)
- Modify: `apps/web/src/crews/CrewPage.tsx` and/or `SeasonPanel.tsx` (read where the season header + count-a-round affordance live — the verbs belong beside the season heading)
- Tests: the components' existing `.test.tsx` files (extend; per-file `afterEach(cleanup)`)

- [ ] **Step 1:** Organizer-only **Close season** (`btnQuiet`) beside the open season's heading, with a confirm step whose teaching line is EXACTLY: `Closing locks this season's counted rounds and awards its titles — you can reopen it later.` On success, refresh the season data through the existing reload path (api-then-refetch — no optimistic write). A closed season renders the `badge` `closed`, **Reopen** (`btnQuiet`) in place of Close, and does NOT render the count-a-round affordance. Non-organizers: badge only, no verbs. Failure: the honest fallback line idiom (`Could not update the season — try again.`).
- [ ] **Step 2:** Tests — organizer open-season (Close + teaching line, no badge), organizer closed-season (badge + Reopen, no count affordance), non-organizer closed (badge only), error path. Run files + `pnpm validate`.
- [ ] **Step 3: Commit** — `feat(web): close season — the verb, the badge, the closed door`

---

### Task 4: E2E — titles go live against the frozen deck

**Files:**
- Modify: `apps/web/e2e/crewSeason.spec.ts` (+ `support.ts` if a close helper is needed — mirror `getCrewRecordsDirect`)

- [ ] **Step 1:** Hand-derive the expected title from the FROZEN deck under the current roster at test 9 ({Al, Bo} after test 8b's restore — verify against the spec's own flow), from the roster-filtered Stableford ledger (ties share). Write the derivation comment.
- [ ] **Step 2:** Update test 9: close the season over the API (organizer = the deck's organizer account) → `getCrewRecords.titles` equals the hand-derived pin (season name + golfers) → reopen → `titles: []`. The `[]` pin's provisional comment is replaced by the derivation. Every OTHER existing assertion stays byte-identical.
- [ ] **Step 3:** `pnpm validate` (typecheck gate; Playwright runs at controller close-out). **Step 4: Commit** — `test(e2e): the frozen deck's season closes — titles pinned live, reopen empties them`

---

## Self-review notes

- Spec coverage: §1.2/1.4→T1+T2, §2→T3, §4→T1 (slice), T3 (component), T4 (e2e).
- No placeholders; the one pseudocode block names its reuse obligations explicitly.
- Type consistency: `CloseSeasonResponse`/`ReopenSeasonResponse` `{season: CrewSeasonView}` flow T1→T2→T3 (api.ts parses the same schemas).
