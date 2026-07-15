# Crew Membership (invited in, accountable out) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-07-14-crew-membership-design.md` — invite-link membership (7-day HMAC tokens, one signer), organizer authority (remove, transfer, leave-guard), and the total deletion of the permanent join code and add-by-id, with beta crew data deleted outright.

**Architecture:** Backend lands in two tasks (invites-in, then organizer-out) so each keeps the four-way route lockstep green; web is one task (CrewPage affordances + the CrewJoinPage funnel); e2e alignment then controller close (data wipe, deploy #9, gates, funnel spot-walk, final review).

**Tech Stack:** existing monorepo (TypeScript ESM, Vitest, DynamoDB + contract tests, CDK, React 19, Playwright).

## Global Constraints

- The spec governs; its §5 wire summary and §6 YAGNI list are binding. No feature beyond it.
- **One signer:** crew-invite tokens ride `TokenIssuer`/`hmacTokenIssuer` (packages/lambda/src/auth/hmacTokenIssuer.ts) — never a parallel signer. The `TokenClaims` union gains `{ scope: "crew-invite"; crewId: CrewId; inviterGolferId: GolferId; expiresAtMs: number }` and the union's "every variant carries roundId" doc invariant is REWRITTEN; every roundId-consuming verifier (wsConnect subscribe gate, dispatcher participant/round-read tiers) must narrow on `scope` and reject crew-invite tokens. Pin each rejection with a test.
- **Expiry:** `CREW_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000`, applied in `mintCrewInvite` from the `Clock` port (`clock.now() + CREW_INVITE_TTL_MS`). `verify()` must reject an expired crew-invite (confirm/extend the issuer's existing participant-exp handling — the M4-era participant tokens carry `exp`).
- **Inviter-still-member is checked at BOTH peek and join.** Already-a-member join stays a no-op success (joinCrewByCode's existing arm).
- Error codes exact: `crew-invite-expired`, `crew-invite-invalid`, `organizer-must-transfer`, `not-organizer`. Web copy exact (M7 never-raw discipline): expired → "This invite link has expired — ask your crew for a fresh one."; invalid → "This invite link isn't valid — ask your crew for a fresh one."
- Consent screen copy exact: heading `Join {crewName}?`, line `{memberCount} members · invited by {inviterName}`. (Corrected at C-T5: singular-aware `member`/`members` — the C-T3 review caught that this literal renders "1 members" on the solo-founder card, the commonest consent screen there is.)
- **Deletions are TOTAL** (closing proof-greps, C-T5): `grep -rn "joinCode\|join-code\|findByJoinCode\|joinCrewByCode\|addCrewMember\|join-code-exhausted" packages/ apps/web/src/ --include="*.ts" --include="*.tsx"` → zero outside git history. CrewCreatePage untouched.
- Data: NO tolerate machinery, NO migrations — C-T5 deletes all beta crew items before gates run.
- Every task: `pnpm validate` green before commit; tasks touching adapters-dynamodb also `pnpm test:contract`. Deploys controller-only (swng-beta; never `InfraCdkStack-*`). No pushes.
- e2e watch-out: `apps/web/e2e/crewSeason.spec.ts` drives join-by-code today; C-T4 swaps it to the invite flow with the frozen 12-round deck's numbers UNCHANGED (accounts move numbers never).

---

### Task C-T1: Backend — invites in, join code out

**Files:**
- Modify: `packages/application/src/ports/tokenIssuer.ts` (the union + docs), `packages/lambda/src/auth/hmacTokenIssuer.ts` (+ its test: round-trip, expiry rejection, scope tampering)
- Modify: `packages/lambda/src/entries/wsConnect.ts` (or wherever the subscribe gate reads `claims.roundId`) and `packages/lambda/src/http/dispatch.ts` tiers — narrow on scope, reject crew-invite (tests through the real dispatcher, both arms)
- Create: `packages/application/src/crews/mintCrewInvite.ts`, `peekCrewInvite.ts`, `joinCrewByInvite.ts`
- Delete: `packages/application/src/crews/joinCrewByCode.ts`, `addCrewMember.ts` (and their tests' subjects — rewrite the behavior pins against the new use cases, don't drop coverage)
- Modify: `packages/application/src/crews/createCrew.ts` (drop `mintUniqueJoinCode`/`join-code-exhausted`/the joinCode put+view params), `crewView.ts` (drop joinCode)
- Modify: `packages/contracts/src/crews.ts` (CrewView drops `joinCode`; new `MintCrewInviteResponse { token, expiresAtMs }`, `PeekCrewInviteRequest/Response { token } / { crewName, memberCount, inviterName }`, `JoinCrewRequest { token }`; remove/transfer bodies land in C-T2)
- Modify: `packages/adapters-dynamodb/src/createDynamoCrewStore.ts` (+ keys.ts): `put` loses its joinCode parameter, the crew root item loses `joinCode`/`gsi1pk`/`gsi1sk`, `findByJoinCode` deleted; contract tests updated (gsi2 listByGolfer coverage unchanged)
- Modify: `packages/lambda/src/http/routes.ts` + `apps/infra-cdk/lib/swngStack.ts` `HTTP_ROUTES` + `ANON_THROTTLED_ROUTES` + both count-pin test files: `+POST /crews/{crewId}/invites` (auth golfer), `+POST /crews/peek` (auth none, ADD to anon throttle set 8→9), `POST /crews/join` body swap; `−POST /crews/{crewId}/members`. Route counts 34→35 HTTP / 36→37 total — update all four lockstep sites.
- Modify: `packages/lambda/src/compositionRoot.ts` (wire the three use cases; mintCrewInvite needs `tokenIssuer` + `clock`, peek/join need `tokenIssuer`)

**Interfaces:**
- Consumes: `requireCrewMember` (crews/membership.ts), `TokenIssuer.issue/verify`, `addMember` (domain), `Clock`.
- Produces (later tasks rely on): `joinCrewByInvite(claims, { token })`, `mintCrewInvite(claims, { crewId }) → { token, expiresAtMs }`, `peekCrewInvite({ token }) → { crewName, memberCount, inviterName }`; wire schemas above; CrewView WITHOUT joinCode (C-T3 web relies on this shape).

- [ ] **Step 1 (TDD):** failing tests first, per file idiom: issuer round-trips a crew-invite claim and rejects it expired/tampered; mint requires membership (`not-a-member` via requireCrewMember) and stamps `clock.now() + 7d`; peek returns `{crewName, memberCount, inviterName}` for a live invite and `crew-invite-invalid` when the inviter has left; join adds the caller (role "member"), no-ops when already a member, rejects expired/invalid; dispatcher/wsConnect reject a crew-invite bearer where a round token is expected.
- [ ] **Step 2:** run focused files — RED for the right reasons.
- [ ] **Step 3:** implement. `mintCrewInvite` skeleton (mirror shareRound.ts's shape):

```ts
export const CREW_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const mintCrewInvite =
  (deps: { crewStore: CrewStore; golferStore: GolferStore; tokenIssuer: TokenIssuer; clock: Clock }) =>
  async (claims: AccountClaims, command: { crewId: CrewId }): Promise<MintCrewInviteResponse> => {
    const { crew, golfer } = await requireCrewMember(deps, claims, command.crewId);
    const expiresAtMs = deps.clock.now() + CREW_INVITE_TTL_MS;
    const token = deps.tokenIssuer.issue({ scope: "crew-invite", crewId: crew.id, inviterGolferId: golfer.id, expiresAtMs });
    return { token, expiresAtMs };
  };
```

`joinCrewByInvite`: verify → narrow scope → expiry check is the issuer's; load crew; `crew-invite-invalid` if inviter not in `crew.members`; already-member → no-op view; else `addMember(..., role: "member")` through the same revision-checked put joinCrewByCode used. `peekCrewInvite`: same validation, returns the three display fields only. (Adapt `requireCrewMember`'s actual signature — read membership.ts first.)
- [ ] **Step 4:** `pnpm -F @swng/application test`, `pnpm -F @swng/lambda test`, `pnpm test:contract`, root `pnpm validate` (build first if stale dist/).
- [ ] **Step 5:** Commit: `feat(crews): invite links replace the join code — one signer, 7-day expiry, inviter-still-member; add-by-id dies with it`

---

### Task C-T2: Backend — organizer authority

**Files:**
- Modify: `packages/domain/src/crew/crew.ts` — add `removeMember(crew, golferId)` (throws `DomainError("not-a-member")` on absent id, `DomainError("organizer-immovable")` on the organizer) and `transferOrganizer(crew, toGolferId)` (target must be a member; exactly one organizer after — role flip, order preserved); tests beside `addMember`'s.
- Create: `packages/application/src/crews/removeCrewMember.ts`, `transferOrganizer.ts` — both organizer-gated: `requireCrewMember` then `role === "organizer"` else `ApplicationError("not-organizer")`.
- Modify: `packages/application/src/crews/leaveCrew.ts` — organizer branch throws `ApplicationError("organizer-must-transfer")` (a message naming the way out: transfer first).
- Modify: contracts (`TransferOrganizerRequest { golferId }`; remove needs no body — golferId in path), routes + lockstep: `+DELETE /crews/{crewId}/members/{golferId}`, `+POST /crews/{crewId}/transfer` (both auth golfer). Counts 35→37 HTTP / 39 total, all four sites.
- Modify: `packages/lambda/src/compositionRoot.ts` wiring; dispatcher tests for both routes through the real dispatcher (organizer 200, non-organizer 403-shaped error).

**Interfaces:** Produces `removeCrewMember(claims, { crewId, golferId })`, `transferOrganizer(claims, { crewId, golferId })`, the leave guard. C-T3 relies on: CrewView members carry `role` (they already do).

- [ ] Steps: TDD (domain invariants first: remove-organizer throws; transfer preserves exactly-one-organizer; remove≡leave semantics — standings scope untouched, no data deleted), implement, full validate, commit: `feat(crews): the organizer's authority — remove, transfer, and the exactly-one-organizer leave guard`

---

### Task C-T3: Web — the invite funnel and the organizer's roster

**Files:**
- Modify: `apps/web/src/crews/CrewPage.tsx` (or wherever the join code renders — find via `grep -rn "joinCode" apps/web/src/`): the code panel becomes an **Invite** button — mints via the new API, composes `${location.origin}/crews/join#${token}`, copies to clipboard, feedback copy exact: `Link copied — good for 7 days.` Organizer-only per-row "Remove…" (confirm dialog naming the member; copy: `Remove {name} from the crew? Their rounds stay counted; their standings return if they're invited back.`) and a "Make organizer…" transfer affordance. Non-organizers see neither.
- Modify: `apps/web/src/routes/ProfilePage.tsx`: the join-by-code input and its `joinGolferRequired` alert arm are deleted whole (the crews section keeps "New crew" + the crew list; CrewCreatePage untouched).
- Create: `apps/web/src/routes/CrewJoinPage.tsx` at router path `/crews/join` — token from `location.hash` (WatchPage's idiom), then: peek → consent card (`Join {crewName}?` / `{memberCount} members · invited by {inviterName}`) → signed-out shows SignInCta preserving the full link via returnToStore (JoinRoundPage's exact funnel, including the placeholder-name prompt) → Join → navigate to the crew page. Peek failure renders the mapped copy (never raw), with the form still reachable? NO — without a valid token there is nothing to join; render the error and a link home.
- Modify: `apps/web/src/api.ts` (mint/peek/join-by-invite calls; delete joinCrewByCode call), `errorMapping.ts` (the four new codes → exact copy), router registration.
- Tests: component tests per file idiom — funnel branches (signed-out CTA, name prompt, consent card content exact), organizer affordances render only for the organizer role, ProfilePage no longer contains a join input, clipboard feedback.

- [ ] Steps: TDD, implement, `pnpm -F @swng/web test`, root validate, commit: `feat(web): the crew invite funnel — consent-first join page, organizer roster controls, the code panel dies`

---

### Task C-T4: e2e alignment

**Files:** `apps/web/e2e/crewSeason.spec.ts` (+ any root-e2e crew helper found via `grep -rn "crews/join\|joinCode" e2e/ apps/web/e2e/`).

- Swap join-by-code for the invite flow: a member mints an invite over the API, the joiner posts the token. Test 8 (V joins the crew) exercises the REAL new path. The frozen deck and every pinned number stay byte-identical. Add one pin: a removed member's standings rows vanish and a re-invite restores them (the aggregation-scope law, now reachable through remove — extend test 8's own crew, don't add a new deck).
- [ ] Steps: update, `pnpm -F @swng/web exec playwright test --list` (compile check; live runs are C-T5's), root validate, commit: `test(e2e): crewSeason joins by invite — the frozen deck unmoved, remove/re-invite pins the aggregation law`

---

### Task C-T5 (CONTROLLER): data wipe, deploy #9, gates, spot-walk, close

- [ ] Step 1: `scripts/dropCrewData.mjs` (dry-run/real/rerun-0, modeled on dropIndexProjectionItems.mjs): delete every crew item — root + member items — from the core table (find the exact pk/sk shapes in createDynamoCrewStore.ts/keys.ts first). Owner-sanctioned deletion, beta test data.
- [ ] Step 2: `cdk diff` (expect: +2 then net +3 routes across the two lockstep bumps land as route adds/removes + function bundles + the throttle set change; NOTHING stateful) → `pnpm deploy:beta` → `pnpm publish:web:beta`.
- [ ] Step 3: gates — `pnpm e2e:beta` ×2; crewSeason live ×2; full `pnpm e2e:field` ×1.
- [ ] Step 4: browser spot-walk (the walk-primary-flows law): create crew → Invite → open link in a second context signed-out → CTA → sign-up → consent card exact copy → join → roster shows both; organizer removes the joiner → standings scope-check; transfer then leave. Console: zero CSP violations.
- [ ] Step 5: docs — spec Status → implemented; pre-prod spec D3 marked CLOSED by this spec; CLAUDE.md paragraph; implementation-plan.md crew-codes entry gains the landed note. Proof-greps (Global Constraints). Final whole-branch review (most capable model) with the ledger Minors file. Ledger close.
