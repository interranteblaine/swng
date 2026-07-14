# Papercut Batch (entries 8–11) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four open papercuts in `docs/papercuts.md` — the vestigial signed-out device-credential list (10), the settle-omitted departed participant's leaked LIVE# pointer (11), the untrue season empty-state copy (9), and the profile alert's self-link (8).

**Architecture:** One small backend change (presence-cleanup decoupled from projection policy in `projectArchive`) and three small web changes, then a controller close (deploy #7 — function code only, publish, gates, papercut entries marked landed). No schema, route, or wire changes anywhere.

**Tech Stack:** existing monorepo (TypeScript ESM, Vitest, React 19, DynamoDB, CDK).

## Global Constraints

- `docs/papercuts.md` entries 8–11 are the requirements record; each entry's "Wanted shape" governs, with the resolutions pinned per-task below.
- **Settle decides once; readers never have policy** (accounts-only spec §4). Presence-cleanup is identity-keyed housekeeping, NOT projection policy — the fix in PC-T1 must not add any `departed` branch to lines/index projection, which stays account-bound over `archive.participants` exactly as N-T6 left it.
- Never surface raw server text (the M7 discipline). All new copy strings below are exact — use them verbatim.
- No wire/contract changes, no route changes (routes stay 34 HTTP/36 total), no new events, nothing stateful in the deploy.
- Every task: `pnpm validate` green before commit. Deploys controller-run only (`pnpm deploy:beta`, swng-beta, never `InfraCdkStack-*`). No pushes to any remote.
- Closing proof-checks (PC-T3 runs them):
  - `grep -rn "credentialStore.list" apps/web/src/` → zero.
  - `grep -n "Go to profile" apps/web/src/routes/ProfilePage.tsx` → zero.
  - Signed-out hosted home in a browser profile holding pre-wall relic tokens shows NO device round list (the two "Walker" rows are gone).

---

### Task PC-T1: Backend — presence-cleanup over the ever-seated roster (papercut 11)

**Files:**
- Modify: `packages/application/src/projections/projectArchive.ts` (the participant loop at ~lines 69–94: `deleteLive` currently sits inside the account-bound `continue` gate over `archive.participants`)
- Test: `packages/application/src/projections/projectionSlice.test.ts` (or the co-located test file that pins the N-T6 skip behavior — find the existing "skips a participant with no golfer row at all" pin and work beside it)

**Interfaces:**
- Consumes: `RoundArchive.events` (`packages/domain/src/round/archive.ts:34` — the canonical replay source, present on every archive), `projectionStore.deleteLive(golferId, roundId)` (existing port, idempotent no-op on a missing pointer per its own doc at projectArchive.ts:93).
- Produces: no signature changes. Behavior change only: `deleteLive` is called for EVERY golferId that ever appeared in a `participant-joined` event, regardless of account-boundness or archive membership.

Behavior to pin (tests first):
- A participant who joins, then leaves with zero scored holes and zero game memberships, is OMITTED from `archive.participants` by `settleRound` (N-T1's rule) — and the projector STILL calls `deleteLive` for their golferId on that round. This is the papercut: today the account-bound `continue` and the `archive.participants` iteration both skip them.
- Lines/index projection is UNCHANGED: still over `archive.participants`, still account-bound only. The N-T6 pin "clears presence only for account golfers" is deliberately REWRITTEN by this task to "clears presence for every ever-seated golferId" — presence-delete needs no golfer read and deleting a never-written pointer is a no-op; update that test's title and body, don't weaken the sub-less no-line/no-index half.

- [ ] **Step 1: Write the failing test** in the projections test file, using the existing test idiom for building archives (the file already builds archives via `settleRound` over event fixtures — follow it):

```ts
it("clears the LIVE# pointer of a settle-omitted departed participant — presence cleanup runs over the ever-seated roster, not the settled archive", async () => {
  // Deck: Ann + Bo join; Bo leaves having scored nothing and joined no game; Ann completes and finalizes.
  // settleRound omits Bo from archive.participants (accounts-only spec §4's empty case).
  // Build the events with the file's existing helpers; assert as a precondition:
  expect(archive.participants.some((p) => p.golferId === BO_ID)).toBe(false);

  await projectArchive(deps)(archive);

  // Bo's pointer is gone even though Bo is not in the archive:
  expect(fakeProjections.getLive(BO_ID, archive.roundId)).toBeUndefined();
  // And Ann's normal projection is untouched by the change:
  expect(fakeProjections.getLine(ANN_ID, archive.roundId)).toBeDefined();
});
```

Also extend (don't delete) the existing sub-less-participant pin: a sub-less (pre-wall ghost) participant still gets NO line and NO index write, but DOES now get their `deleteLive` called.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F @swng/application vitest run src/projections/projectionSlice.test.ts`
Expected: FAIL — the new test's `getLive(BO_ID, …)` still returns the pointer (deleteLive never ran for an omitted participant).

- [ ] **Step 3: Implement** in `projectArchive.ts`: hoist presence-cleanup OUT of the participant loop into its own pass over the archive's events, and delete the `deleteLive` call from inside the account-bound loop:

```ts
// Presence-cleanup is identity housekeeping, not projection policy: every golfer who ever
// SEATED this round got a LIVE# pointer at join (rounds/presence.ts), including seats the
// settled archive omits (a departed participant with nothing to settle) and pre-wall ghosts.
// So the clear runs over the ever-seated roster from the events — never archive.participants —
// and unconditionally: deleteLive on a pointer that was never written (or already deleted by
// a replayed delivery) is a no-op, and it needs no golfer-record read. Papercut 11.
const everSeated = new Set<GolferId>();
for (const event of archive.events) {
  if (event.kind === "participant-joined") everSeated.add(event.participant.golferId);
}
for (const golferId of everSeated) {
  await deps.projectionStore.deleteLive(golferId, archive.roundId);
}
```

(`GolferId` is already imported in this file via the domain types; add it to the import if not.)

- [ ] **Step 4: Run the focused file, then the package**

Run: `pnpm -F @swng/application vitest run src/projections/projectionSlice.test.ts` then `pnpm -F @swng/application test`
Expected: PASS, no other projection pins disturbed.

- [ ] **Step 5: `pnpm validate`** (root) — green. (Build note from the arc: run `pnpm build` once first if typecheck resolves stale `dist/`.)

- [ ] **Step 6: Commit**

```bash
git add packages/application/src/projections/
git commit -m "fix(application): presence cleanup runs over the ever-seated roster — a settle-omitted departed participant's LIVE# pointer no longer waits out its TTL"
```

---

### Task PC-T2: Web — device list deleted, season copy honest, profile alert copy at home (papercuts 10, 9, 8)

**Files:**
- Modify: `apps/web/src/routes/HomePage.tsx` (the `credentialStore.list()` read at :19, its explanatory comment block at :12–17, and the device-list render branch at ~:181–193)
- Modify: `apps/web/src/round/credentialStore.ts` (or wherever `credentialStore` is defined — delete the `list()` method IF HomePage was its last consumer; verify with `grep -rn "credentialStore.list\|\.list()" apps/web/src` after the HomePage edit; keep the per-round get/save used by RoundPage)
- Modify: `apps/web/src/crews/SeasonPanel.tsx:127–129` (the empty-ledger branch)
- Modify: `apps/web/src/routes/ProfilePage.tsx:313–320` (the `joinGolferRequired` alert)
- Tests: `apps/web/src/routes/HomePage.test.tsx`, `apps/web/src/crews/SeasonPanel.test.tsx`, `apps/web/src/routes/ProfilePage.test.tsx` (follow each file's existing mount/`afterEach(cleanup)` idiom — vitest globals are off)

**Interfaces:**
- Consumes: `SignInCta` (`apps/web/src/auth/SignInCta.tsx`, already imported by HomePage — usage shape at HomePage.tsx:127: `<SignInCta message="…" returnTo="…" />`); `standings.rounds` (already on SeasonPanel's props — the counted-rounds array at SeasonPanel.tsx:117).
- Produces: nothing later tasks rely on.

**Papercut 10 — HomePage.** Delete the `const rounds = credentialStore.list();` read, the comment block that explains it, and the entire device-list render arm (the `rounds.length === 0 ? "No rounds yet" : rounds.map(...)` branch). The "Your rounds" section becomes:
- signed-in: the identity list exactly as today (loading placeholder, live rounds, empty copy — untouched);
- signed-out: `<SignInCta message="Sign in to see your rounds." returnTo="/" />` in the section body (the papercut's wanted shape verbatim — the funnel is the one way onto a card).
If `credentialStore.list()` has no remaining consumer after this, delete the method and its tests too; the per-round credential get/save that RoundPage and the join flow use stays untouched.

- [ ] **Step 1 (P10): failing tests in `HomePage.test.tsx`** — rewrite the device-list pins:

```tsx
it("signed out, a device holding pre-wall relic credentials shows NO round list — only the sign-in CTA", () => {
  // Seed a relic credential the way the old tests did (localStorage/credentialStore fixture).
  // Render signed-out. Then:
  expect(screen.queryByRole("link", { name: /walker/i })).toBeNull();
  expect(screen.getByText("Sign in to see your rounds.")).toBeInTheDocument();
});
```

Keep (unchanged) the existing signed-in identity-list pins — they must still pass untouched.

**Papercut 9 — SeasonPanel.** The `sortedLedger.length === 0` branch distinguishes the two truths:

```tsx
{sortedLedger.length === 0 ? (
  <p className="text-slate-400">
    {standings.rounds.length === 0
      ? "Standings build as rounds are counted."
      : "No current members appear in this season's counted rounds."}
  </p>
) : ( /* existing table unchanged */ )}
```

- [ ] **Step 2 (P9): failing test in `SeasonPanel.test.tsx`** — a standings fixture with ≥1 counted round and an empty ledger (every contributor off the roster) renders exactly `"No current members appear in this season's counted rounds."`; a fixture with zero counted rounds still renders `"Standings build as rounds are counted."`.

**Papercut 8 — ProfilePage.** The `joinGolferRequired` alert (a defensive arm — post-wall, AuthProvider's GET /me mints a golfer before the join form is usable, so this fires only if something is already wrong) stops linking to the page it's on. Replace the alert body:

```tsx
<p role="alert" className="text-red-400">
  Save your name in the form above first, then join the crew.
</p>
```

(The `Link to="/profile"` inside it is deleted. `CrewCreatePage`'s sibling arm links here from a DIFFERENT page — correct from there; leave it alone.)

- [ ] **Step 3 (P8): failing test in `ProfilePage.test.tsx`** — drive the join-by-code submit to reject with `ApiError` code `golfer-required` (the file's existing fetch-stub idiom), assert the alert renders the new copy and contains NO link (`queryByRole("link", { name: /go to profile/i })` → null).

- [ ] **Step 4: run each focused file, fix to green**

Run: `pnpm -F @swng/web vitest run src/routes/HomePage.test.tsx src/crews/SeasonPanel.test.tsx src/routes/ProfilePage.test.tsx`
Expected: PASS.

- [ ] **Step 5: `pnpm validate`** (root) — green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "fix(web): papercuts 8-10 — relic device list deleted from home, season empty-state tells the truth, profile alert stops linking to itself"
```

---

### Task PC-T3 (CONTROLLER): papercut records, deploy #7, gates, spot-check, close

- [ ] Step 1: `docs/papercuts.md` — append a **Landed:** note to entries 8, 9, 10, 11 (entry 8's note records the structural context: post-wall the arm is defensive-only, since AuthProvider's GET /me mints before the form is usable). Commit `docs(papercuts): entries 8-11 landed`.
- [ ] Step 2: `cdk diff` then `pnpm deploy:beta` — expected diff: function bundle updates ONLY (Http/Projector/Rebuild at most), zero route changes, zero stateful. Then `pnpm publish:web:beta`.
- [ ] Step 3: gates — `pnpm e2e:beta` ×2 (16/16 each), full `pnpm e2e:field` ×1 (51 + the documented skip).
- [ ] Step 4: browser spot-check on the hosted app (the session's existing browser profile holds real pre-wall relic tokens — the perfect fixture): signed-out home shows NO device round list and the "Sign in to see your rounds." CTA; zero console errors/CSP violations on the page.
- [ ] Step 5: run the Global Constraints proof-checks; ledger the batch in `.superpowers/sdd/progress.md`.
