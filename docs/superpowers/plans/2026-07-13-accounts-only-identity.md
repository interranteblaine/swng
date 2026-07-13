# Accounts-Only Identity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute `docs/superpowers/specs/2026-07-13-accounts-only-identity-design.md` — the wall. Accounts are the only identity; ghosts and claims are deleted; account=golfer born together (placeholder name f(sub), real name via the funnel prompt); self-join only; `participant-left`; derived round designation; the between-holes digest deleted.

**Architecture:** Additive domain/backend first, then the web rewritten onto the new flows, then the e2e stories rewritten accounts-only, then the backend deletions land against a tree with no remaining consumers, then one controller close (docs, deploy, rebuild+cleanup, live gates, spot-walk, final review). This ordering keeps every commit `pnpm validate` green — the consumer-first deletion lesson from the crew-is-a-grouping arc, planned up front this time.

**Tech Stack:** existing monorepo (TypeScript ESM, Vitest, Zod, DynamoDB, Cognito, CDK, React 19, Playwright).

## Global Constraints

- The spec is the authority. This is deletion plus one identity mechanism — do not preserve claim/ghost machinery in any form, and do not add invite systems, pending states, name-sync, or any machinery the spec excludes (§8).
- **Old stored data tolerates forever, migrates never.** Existing logs/snapshots contain ghost golferIds and claim-era shapes; every deserialization path reads them clean. Round event schema changes are additive only (`participant-left`); request schemas stay non-strict so old clients' dropped fields strip silently.
- **Cognito is a pure authenticator**: stock form, sub only. No custom attributes, no name claim, no PostConfirmation trigger. The name lives only in the domain.
- **Settle decides once; readers never have policy.** No projection/UI may branch on departure; they aggregate settled results only.
- **The crewSeason frozen deck's numbers must not change** — only its seeding (accounts instead of ghosts).
- Every task: `pnpm validate` green before commit; `pnpm test:contract` where adapters/fakes are touched. Deploys controller-run only (`pnpm deploy:beta`, swng-beta, never `InfraCdkStack-*`). No pushes to any remote.
- Closing proof-greps (N-T6 runs them; N-T7 re-runs):
  - `grep -rn "claimGolfer\|ClaimGolfer\|claim-proof\|golfer-claimed\|resolveSuppliedGolfer\|golferIdentity\|unclaimed" packages/ apps/ --include='*.ts' --include='*.tsx'` → only tolerate-and-ignore comments and proof-of-negative tests.
  - `grep -rn "addParticipant\|AddParticipant\|startRoundPlayerSchema\|optional-golfer" packages/ apps/` → zero (tolerate comments on old-data read paths excepted).
  - `grep -rn "HoleDigest\|After hole" apps/web/src/` → zero.
- Route arithmetic across the plan: 35 HTTP/37 total today → N-T2 adds leave (36/38) → N-T6 removes claim + players (34/36). Each task moves `routes.ts`, `HTTP_ROUTES` (`apps/infra-cdk/lib/swngStack.ts`), `apps/infra-cdk/test/routesParity.test.ts`, and every count pin (`swngStack.test.ts` and any literal-count comments) in lockstep.

---

### Task N-T1: Domain — `participant-left`, presence by HLC, settle-once departure, placeholder names

**Files:**
- Modify: `packages/domain/src/round/` (event union, `reduceRound` fold, types) — add `{ kind: "participant-left"; golferId }` to the round event envelope family.
- Modify: `packages/domain/src/round/archive.ts` (`settleRound`) — departure rules.
- Create: `packages/domain/src/golfer/placeholderName.ts` (+ test) — `placeholderName(sub: string): string`.
- Modify: `packages/domain/src/index.ts` exports.

**Interfaces:**
- Produces: `participant-left` event kind; `RoundState` participant entries gain `departed: boolean` (default false); `placeholderName(sub)` → `"Golfer NNNN"` (stable 4-digit hash of the sub — FNV-1a mod 10000, zero-padded; boring by design, deterministic so the mint race cannot generate two names); archive participant entries gain optional `departed?: true`.
- N-T2 relies on: the event kind and `placeholderName`. N-T4 relies on: `departed` in state.

Behavior to pin (tests first, per case):
- **Presence resolves by HLC, like score cells:** for each golferId, the latest of {participant-joined, participant-left} by the existing HLC total order wins (deviceId tiebreak makes ties impossible). Rejoin is just a later join; its seat data (tee/CH) applies. Fold stays commutative: assert convergence over shuffled orders including leave→join→leave chains.
- **Leave × game-add race converges:** `game-added` referencing a departed golfer + `participant-left` in any arrival order → same state (game exists, player departed, holes unscored). NO dominance rule, NO game voiding — `scoreGame` is untouched.
- **Terminal events unchanged:** finalized/abandoned still dominate; no appends after either (existing law, re-asserted with a leave-after-final case).
- **Settle:** a departed participant with zero scored holes AND membership in zero games is OMITTED from the archive entirely (no participant entry, no line — nothing downstream can see them). Any other departed participant settles normally — played holes and game results count exactly as scored/resolved (concessions included) — with `departed: true` on their archive entry. Assert: same deck settled with/without a mid-round departure differs ONLY in the departed player's unscored holes and flag, never in another player's results.
- `placeholderName`: deterministic, distinct-ish across subs, always matches `/^Golfer \d{4}$/`.

- [ ] Step 1: failing tests for every case above (fold commutativity shuffles included).
- [ ] Step 2: implement; `pnpm -F @swng/domain test` green.
- [ ] Step 3: `pnpm validate` green.
- [ ] Step 4: commit `feat(domain): participant-left — presence by HLC, leaving stops the future and never rewrites the past; placeholder names f(sub)`

### Task N-T2: Backend additive — get-or-create identity, leave route, designation data

**Files:**
- Create: `packages/application/src/golfers/ensureGolfer.ts` (+ test) — `(deps: { golferStore }) => (claims) => Promise<Golfer>`: `getBySub`; if absent, create with `placeholderName(claims.sub)` and `namePlaceholder: true`, routed through the existing M9 `SUB#<sub>` `attribute_not_exists` transaction; on condition failure re-read and return the winner. The concurrent-first-request race MUST be contract-tested (two parallel ensures → one golfer).
- Modify: `packages/application/src/golfers/getMyGolfer.ts` — GET /me now ensures (get-or-create returns, sound per spec §2). `updateMyGolfer.ts` — a PUT with a real name clears `namePlaceholder`.
- Modify: golfer record/store/view: `Golfer` gains optional `namePlaceholder?: boolean` (absent = false, tolerate on read); `MyGolferResponse` exposes it (web prompts while true).
- Create: `packages/application/src/rounds/leaveRound.ts` (+ test) — participant-token identity (the token's own golferId; leave is self-only by construction), appends `participant-left`. Idempotent: leaving twice is two events, same fold result.
- Modify: `packages/lambda/src/http/routes.ts` — `POST /rounds/{roundId}/leave`, `auth: "participant"`. Route counts 35→36 HTTP / 37→38 total, all pins in lockstep (see Global Constraints).
- Modify: contracts — `PeekRoundResponse` and the two rounds-list responses (`GET /me/rounds`, `GET /me/rounds/live`) gain `createdAt` (epoch ms from round-created's wall time) **where absent** — implementer verifies each response type and adds only what's missing; the web's designation (N-T4) needs course name + createdAt on all three.
- Modify: `packages/application/src/testing/fakes.ts` mirrors the store surface.

**Interfaces:**
- Produces: `ensureGolfer` (N-T6 rewires StartRound/JoinRound through it); `POST /rounds/{roundId}/leave`; `namePlaceholder` on the wire; `createdAt` on peek/lists.
- Does NOT touch: StartRound/JoinRound behavior (still ghost-capable until N-T6 — the web and e2e must be off those flows first).

- [ ] Step 1: failing tests — ensure-race contract test, GET /me mints (and a second GET returns the same golfer), PUT clears the flag, leaveRound appends for the token's own golfer only, createdAt present on all three responses.
- [ ] Step 2: implement; route sweep in lockstep.
- [ ] Step 3: `pnpm validate` + `pnpm test:contract` green.
- [ ] Step 4: commit `feat(application,lambda,adapters-dynamodb): golfer get-or-create on first touch (placeholder f(sub)), POST /rounds/{roundId}/leave, designation timestamps`

### Task N-T3: Web — the wall's front door (funnel, create, setup, claim UI deleted)

**Files:**
- Modify: `apps/web/src/routes/JoinRoundPage.tsx` — the funnel: signed-out → one sign-in CTA that preserves the join code across the PKCE round-trip (use the app's existing auth-callback return path if one exists; else sessionStorage `returnTo` set before redirect, consumed on callback); signed-in with `namePlaceholder` → the one required field, "What should the card call you?" (a PUT /me), before the join form; the free-text `name` field is DELETED (join sends the golfer's own name until N-T6 drops it from the wire — read it from GET /me, never from an input).
- Modify: `apps/web/src/routes/CreateRoundPage.tsx` — signed-out → the same sign-in CTA (anonymous creation is gone from the UI now, from the API in N-T6); "Playing as" stays; host name field (if any remnant) dies.
- Modify: `apps/web/src/round/SetupPanel.tsx` — the "Add player" ghost form is DELETED; in its place, a share-the-code panel: the join code (already rendered) framed as the one way in ("Players join with this code — new players create their account on the way"). No new fetches.
- Delete: claim UI everywhere — the roster "This is me" affordance and any claim dialogs/copy (grep `claim` under `apps/web/src/` and remove UI + api client fn + their tests; the api deletion completes in N-T6 with contracts).
- Modify: HomePage signed-out state — no anonymous "start a round" path; sign-in CTA + join-by-code (which routes into the funnel) + watch links only.

**Interfaces:**
- Consumes: N-T2's `namePlaceholder` + GET /me mint. StartRound/JoinRound wire shapes UNCHANGED in this task (still carry name — sourced from the golfer record, never from user input).

- [ ] Step 1: failing tests — funnel: signed-out shows CTA and preserves code through a simulated round-trip; placeholder golfer sees the name prompt, real-named golfer doesn't; join form has NO name input (structural pin); SetupPanel: no ghost form, share panel present, no-new-fetch pin; no "This is me" anywhere (proof-of-negative).
- [ ] Step 2: implement. `pnpm validate` green.
- [ ] Step 3: commit `feat(web): the wall's front door — join funnel with name prompt, sign-in-gated create, ghost form deleted, claim UI deleted`

### Task N-T4: Web — round page (leave, digest deleted, designation)

**Files:**
- Delete: `apps/web/src/round/HoleDigest.tsx` + `HoleDigest.test.tsx`; remove its wiring and digest state from `apps/web/src/routes/RoundPage.tsx` (+ test assertions that expected it — deleted, not weakened; add the proof-of-negative: scoring a hole produces NO "After hole" element).
- Modify: `RoundPage.tsx` — "Leave round" affordance (confirm dialog, copy distinct from Scrap: leaving is personal and non-destructive; calls the N-T2 route; after leaving, the page drops to read-only-for-you state or navigates home). Roster renders departed participants with a "left" marker (from `RoundState.departed`).
- Create: `apps/web/src/roundLabel.ts` (+ test) — `roundLabel({ courseName, createdAt }, { withTime? })` → "Casa Verde GC · Sat, Jul 12" / "· 7:58a" appended when the caller passes `withTime` (the HomePage list computes course+day collisions and passes it; lists sort as today).
- Modify: HomePage rounds lists, the archived-round page, and `WatchPage` header to render `roundLabel` (replacing bare course names — the two-indistinguishable-"Walker" bug).

**Interfaces:**
- Consumes: N-T1 `departed`, N-T2 leave route + `createdAt` fields.

- [ ] Step 1: failing tests — digest proof-of-negative; leave calls the route and reflects departure; departed roster marker; `roundLabel` formatting incl. collision case; home list shows distinct labels for same-course rounds.
- [ ] Step 2: implement. `pnpm validate` green.
- [ ] Step 3: commit `feat(web): leave round, between-holes digest deleted, canonical course+date designation`

### Task N-T5: E2E — every story rewritten accounts-only

**Files:** `e2e/` (root workspace: `roundSlice.e2e.test.ts`, `syncSession.e2e.test.ts`, `support/`) and `apps/web/e2e/` (`fieldTest`, `identityRecord`, `crewSeason`, `primaryPath`, `courseEntry`, `killNetwork`, `shareLink`, `support.ts`, deck untouched).

- Root e2e: anonymous StartRound/JoinRound calls become golfer-authed — support mints throwaway Cognito users (`USER_PASSWORD_AUTH`, the existing e2e teardown pattern) and sends Bearers. Ghost seeding via `players[]`/addParticipant in support code is replaced by per-account joins BEFORE N-T6 deletes those APIs.
- `identityRecord.spec.ts` — the play-as-ghost-then-claim arc is deleted; the story becomes: one account signs up, plays three rounds as self (API), hand-pinned index/history asserted live, then wipe+rebuild reproduces exactly. Same oracle discipline, no claims.
- `crewSeason.spec.ts` — the deck's four players become four minted accounts joining each round; the frozen numbers must come out IDENTICAL (assert unchanged); test 8's claim step is deleted — its aggregation-scope proof (join crew → rows appear) is kept by having the fourth account join the crew late.
- `fieldTest.spec.ts` — browser B's join goes through the real funnel (sign-in + name prompt + join); the offline stretch, correction, termination addendum, and finalize parity stay.
- `primaryPath.spec.ts` — "one name typed once" moves to the funnel prompt; still all-browser, still zero API substitutions.
- `courseEntry`/`killNetwork`/`shareLink` — sign-in added where they created/joined anonymously; assertions otherwise unchanged.
- Gate for this task is **typecheck + unit-level only** (`pnpm validate`); live iteration happens at N-T7 after deploy. Any spec that cannot be expressed without a deleted capability is a finding to escalate, not to stub.

- [ ] Step 1: rewrite support first (auth helpers), then specs; keep every surviving assertion at full strength.
- [ ] Step 2: `pnpm validate` green (root e2e and web e2e both typecheck under it).
- [ ] Step 3: commit `test(e2e): every story accounts-only — claims and ghost seeding out of the harness, funnel coverage in`

### Task N-T6: Backend deletions — ghosts and claims go, as-self is all there is

**Files:**
- Delete: `packages/application/src/golfers/claimGolfer.ts` + tests; `packages/application/src/rounds/golferIdentity.ts` (whole file) + tests; the addParticipant use case + tests.
- Modify: `packages/application/src/rounds/startRound.ts` — identity = `ensureGolfer(claims)`; seats the creator only; `players[]` seeding logic deleted. `joinRound.ts` — as-self from the Bearer via `ensureGolfer`; participant name = the golfer record's name at join (frozen into the event — sealed leaf; renames never rewrite cards).
- Modify: `packages/contracts/src/commands.ts` — `startRoundPlayerSchema`/`players` deleted; `host` loses `name`; `golferId` fields deleted from Start/Join; `AddParticipantRequest/Response` + schemas deleted; schemas stay non-strict (old clients' extra fields strip). `packages/contracts/src/golfers.ts` — claim request/response deleted.
- Modify: `packages/lambda/src/http/routes.ts` — `POST /golfers/claim` and `POST /rounds/{roundId}/players` REMOVED; `POST /rounds` and `POST /rounds/join` move `optional-golfer` → `golfer`; the `optional-golfer` tier is deleted from the dispatcher/types. Counts 36→34 HTTP / 38→36 total, all pins in lockstep. `errorMapping.ts` drops `golfer-claimed`/claim-proof codes with `errors.ts` (exhaustive Record forces it).
- Modify: projector (`projectArchive`) — projects a participant's golfer lines/index/presence-clear ONLY when the golfer record is account-bound (has a sub); batch the golfer reads. Create `scripts/dropGhostProjectionLines.mjs` (modeled on `dropOldProjectionItems.mjs`; controller runs it at N-T7 after a rebuild).
- Sweep: web/api call sites for the changed Start/Join signatures (signature-only edits, the G-T1-style sanctioned touch); fakes mirror the new surface.
- Contract test: a legacy stored golfer document with claim-era attributes reads clean; two parallel `ensureGolfer` calls still converge (re-run the N-T2 pin against the final wiring).

- [ ] Step 1: failing tests — StartRound/JoinRound as-self-only matrices (no token → 401 tier test; placeholder-named golfer joins fine and the event carries the placeholder); projector skips sub-less golfers (and still clears presence only for account golfers it wrote).
- [ ] Step 2: implement; run ALL closing proof-greps (Global Constraints).
- [ ] Step 3: `pnpm validate` + `pnpm test:contract` green.
- [ ] Step 4: commit `feat(domain,contracts,application,lambda): the wall — ghosts, claims, and anonymous rounds deleted; join is always yourself`

### Task N-T7 (CONTROLLER): docs, deploy, rebuild+cleanup, live gates, spot-walk, close

- [ ] Step 1: docs — `product.md` §4 (add players by link; everyone signs in once) and §6 (holdout pillar → the one-tap-join promise, dated owner call 2026-07-13); `architecture.md` identity/onboarding paragraphs (Cognito pure authenticator, get-or-create, no claims); `CLAUDE.md` record. Commit docs.
- [ ] Step 2: `pnpm deploy:beta` — verify the cdk diff first: exactly 2 route destroys (claim, players), 1 route add (leave), auth changes on rounds create/join, function bundles; nothing stateful. Then `pnpm publish:web:beta`.
- [ ] Step 3: `rebuildProjections` full pass (paged), then `node scripts/dropGhostProjectionLines.mjs` — record counts; a spot-check golfer's record must be byte-identical before/after except ghost lines gone.
- [ ] Step 4: live e2e — iterate the rewritten specs to green against beta; then gates: `pnpm e2e:beta` ×2, full `pnpm e2e:field` ×2 consecutive.
- [ ] Step 5: hosted spot-walk with a FRESH email (the real funnel): sign-up → name prompt → land on a card via a join link; create a round; leave it from a second account; verify designation labels on home; verify no digest after scoring; zero CSP violations. Delete the throwaway users.
- [ ] Step 6: re-run proof-greps; ledger; single final whole-branch review (most capable model) over the full arc; fix wave if needed; close.
