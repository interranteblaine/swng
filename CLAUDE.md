# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Start here

Design intent lives in `docs/` — read before non-trivial work:

- `docs/product.md` — what swng is and why (the product north star)
- `docs/roadmap.md` — v1 scope and the release arc
- `docs/architecture.md` — the target domain & backend architecture
- `docs/engineering-conventions.md` — how code should read (naming, layout, layering)

Do not resurrect superseded designs from git history.

Conventions are enforced by ESLint where possible — a lint failure is the source of truth, not prose here.

## Build & Development Commands

```bash
pnpm install              # Install all dependencies
pnpm validate             # Lint + typecheck + build + test (full CI check, hermetic — no network/AWS)
pnpm lint                 # ESLint once at the root (one flat config governs all packages)
pnpm build                # Build all packages (topological)
pnpm test                 # Run all package tests (hermetic)
pnpm -F @swng/domain test # Run a single package's tests
pnpm test:contract        # DynamoDB adapter contract tests (DynamoDB Local under Java; NOT in validate)
pnpm e2e:beta             # E2E gate against the deployed beta stack (AWS creds; NOT in validate)
pnpm e2e:field            # Two-browser field-test gate against beta (Playwright; AWS creds; NOT in validate)
pnpm -F @swng/web dev     # Web dev server (Vite; needs apps/web/.env.local — see scripts/webEnv.mjs)
pnpm deploy:beta          # CDK deploy of swng-beta (profile swng)
```

Run a single test file: `pnpm -F <package> vitest run <file>` (e.g. `pnpm -F @swng/domain vitest run src/index.test.ts`). Tests are Vitest, co-located as `*.test.ts`, importing from `vitest` explicitly (web component tests are `*.test.tsx` under happy-dom).

**Before claiming a change is done, run `pnpm validate`** — lint + typecheck + build + test, the same gate CI enforces. Changes to `adapters-dynamodb` also warrant `pnpm test:contract`; changes deployed to beta warrant `pnpm e2e:beta`.

## Architecture

This is a **pnpm monorepo** (Node 20+, pnpm 9.5+, ESM throughout) for the ground-up rebuild
of swng per `docs/product.md` → `docs/roadmap.md` → `docs/architecture.md`. The old
proof-of-concept is **deleted from the tree** — it exists only at git tag `poc-final`, holds
no authority, and must never be resurrected as design input.

Current state (M0–M9 complete): nine packages under `packages/` matching
`docs/architecture.md` §3 (`domain`, `contracts`, `application`, `client`, four `adapters-*`,
`lambda`), plus `apps/web` and the root `e2e/` workspace, with the layer direction and
package boundaries enforced by `eslint.config.mjs` (the web app may import
client/contracts/domain only).
`@swng/domain` is real (M1–M2): the event-sourced round core (commutative `reduceRound` fold,
HLC conflict resolution), all five v1 scoring engines over one log, the WHS handicap engine
(constants pinned to published sources; 9-hole rounds use the published 2020 combining rule
— the 2024 expected-differential method is unpublished), and deterministic `settleRound` →
`RoundArchive`.
The backend vertical slice is live (M3): `contracts` (Zod wire schemas), `application`
(ports + StartRound/JoinRound/AddGame/RecordScore/FinalizeRound; rounds are live from
creation), `adapters-dynamodb` (transactional seq+opId journal with jittered backoff and
consistent reads), `lambda` + `adapters-apigateway` (declarative dispatcher, HMAC
round-scoped participant tokens, WS broadcast), deployed as the `swng-beta` stack and gated
by `e2e/` reproducing the M2 concurrency deck over the wire.
The client SDK is real (M4): `@swng/client` — `createRoundSession` folds confirmed∪outbox
through the domain `reduceRound` (optimistic scoring), full client HLC (send + receive
rules — the floor survives restarts, like the persisted `opCounter`), a durable
`OutboxStore` (memory + IndexedDB), a serialized sync loop (oldest-first push,
transient-keep/permanent-reject, pull as sole cursor authority, WS as sugar with
socket-open catch-up). Gated by an N-device fast-check convergence simulation
(frozen-clock and skewed-behind devices; every interleaving folds to the server log) and
a kill-network e2e against beta. `SessionConfig.deviceId` must be unique per live session
(the web app mints per-tab ids in sessionStorage and names its IndexedDB outbox per device).
The round UI is real (M5): `@swng/web` (Vite + React 19 + Tailwind 4) — create/join by
code, additive game setup, a real scorecard grid with per-game dots (chip-selected active
game), two-tap score-for-anyone entry (picked-up/conceded first-class; the two-tap rule is
`product.md` §9 and is asserted structurally), offline chrome where the queue is presented
as a feature, a between-holes digest (multi-hole catch-up batches collapse to one card),
and finalize → archived card (ResultsView renders the local fold; a structural test pins
its agreement with the server's `settleRound`). `useSyncExternalStore` over one seam
(`useRoundSession`); `describeGame` is the sole site that renders per-kind game standings
(`dots.ts` holds the sanctioned `GameConfig` allocation switch; SetupPanel builds configs
per kind). Gated by
`pnpm e2e:field`: a two-browser Playwright field test against beta playing the full
18-hole `fieldDeck18` (engine-pinned oracle exported from `@swng/domain`) with an offline
stretch, a mid-round correction that moves a 5-skin pot, and finalize parity across
browsers.
Courses are real (M6): `domain/course` — a boring CRUD entity (no event sourcing) with
versioned immutable tee sets, provenance + verification, and `courseCardOf` assignable to the
same `CourseCard` `startRound` always froze — plus the consolidated `gameStrokeAllocation`/
`handicappingFor` scoring exports (the web app's own hand-mirrored dot/AGS arithmetic is
gone, delegating here instead). `contracts`+`application` gain the course use cases
(`CreateCourse`/`AddTeeSet`/`VerifyTeeSet`/`GetCourse`/`SearchCourses`) plus `PeekRound` (a
capability-scoped join-code preview: course name + tee summaries only, nothing else);
`adapters-dynamodb` gets a course store on the `core` table's own search GSI (prefix match on
one shared name normalization); `lambda` gains six `auth: "none"` routes (identity lands M7).
Verification pins the tee-set version it attests (`version` required in the verify body; a
revision racing a verify returns 409 `tee-set-revised` — never a silent transplant onto
numbers the verifier didn't see).
`@swng/web` drops bundled fixtures entirely — `CourseSearch`/`AddCoursePage`/
`CourseSummaryCard` make search-first picking, keyboard-first single-screen entry (tab order
alone fills an 18-hole grid), and "Verify this card" the only course path, with
`JoinRoundPage`'s tee picker sourced from the peek (falling back to free text if it fails —
joining is never gated by the nicety). Finalize also got a correctness fix landing alongside
the routes: `settleRound` now validates settle-ability BEFORE `round-finalized` is appended
(a game-unresolved throw no longer wedges a round permanently final-but-unsettleable), with a
head-seq condition on that append closing the M4-accepted finalize race. Gated by
`apps/web/e2e/courseEntry.spec.ts` (a real course entered from a hand-verified paper card —
"Casa Verde GC" — dots checked hole-by-hole against hand-verified singles-match arithmetic)
alongside the updated `pnpm e2e:field` (`fieldTest.spec.ts` now searches/seeds a real course
through the same public course API instead of a bundled fixture).
Identity and the golfer record are real (M7): accounts, ghost-claiming, and a live WHS index.
`domain/golfer` (`Golfer`/`HandicapProfile`/`effectiveIndex` — official > computed > declared,
`archiveGolferLine`'s per-round history line, `combineNineHoleDifferentials`'s 2020 published
9-hole pairing) plus `game-terminated` in the round log (a commutative, order-independent
set-union fold; `settleRound` excludes terminated games from the must-resolve set and records
`terminatedGameIds`). `contracts`/`application` gain golfer identity use cases and the ONE
projector implementation (`projectArchive` — the DynamoDB Streams trigger and the manual
`rebuildProjections` entry both call it, never two independent implementations); two controller
amendments landed mid-build and are load-bearing: **GET /me never creates** (PUT /me is the one
get-or-create path — the original get-or-create bound a sub before a later claim could ever
run) and **`differentialsUsed` is WHS Rule 5.2a's `use` count**, not the window size. Task 5b
adds **ghost continuity**: `JoinRoundRequest.golferId` is optional and reused as-is iff
unclaimed, so one ghost can play a whole season under one `GolferId` before anyone claims them.
`adapters-dynamodb` gets a golfer store (sub-claiming via a real `attribute_not_exists`
condition) and a projections store; `adapters-cognito`'s `createCognitoVerifier` backs a new
`auth: "golfer"` route tier (Bearer ID tokens, verified in the dispatcher, never an API Gateway
authorizer) alongside the existing `auth: "participant"` tier `terminateGame` uses. Cognito
(email sign-in, Hosted UI + PKCE for the real app, `USER_PASSWORD_AUTH` enabled beta-grade
purely so e2e can mint JWTs without driving the Hosted UI), the stream-triggered
`ProjectorFunction`, and the manual-invoke-only `RebuildFunction` are live on `swng-beta`
(four deploys across the milestone — the routes/Cognito/stream deploy plus a CORS-preflight
fix, Task 5b's golferId change, and a Cognito callback-URL correction). `@swng/web` gets
sign-in chrome, `ProfilePage` (index/trend/distribution/history), the roster's "This is me"
claim affordance, per-game "End game…" termination with an "Ended" badge, and the finalize
dialog's human-readable unresolved-games list ("End unfinished games & finalize" terminates
then finalizes) replacing the old raw-game-uuid error. Gated by `apps/web/e2e/
identityRecord.spec.ts` (mints a throwaway Cognito user via admin APIs, plays three rounds as
one ghost via API, claims the ghost live in the browser, asserts the hand-pinned index/history
against the live system, then proves a projections wipe+rebuild reproduces it exactly) and a
termination-coverage addendum in `fieldTest.spec.ts` (an unresolved game named in the finalize
dialog, terminated, and excluded from the settled results).
Crews and the season ledger are real (M8): the Saturday Boys can exist as a persistent group,
not just a one-off round. `domain/crew` (`Crew`/`CrewMember`/`StandingGame`, `addMember`,
`applyStandingGame` — a preset game survives iff every golferId it references is present,
mirroring `scoreGame`'s own per-kind dispatch) plus `crew/ledger.ts` (`crewContribution`/
`aggregateSeason`, a pure commutative fold from one archive's contribution to a season's
ledger + head-to-head) and an optional `crewId` on `round-created`, carried through state and
archive unchanged. `contracts`/`application` gain the crew use cases (create/get/listMine/
addMember/joinByCode/saveStandingGame/getRecords) and **play-as-yourself** as core, not a
rider: `StartRound`/`JoinRound`/`AddParticipant` all resolve a caller-supplied `golferId`
through the ONE shared `rounds/golferIdentity.ts` resolver (unclaimed reuse, as-self via a
matching Cognito sub, standing crew consent for a fellow member, else a `golfer-claimed`
rejection) — a signed-in golfer with no account golfer yet gets one minted from the form's own
name (`PUT /me` then create, strictly in that order) so a round played as yourself needs no
later claim step at all. The projector's crew extension is the SAME `projectArchive`
implementation M7 already committed to (no forked math): a crew-tagged finalize upserts that
round's own contribution by roundId, then recomputes and REPLACES the whole `(crew, season)`
aggregate from every contribution on file — idempotent and rebuildable by construction, not by
a special case. `adapters-dynamodb` gets a crew store (a transactional root+member-item write,
a join-code GSI partition namespaced apart from course search's own) and crew projections
(`CREWROUNDS#`/`RECORDS#` keyspaces, `wipeCrew` over caller-supplied seasons); `lambda` gains 8
routes (17→25) and an `optional-golfer` auth tier (`POST /rounds`/`POST /rounds/join` take a
Bearer when offered, proceed anonymously when not, 401 on a token that's presented but fails
verification — never a silent downgrade). Two live defects surfaced and were fixed same-task,
not carried forward: a bare (non-conditional) `crewId` property crashed DynamoDB's `marshall()`
on every NON-crew round's finalize (an explicit `undefined` key, not an absent one) — caught by
`pnpm e2e:beta`'s own gate, fixed, and redeployed before the task closed; and a three-state
`auth.golfer` (loading vs. no-profile vs. real) collapsed into one branch let a submit during
the GET /me loading window silently rename a profile with stale free text — fixed with an
explicit loading state that disables submission until identity resolves. `@swng/web` gets the
identity wave — `CreateRoundPage`'s "Playing as `<name>`" line (replacing free-text name entry
outright once a real account golfer exists), `SetupPanel`'s "Add player" (a crew's own members
as one-tap quick-adds, stable golferIds, ahead of a free-text ghost form), claims that carry the
roster's own name instead of falling back to an email localpart — plus crew home
(`CrewCreatePage`/`CrewPage`: join code, roster with claimed badges, a standing-game editor,
season records as a ledger table + head-to-head list) and "Play the usual," one tap from the
crew page into a pre-filled `CreateRoundPage` (course/tee/roster/games via `applyStandingGame`
against whoever's actually present, with a dismissible notice if any preset game fails to seed
rather than a silent drop). Gated by `apps/web/e2e/crewSeason.spec.ts` (a full 12-round crew
season played over the API against a hand-designed, FROZEN deck — verified against the real
domain engines locally before the first live call, and the first live run against beta agreed
with the frozen ledger exactly: singles H2H 5W-5L-2H, skins 54 each, stableford 430/430/435/435
— then rebuild parity, then a second account claiming a crew ghost mid-season and inheriting
all 12 history lines in one claim) and `apps/web/e2e/primaryPath.spec.ts` (the unmodified
primary path, all-browser per the M7-close process law — one name typed once on Profile, then
sign-in through finalize through the profile history line, no API substitutions anywhere). A
field finding surfaced and was fixed in the SAME task: M8's own as-self `CreateRoundPage`
made round-creation sensitive to sign-in state for the first time, which broke an M7-era gate
(`identityRecord.spec.ts`) that stayed signed in from its very first, previously-anonymous
round-creation step — fixed in the test (moved the sign-in injection to the point in the story
that actually needs it), not the product, since the new as-self behavior is correct and
intended.
Share links and hardening are real (M9): swng runs from a phone with no laptop, all on the
SAME `swng-beta` stack — no new stack; prod stays a separate, user-triggered M10. Five beta
deploys, all green: backend correctness (`9fe8226`) — `finalizeRound`'s idempotent branch now
repairs on replay (re-attempts `putArchive` when the archive is found missing, healing a
wedged finalize on retry), a real sub-uniqueness invariant (a base-table `SUB#<sub>` pointer
written atomically with the golfer row via `TransactWriteItems` + `attribute_not_exists`,
`getBySub` reads the pointer, gsi2's own `SUB#` entry stays written for rollback safety but is
no longer read), and crew join codes that mint unique (a bounded retry, `join-code-exhausted`
on exhaustion); identity hardening (`5561c76`) — claiming now requires proof of context
(`ClaimGolferRequest.code`: a round join code whose round contains the golferId, or a crew
join code whose crew has them as a member, checked BEFORE the two 409 collision arms so a
wrong code can't probe claim status — 403 `claim-proof-required`) and real sign-out
(`signOut()` redirects through Cognito's own `/logout`, `logoutUrls` gains the app origin);
share links (`10ebd68`) — a spectator token (`scope: "spectator"` baked into the same signed
HMAC payload as participant tokens, no `exp`, one signer, no fork), `POST
/rounds/{roundId}/share` (participant auth) mints a deterministic `/watch/{roundId}#<token>`
URL, a new `round-read` auth tier accepts participant OR spectator tokens for reads and 403s a
spectator token on any write (`read-only-token`), and a read-only `WatchPage` (token from
`location.hash`, live → archived, no session/outbox/edit affordances); the web papercut batch
(`69aa4fd`, `b34d2c4`, `3e48030`) — 14 fixes (a duplicate-golfer guard, the `parseSeason`
empty-string fix, standing-game roster validation, domain-layer crew-name validation, "Former
member" ledger copy, a raw-error-text sweep, and more) plus a reconnect-QA e2e
(`killNetwork.spec.ts`) and a deterministic WS-liveness hardening of `fieldTest.spec.ts`'s own
cross-context waits; ops (`71076dc`, `78f0e6b`) — HTTP API throttling (50 rps/100 burst
default, 5/10 on the 8 anonymous-reachable routes), 12 CloudWatch alarms onto one SNS topic
(email subscription to `interrante.blaine@gmail.com`, pending confirmation), and e2e
Cognito-user teardown; and hosted beta web (`41f6332`) — S3+CloudFront (OAC, SPA fallback, a
strict CSP) on the existing stack, **live at https://d5qqgppnyb7y1.cloudfront.net/**, with a
full PKCE sign-in/out round-trip and zero CSP violations verified on a phone viewport. Every
hardening-ledger item from M7's close either landed in M9 or is re-accepted-with-dated-record
(2026-07-11) in `implementation-plan.md`'s M9 section — localStorage tokens (the new CSP is
the beta mitigation), `USER_PASSWORD_AUTH` (no prod pool exists yet to be absent from),
share-link revocation, and the remaining self-healing projector/rebuild races among them.
`docs/field-test.md` is a new, shelf-ready v1-bar field-test kit — it gates nothing in M9; it
exists for the user-triggered M10 Saturday. Prod deployment and the field test itself are
explicitly out of M9 (owner decision, 2026-07-11) and form M10; M9's own gate (`pnpm
validate`, `pnpm e2e:beta` ×2, `pnpm e2e:field` ×3 consecutive, a controller flow-walk on six
real-browser flows) is the milestone's separate close-out step.
The snapshot realignment (post-M9, 2026-07-12/13, commits `04b4caf..9a7815f`) closed a
16-task, 4-phase correction titled by its own rule: **the round is a sealed leaf** — every
derived store now references it inbound by `roundId`; the round points at nothing. Phase 1,
the atom: a dedicated `snapshots` table (pk-only, RETAIN, PITR, its own `NEW_IMAGE` stream)
holds one immutable `RoundArchive` per finished round; finalize commits the `round-finalized`
event and its snapshot together in ONE cross-table `TransactWriteItems` (rounds + snapshots),
so "finalized but no archive" is unrepresentable and M9's repair-on-replay branch is deleted
with its reason; the projector's event source moved to the snapshots stream (every record is
a snapshot — no filter); the Scan-based `ArchiveSource` and the rounds table's
`ARCHIVE`/`putArchive` are gone; 752 beta archives were one-time-copied via
`migrateSnapshots.mjs` (idempotent, run twice). Phase 2, the record: the golfer projection
moved to stable keys (`ROUND#<roundId>` lines, `INDEX`, `LIVE#<roundId>` presence — keys are
identities, time is an attribute, closing the documented year-boundary bug class);
`rebuildProjections` became a paged, cursor-resumable backfill over the snapshots table
(`{cursor?, maxSnapshots?}` in, `{processed, cursor?}` out) — no buffer, no global sort, no
wipe; a full rebuild reprocessed all 754 snapshots and matched the pre-migration state exactly
across 1,111 golfers (zero mismatches), after which `dropOldProjectionItems.mjs` deleted 2,697
retired `HISTORY#`/`CREWROUNDS#`/`RECORDS#` items; `GET /me/rounds`, `GET
/rounds/{roundId}/archive`, and an archived-round web page made the snapshot first-class.
Phase 3, the crew correction: crews became accounts-only rosters (ghosts play inside rounds
only, never added to a crew) that define named seasons and COUNT a member's own finalized
rounds into them by `roundId` from the crew's side, never touching the round; standings and
head-to-head are computed on read (`aggregateSeason` over `crewContribution`, folded over
batch-fetched snapshots) and stored nowhere; the entire crew projection layer
(`putCrewRound`/`putSeasonRecords`/`getSeasonRecords`/`wipeCrew`, the
`CREWROUNDS#`/`RECORDS#` keyspaces, `seasonOf = getUTCFullYear`) is deleted, and so is
`crewId` from `round-created`/`RoundState`/`RoundArchive`/`StartRoundRequest` — old stored
events carrying a `crewId` tolerate-and-strip clean across all four deserialization paths;
`crewSeason.spec.ts` was rewritten against the same frozen 12-round deck under the
counted-rounds model (byte-identical standings, plus a new un-count/re-count test). Phase 4,
identity presence & capability: `LIVE#<roundId>` presence items (36h TTL) are written for
every seated golfer, ghosts included, and cleared by the projector at finalize, so "your
rounds" on home is presence by identity, not a device-token list; `POST
/rounds/{roundId}/token` (golfer auth) re-mints a byte-identical scoring token on a new device
for a participant who's already seated; `round-abandoned` is a real terminal — dominant in the
fold, structurally snapshot-free (`settleRound` throws on it before round-not-final), and
head-seq-guarded against a finalize racing the same round (a Critical caught in review and
fixed same-task, `9a7815f`). Four beta deploys landed the whole arc on `swng-beta` (no new
stack, no prod); gates: `pnpm e2e:beta` 16/16 ×2, `pnpm e2e:field` 53 ×2 consecutive, and the
crewSeason rewrite above.

The crew-is-a-grouping amendment is real (post-realignment, 2026-07-13, commits
`6baf36c..` through the close-out sweep): the owner's call — **a crew is a grouping, not a
preset** — deleted every path by which a crew helped run a round. Gone: `StandingGame`/
`applyStandingGame` and the standing-game route (36→35 HTTP routes), "Play the usual" and
the setup-screen crew quick-add, and golferIdentity's co-membership consent arm — a claimed
golfer gets onto a card exactly one way, the person joining as themselves; crew-mates get
`golfer-claimed` like anyone else (pinned at four layers down to a dispatcher 403). Season
standings aggregate the CURRENT ROSTER ONLY: per-contribution lines filtered to roster
golferIds, head-to-head to both-member pairs, names from `CrewMember.name` (the
snapshot-name-recency machinery, the `member` wire flag, and the guest/"Former member"
labels are all deleted); leaving drops your rows at the next read, rejoining restores them —
pure aggregation scope, stored nowhere. Crews moved off the home page onto the profile.
Stored crew docs' legacy `standingGame` attribute is tolerate-and-ignored (contract-tested;
the next whole-document put drops it — never a migration). Deletion landed web-first so
every commit stayed validate-green. Deployed in place as beta deploy #5 (route removal
only, nothing stateful); gates: e2e:beta 16/16 ×2, crewSeason live ×2 on the unchanged
frozen deck with test 8 extended (V claims Bo's ghost → joins the crew by code → Bo's
frozen rows and the Al–Bo head-to-head materialize: membership is aggregation scope,
nothing lost while he was a non-member), and the full e2e:field suite. `getRoundArchive`'s
crew-membership read-authorization (view an archive your crew counts) survives by design —
it references the round inbound by id, the sealed-leaf direction.

Accounts-only identity is real (post-amendment, 2026-07-13/14, commits `515baac..` — **the
wall**): every round participant is a signed-in account; ghosts, claims, and anonymous
rounds are deleted outright. `@swng/domain` gains `participant-left` (presence per golfer =
HLC-latest of {join, leave}, the same mechanism as score cells — commutative incl.
leave-before-join arrival; rejoin is just a later join whose seat data applies; leaving
stops the future and never rewrites the past) with settle-once departure rules
(`settleRound`: departed + zero scored holes + zero game membership → omitted from the
archive entirely; otherwise settles normally with `departed: true`; other players' results
never change) and `placeholderName(sub)` (FNV-1a mod 10000 → "Golfer NNNN"). Identity is
get-or-create on first authenticated touch: `ensureGolfer` mints through the M9 `SUB#`
`attribute_not_exists` transaction (the race's loser re-reads the winner — contract-tested
with real parallelism), placeholder name f(sub), `namePlaceholder: true` until a real-name
PUT /me clears it; **GET /me now ensures** (the M7 "never creates" rule existed to protect
claimable ghosts and died with them); Cognito is a pure authenticator (sub only — nothing
reads `claims.email` into a golfer). Join is always yourself: `POST /rounds` seats its
creator only, `POST /rounds/join` is as-self `{code, tee, courseHandicap}` with the golfer
record's name frozen into the event at join (renames never rewrite cards);
`claimGolfer`/`golferIdentity.ts`/addParticipant/`players[]`/host-`name`/wire-`golferId`
and the `optional-golfer` tier are deleted (routes 35→34 HTTP/36 total: −claim, −players,
+`POST /rounds/{roundId}/leave`); the projector projects lines/index/presence-clears ONLY
for account-bound golfers (missing golfer row = skip, never throw) via a batched `getMany`.
Old data tolerates forever: stored rounds with ghost golferIds fold and render exactly as
written — the sealed leaf is the identity of record for its own participants. `@swng/web`:
JoinRoundPage is the funnel (signed-out → sign-in CTA preserving the code across the PKCE
round-trip via a single-use `returnToStore`; placeholder golfer → one required "What should
the card call you?" prompt, then straight into the join form; no free-text name input
exists anywhere), CreateRoundPage is sign-in-gated, SetupPanel's ghost form is replaced by
a share-the-code panel, all claim UI is gone, RoundPage has "Leave round" (one POST, rejoin
framing distinct from Scrap) and a departed roster marker, the between-holes digest is
deleted outright (owner call — standings are pulled via chips, never pushed), and
home/archive/watch render the canonical derived designation `roundLabel` ("Casa Verde GC ·
Sat, Jul 12", tee time appended on same-course-same-day collision; timezone is an explicit
input, local by default). Both e2e surfaces are accounts-only (root e2e mints via
`USER_PASSWORD_AUTH` with ndjson-tracked teardown; the crewSeason frozen deck's numbers
unchanged under account seeding; fieldTest browser B drives the real funnel; identityRecord
is one account, three rounds as-self, claim arc gone).

Pre-prod hardening D4a/D4b is real (2026-07-14, spec
`docs/superpowers/specs/2026-07-14-pre-prod-hardening-design.md` — the owner session that
dispositioned the whole M10 hardening ledger): the handicap index is **computed on read** in
`getMyRecord` from the history lines the same response already fetches — the stored `INDEX`
snapshot, the `putIndex`/`getIndex` port methods, and the accepted cross-shard
read-modify-write race are deleted whole (old INDEX rows dropped by one-time script, 131
items); and the projector's snapshots-stream event source gained real poison-record handling
(`bisectBatchOnError`, `retryAttempts: 10`, an SQS DLQ that is a metadata bookmark — rebuild
is the re-drive — and a paged DLQ-depth alarm, 14 total). Deployed as beta deploy #8. The
spec also records the standing decisions: tokens stay localStorage+CSP (tripwire: any
third-party script), share-link permanence is the feature (tripwire: private data on
rounds), stage config becomes a typed per-stage props table with the prod stack, and the
crew membership model (permanent join code + no removal path) is an **OPEN design question
that blocks prod** — owner-driven session pending.

Crew membership is real — invited in, accountable out (2026-07-15, spec
`docs/superpowers/specs/2026-07-14-crew-membership-design.md`, closing pre-prod D3, the prod
blocker): membership is **invite links, 7-day expiry, one signer** — a `crew-invite`
`TokenClaims` variant on the same HMAC issuer as participant/spectator tokens (every
round-token verifier scope-narrows and rejects it; expiry is enforced in the two use cases so
`crew-invite-expired` stays wire-distinct from `crew-invite-invalid`), minted by any member
(`POST /crews/{crewId}/invites`), previewed by a capability-scoped auth-none peek
(`POST /crews/peek`, in the anon throttle set), joined as-yourself with inviter-still-member
checked at both peek and join. The **organizer** (M8's dormant role, now real) holds remove
(`DELETE /crews/{crewId}/members/{golferId}`) and transfer (`POST /crews/{crewId}/transfer`),
with exactly-one-organizer enforced by construction and a `leaveCrew` guard
(`organizer-must-transfer`); remove ≡ leave — membership stays pure aggregation scope
(crewSeason test 8b pins remove → rows vanish → re-invite → byte-identical restore, live).
DELETED whole: the permanent join code (field, crew gsi1 partition, `findByJoinCode`,
mint-retry, `CrewView.joinCode`, every UI surface) and `addCrewMember` (nobody is conscripted
— one path in). Beta crew data wiped by owner amendment (392 items,
`scripts/dropCrewData.mjs`) — no migrations, no tolerate machinery. Routes 34→37 HTTP/39
total; web gains CrewJoinPage (fragment token, consent-first: "Join {crew}? · N member(s) ·
invited by {name}", the JoinRoundPage funnel idioms) and CrewPage's Invite button + organizer
roster controls. Deploy #9 also hardened deploy ordering itself: the first new-route-in-the-
throttle-set deploy wedged CloudFormation (`UPDATE_ROLLBACK_FAILED` — stage RouteSettings
name routes by key, no implicit ordering), recovered via `continue-update-rollback
--resources-to-skip`, and fixed structurally (the HTTP stage now `DependsOn` every route,
pinned in the stack tests).

Beta lives at **https://beta.swng.golf** (2026-07-15, owner call): an optional per-stage
`web` prop on `SwngStack` (`{ domainName, hostedZoneId, zoneName }`, resolved in
`bin/infra-cdk.ts`'s `STAGE_WEB` table — the first real D5-style stage config, no stage-name
branching in the stack) mints an in-stack DNS-validated ACM cert, adds the CloudFront alias,
creates the Route 53 A/AAAA alias records in zone `Z00936512AJC1HGD9M7B7` (`swng.golf`), and
appends the domain's Cognito callback/logout entries ALONGSIDE the localhost and
cloudfront.net ones (the old `https://d5qqgppnyb7y1.cloudfront.net/` URL still works — e2e
suites use it). The hostname was handed over from the old POC distribution
(`E2LRGWTEQIYOX9` released the alias via an API-level edit — the POC STACK itself remains
untouched; its own cert was not reused). Prod later gets `swng.golf` as one `STAGE_WEB`
entry in the prod-stack task.

Course cards are real — the stored unit is the frozen unit (2026-07-15, spec
`docs/superpowers/specs/2026-07-15-course-cards-design.md`, plan
`2026-07-15-course-cards.md`, ten SDD tasks, commits `6dc2d3f..8b6c5bc`): the course system
stores exactly one kind of thing — **immutable cards, in lineages**. A `CardRecord` wraps
the exact `CourseCard` value rounds freeze (no translation function exists, pinned by a
same-object-reference test); a course is a lineage's CURRENT pointer over write-once
`CARD#` items; every maintenance act (add tee / fix numbers / rename) is one whole-card
supersession guarded by ONE concurrency rule — the pointer must still name the card the
caller reviewed, else 409 `card-superseded` (M6's anti-transplant pin promoted; the
revision counter, per-tee versions, and courses' `retryOnConflict` all deleted). **Tee
identity is recorded at write time, never inferred** (`TeeId` server-minted; a
supersession's submitted ids must exist in the superseded card; the editor threads ids by
editing in place). **StartRound is a reference command** — `{course: {courseId, cardId},
host}`; the server resolves the lineage, 409s on a stale cardId, and freezes `record.card`
VERBATIM; the old client-authored `card:` shape is gone with no tolerate path.
Verification is deleted whole (the `window.prompt` counter claimed authority the model
never had — the trust model is **transcription, not authority**, spec §2); course writes
are golfer-gated with `enteredBy` derived via `ensureGolfer` and frozen at write. Routes
37→36 HTTP (38 total): −verify, −add-tee, +`PUT /courses/{courseId}`; controller
adjudication (spec §4-annotated, owner-upheld): course writes STAY in the tightened
throttle set (9→8), matching the `POST /rounds` precedent. Every snapshot now records
`(courseId, cardId, teeId per tee)` inside its frozen card and `GolferRoundLine` carries
`courseId?` end-to-end — analytics join keys recorded from day one because sealing makes
them unbackfillable; the owner-amended scrap (`scripts/scrapCourseAndRoundData.mjs`: 209
course items, ~130k round items, 1,080 snapshots incl. the 752 POC-era archives, 1,526
projection rows; zero-proof re-run) means **no legacy snapshot tier exists**. `@swng/web`
gains the Courses surface: `/courses/:courseId` (card + attribution + start/edit/add-a-tee),
a whole-card editor (single-tee UX over the whole-card wire; no hole-count toggle on an
existing card — the same-hole-count invariant pinned structurally), AddCoursePage landing
on the hub; `courseEntry.spec.ts` rewritten (dots table byte-preserved; a task reviewer
caught a URL-wait matching `/courses/new` that would have silently skipped the dots gate on
every live run). Two beta deploys (#10 routes+lambdas, #11 the projector fix) plus
`publishWeb.mjs` (the web ships separately — a stale-bundle miss caught in the controller's
live walk). Two live incidents fixed same-day: five e2e search locators broke on
CourseSearch's new "name · N holes" text (string-level, typecheck-invisible), and the
scrap's 1,080 snapshot REMOVEs saturated the projector shard for hours (the handler treated
NEW_IMAGE-less records as poison) — the projector now skips REMOVEs (`8b6c5bc`,
regression-pinned; INSERT/MODIFY keep the full poison discipline). Gates: `pnpm validate` +
`pnpm test:contract` (89) green at every commit and at HEAD; `pnpm e2e:beta` 16/16 ×3; the
full field suite green (courseEntry 8, fieldTest 14, crewSeason 9 — frozen standings
byte-identical, rebuild parity — plus 22 across identityRecord/primaryPath/killNetwork/
shareLink); a controller browser walk on beta.swng.golf re-entered the REAL Casa Verde GC
by hand through the new entry flow (zero console errors, two-tap scoring, scrap-round
confirm). Recorded, not scheduled: papercuts 13–15, and **papercut 16 — unrated courses are
unusable (owner field report, a real product gap; owner-ruled design session, queued after
this workstream)**.

The handicap model is real, and legible — one index you own, the strokes it becomes
(post-course-cards, 2026-07-16, two SDD arcs: the unrated-courses plumbing then the legibility
correction; specs `2026-07-15-unrated-courses-handicap-model-design.md` for the plumbing,
superseded on model + surfaces by `2026-07-16-handicap-index-strokes-model-design.md` — the
plain-language SOURCE OF TRUTH). **Papercut 16's rating half is closed:** an **unrated course**
(rating/slope optional-as-a-pair, an `isRated` predicate, `validateTeeSet` paired-then-bounds)
now enters, submits, and plays end to end — games/dots come straight from stroke index + course
handicap exactly as a rated card (allocation never depended on slope/rating), and a finalized
unrated round posts an adjusted gross score and **no differential** (it cannot move the WHS
index — true to the rules), but still feeds every stat. Two computed numbers, one owned: the
**swng index** = the WHS fold EXTENDED to unrated (each line contributes its real `differential`
when rated, `ags − par` when unrated) — so it **equals the WHS index exactly for a rated-only
golfer** and diverges only by unrated play; the **WHS index** stays rated-rounds-only by the
official formula. Both are a **metrics read projection** (`domain/golfer/metrics.ts`
`golferMetrics(lines) → { whsIndex?, swngIndex? }`, computed on read, extensible to N future
analytics — papercut 17), renamed from the illegible "suggested" everywhere. The golfer sees
ONE **"Your index"** (`effectiveIndex({declared, computed})` with `computed` sourced from
`swngIndex` at all three surfaces) — it **defaults to the swng index**, shows the WHS index
beside it as an adoptable reference ("Use this"), takes an override, and **every number used is
shown with its source** ("computed from your rounds" / "your own"): no hidden `declared ?? whs`
precedence, `—` when there's no data (no nudge, just data). **Strokes** are that index turned
into one round's play — labeled **"Strokes you get here,"** shown WITH its derivation
("13 — from your index (12.4) on this course"; unrated → "6 — your index (12.4), adjusted for
9 holes; unrated course, adjust if it plays hard/easy"), editable at the tee, frozen into the
round, never stuffed into the profile; the unrated estimate is hole-count-correct
(`round(index)` on 18, **`round(index/2)` on 9**). Every round line now records `par` +
`courseHandicap` (the facts cross-player analytics need — unbackfillable once sealed, so
recorded from day one); `PeekRound` gains `par` + `holes`; the sealed round/snapshot is
untouched beyond the additive unrated arm. Gated: `pnpm validate` green at every commit and at
HEAD, `pnpm test:contract` 90, each task independently reviewed, each arc a clean whole-branch
review ("READY TO DEPLOY — YES"). Close-out is a CONTROLLER-RUN milestone gate
(finishing-a-development-branch frame, 2026-07-16), not owner-triggered: `deploy:beta` LAMBDA
FIRST (peek `holes` + line `par`/`courseHandicap` now required; `UPDATE_COMPLETE` 48.9s) → the
beta refresh is the owner's **WIPE + RESEED** (`scrapCourseAndRoundData.mjs`: 17 courses / 4886
rounds / 39 snapshots / 129 projections deleted, golfers/crews/SUB# kept), **not** a
`rebuildProjections` backfill (owner call — legacy pre-arc lines lacked the now-required fields;
a clean slate is cheaper and honest) → `publishWeb` (bundle `index-C_3IrclE.js`, CloudFront
invalidation) → `e2e:beta` 16/16 ×2 → `e2e:field` 57 passed / 1 documented-skip (all 8 specs,
incl. the new `unratedCourse.spec.ts` 4/4 — a real 9-hole `Sandy Hollow Nine` with blank
rating/slope entered, played, and its six-9s-into-a-swng-index bootstrap all live against beta)
→ a controller browser walk on the DEPLOYED `beta.swng.golf` (real Hosted-UI PKCE sign-in
round-trip, accounts-only get-or-create minting "Golfer 8038", the "Your index" section with
its two named sources + override, and "Strokes you get here: 6" derived live from a declared
12.4 on the unrated 9-holer — the whole wire on the screen; console clean but for two
PRE-EXISTING auth-flow transients the walk made visible, arc-diff-verified to touch no auth code
→ **papercut 18**). Papercut 17 (fold trend/distribution into the same metrics layer) deferred
by owner. On local `main`, never pushed.

The index is a SOURCE you choose, resolved live — the drift bug is now unrepresentable
(post-handicap-model, 2026-07-16, spec
`docs/superpowers/specs/2026-07-16-handicap-index-source-model-design.md`, plan
`2026-07-16-handicap-index-source-model.md`, two SDD tasks, commit `799ec85`): the owner
caught a real defect in the shipped legibility model — "Use this" on WHS wrote today's WHS
value into the lone `HandicapProfile.declared?: number` primitive, so adopting your official
handicap **froze a copy that silently drifts** from the WHS row as you post rounds. The fix
models the index as a SYSTEM, not a primitive: `IndexSource = {kind:"swng"} | {kind:"whs"} |
{kind:"declared"; value}` persisted on the profile, resolved live on every read by one pure
domain function `resolveIndex(source, metrics)` over the metrics read-projection. **The
invariant is "never store a computed number"** — swng/WHS are live views (adopting WHS now
TRACKS the live WHS number; drift is structurally impossible), and `declared` is the only
asserted number, a **permanent peer** (owner call — a system you can correct is more
trustworthy than one you can't). `undefined` is first-class (a computed source with no data →
`undefined`, never `0`); a missing/malformed stored source defaults to `{kind:"swng"}`. The
change landed as ONE atomic commit through domain → contracts → application → adapters → web
(the domain type is imported everywhere), with **no migration** (beta disposable, no prod
pool — `effectiveIndex`, the wire `declared` field, and the adapter's legacy
`official`/`declared` fold are DELETED, not phased out; old golfer rows fold to swng). Every
number on screen carries its source ("from all your rounds" / "your WHS index" / "your own");
ProfilePage "Use this" sets the SOURCE and leaves the override box empty (the anti-drift fix,
pinned by a ProfilePage test that asserts adopt-WHS tracks the live metric and Save posts
`{kind:"whs"}`, not a copied number), and Create/Join derive strokes from the one resolver,
naming a WHS source in the note. Task 2 (e2e reconciliation) was a controller-verified
zero-diff — the prior arc had already aligned the profile-index assertions and the
swng/declared derivation copy was unchanged. Gated: `pnpm validate` green at every commit and
at HEAD, `pnpm test:contract` 93 (golferStore round-trips whs/declared + the `getBySub` read
path + no-source→swng); final whole-branch review "READY TO DEPLOY — YES" (0 Critical/0
Important; invariant traced durable at every write path; deploy-order verdict LAMBDA-FIRST
since the now-required `indexSource` wire field breaks an old bundle only web-first). Close-out
was a CONTROLLER-RUN gate, **no data wipe** (golfer-wire-only change; unlike the prior arc it
adds no now-required round-line fields, and non-wiped beta golfer rows fold to `{kind:"swng"}`
— contract-pinned): `deploy:beta` LAMBDA-FIRST (`UPDATE_COMPLETE`, all 5 lambdas) → `publishWeb`
(bundle `index-CZ_h5Iv7.js`, CF invalidation — stale-bundle window closed) → `e2e:beta` 16/16
×2 → `e2e:field` 57 passed / 1 documented-skip (all 8 specs) → a controller browser walk on the
DEPLOYED `beta.swng.golf` (real PKCE sign-in, get-or-create minting "Golfer 9422" with
`indexSource` proving the required-field parse, the "Your index" source UI rendering
swng-"in use" / WHS-"—"-no-button / `undefined`-as-"—", a declared 12.4 round-tripping to
`GET /me` as `indexSource:{kind:"declared",value:12.4}` with no legacy `declared` primitive,
console clean, zero CSP violations; throwaway Cognito user deleted). On local `main`, never
pushed.

The index picker commits on tap, and a plus handicap is golf-truth the domain owns (post-index-
source, 2026-07-17, spec
`docs/superpowers/specs/2026-07-17-index-source-one-tap-commit-plus-handicap-design.md`, plan
`2026-07-17-index-source-one-tap-commit-plus-handicap.md`, 4 tasks + a review-caught fix, commits
`72d3a38..ffb6224`): the owner caught two defects on the LIVE surface that the prior arc's shallow
walk (a declared positive index, both computed rows "—") never exercised. **One:** the index
picker's "Use this" only mutated browser state — it looked committed but reverted on reload, and a
separate Save fired THREE requests. Fixed to **one tap = one commit**: "Use this"/"Use this number"
each do one `PUT /me` and update the client from that response via a new `auth.applyGolfer` (no GET
/me refetch — `updateMe` already returns the golfer); the active source is `auth.golfer.indexSource`
(no staged `pendingSource`, so nothing to revert); name/home keep their own Save (minus
`indexSource`). **Two:** a plus handicap (index below 0, better than scratch) had no home in the
model — it rendered as a bare `-1.2`, its strokes as "get -2," and on the scorecard a plus player's
give-back strokes silently didn't draw. The owner's ruling — **make illegal states unrepresentable;
the UI is thin, the truth is in the model** — moved the golf convention OUT of scattered view logic
into ONE tested `@swng/domain/handicap/present.ts`: `formatHandicapIndex` (`-1.2 → "+1.2"`),
`formatCourseHandicap` (integer, `-2 → "+2"`), `strokeGrant` (a signed count → receives/gives/none).
EVERY surface renders through them — profile, create/join (`You give N — from your index (+1.2)`),
the scorecard Cell (given strokes draw hollow `○`, net = gross+1 — the invisible-give-back hole
designed out), AND the setup roster (`CH +2`, `gives N`). Enforced by a **whole-`apps/web/src`-tree**
grep gate (no bare signed index/course-handicap render survives; the per-round differential and an
editable `<input>` value are the only carved-out signed numbers). The stored/wire number is
unchanged (`-1.2` is the standard plus encoding); nothing in the API, the model, or the handicap
engine (`allocateStrokes`/`courseHandicapFor` were already correct) changed — this is presentation +
interaction only, so **no `deploy:beta`**, just `publishWeb`. The whole-branch review caught the ONE
surface the spec's enumerated file-list had missed — `SetupPanel` still showing `CH -2` — and it was
fixed in-arc (the `formatCourseHandicap` helper), completing the invariant rather than scoping the
hole out. Gated: `pnpm validate` green at every commit + at HEAD (web 449 / domain 249), each task
independently reviewed, the whole-branch review "Ready to ship — with the SetupPanel fix." Close-out
(web-only, no wipe, no backend deploy): `publishWeb` (bundle `index-BiQ5zUYs.js`, CF invalidation) →
`e2e:beta` 16/16 ×2 (backend-regression sanity) → `e2e:field` 57 pass / 1 skip → a controller browser
walk on the DEPLOYED `beta.swng.golf` driving a REAL plus handicap this time (the lesson from the
shipped miss): declared `-1.2` committed with **exactly one `PUT /me`** (network-panel-verified, the
three-request fan-out gone), rendered `+1.2 · your own`, **survived a reload with no revert**, then
a round on rated Casa Verde GC showed `You give 2 — from your index (+1.2) on this course` and the
roster `CH +2`; console clean, zero CSP violations; throwaway user deleted (the scorecard `○`
give-back is unit-verified with a domain cross-check, not staged live — it needs a two-player
give-back game). On local `main`, never pushed.

The domain boundary is restored — golf logic lives in `@swng/domain`, the web renders
(post-plus-handicap, 2026-07-18, spec
`docs/superpowers/specs/2026-07-18-restore-domain-boundary-design.md`, plan
`2026-07-18-restore-domain-boundary.md`, 7 tasks + one review-caught fix, commits
`e873642..ac880ea`): NOT a feature and NOT "papercut 17" — a correction to a broken architecture
boundary. The layering lint only ever checked import *direction* (the web MAY import the domain),
never whether a React view *re-derived* a golf result inline, so across milestones golf math leaked
into `apps/web`: the profile hand-computed your scoring distribution + index trend, `describeGame`
re-summed par/leaders/skins-carry, the scorecard computed net, the finalize dialog re-mirrored
`settleRound`'s must-resolve set, two pages hand-rolled the unrated course-handicap estimate, and
the watch/archived screens reached past `@swng/client` straight into `@swng/domain`'s
`reduceRound`/`scoreGame`. The invariant restored: **golf logic is ONE tested copy in
`@swng/domain`; the server runs it behind the API for reads + finalize; the web runs it on-device
for the offline round ONLY through `@swng/client` (the one sanctioned client-side compute seam);
`apps/web` renders and computes no golf result — enforced by construction, an ESLint fence.** Ten
leaks moved, byte-identical (relocation, never recomputation — the field oracle decks are the
backstop). T1: `golferMetrics` grew `distribution` + `trend` (required), served on `GET /me/record`,
rendered by `ProfilePage` (papercut 17 absorbed — the ONLY wire change, so the deploy is
lambda-first). T2: the scored `GameState` carries `relativeToPar` (a LIVE-scored line only),
game-level `leaders` (stroke/stableford), and skins `holesDecided`, so `describeGame` is pure
formatting — a review caught that `relativeToPar` had ridden the shared `StrokePlayLine` into the
SETTLED `GameResult`'s wire schema (a required field old snapshots lack → a finalize-replay parse
throw, violating tolerate-old-data); fixed by decoupling `ScoredStrokePlayLine` from the lean
settled line (`resultOf` strips it) so the **settlement wire is byte-unchanged** (`round.ts` net-zero
across the arc). T3: finalize-readiness is a domain `unresolvedGames(state)` sharing ONE
`mustResolve`/`resolvedResultOf` predicate with `settleRound` (a reuse-proof test pins that it names
exactly the game settle throws on); the web is a thin formatter. T4: `netStrokes`, `totalDots`,
`unratedCourseHandicap`, and `gameMembers` (deduping the web's line-identical `gamePlayers`) become
domain functions. T5: `@swng/client` gains `foldAndScore` (the read-only cousin of `RoundSession`'s
live fold, reusing the ONE shared `KNOWN_GAME_KINDS`) + re-exports the on-device round-compute; nine
web files re-point off `@swng/domain`; an ESLint fence
(`@typescript-eslint/no-restricted-imports` on `apps/web/src`, `allowTypeImports`, a banlist over
every barrel-exported golf-compute name — presentation formatters, id constructors, pure accessors
`cellKey`/`findTeeSet`/`gameMembers`, and all `import type` stay allowed) fails `pnpm lint` on any
future direct-compute leak (proven biting; layering rule coexists). T6: the boundary is written down
in `architecture.md` ("Where golf logic lives") + `engineering-conventions.md`. T7: e2e
reconciliation was zero-diff (no spec asserts a changed number/DOM; typecheck green). Each task
independently reviewed; whole-branch review "READY TO DEPLOY — YES" (0 Critical/0 Important — boundary
whole, fence comprehensive, every moved number hand-verified byte-identical, no two-copy drift).
Close-out (controller-run, **NO data wipe** — analytics compute-on-read from existing lines, settlement
wire unchanged): `validate` exit 0 → `deploy:beta` LAMBDA-FIRST (`swng-beta` UPDATE 52.75s) →
`publish:web:beta` (bundle `index-Cch4tjcy.js`, CF invalidation `I6UVS2YVBIIR0M3GTWHYCUITJ`, served
live at beta.swng.golf) → `e2e:beta` 16/16 ×2 → `e2e:field` 57 passed / 1 documented-skip (all 8
specs; `identityRecord` proves the required-metrics wire parses live on the new lambda+bundle,
`courseEntry` proves net=gross−dots renders, `fieldTest` proves live standings) → a controller
browser walk on the DEPLOYED `beta.swng.golf` (real Hosted-UI PKCE sign-in, get-or-create minting
"Golfer 9694" — proving the required-`metrics` `GET /me/record` parses; Profile's served
"Scoring distribution" list renders zeros with no crash and the "Your index" sources show; a live
Casa Verde GC round showing CH 9's ● dots on exactly the nine hardest holes, the "Stableford … 2 pts
thru 1" chip, net "●54" on a scored 1-dot hole, and the finalize dialog's
"Stableford — holes 1–2, 4–18 unscored" readiness line — T1/T2/T3/T4/T5 all live; console clean but
for the two pre-existing papercut-18 auth transients; round scrapped, throwaway Cognito user deleted).
Only the trend SVG + non-zero distribution bars (which need ≥2 rated finalized rounds) were left to
the `ProfilePage` unit render tests + the byte-identical review rather than hand-built live; the DOM
is unchanged. Accumulated Minors all ride-as-note (dup zero-distribution literal, a now-sharper
`RoundPage` comment, the banlist-not-allowlist fence form, and `unresolvedGames` now throwing on an
unknown game kind exactly as `settleRound` always has — unreachable with the five known kinds). On
local `main`, never pushed.

The golfer's record is redesigned — your index over time, not a differential sparkline
(post-domain-boundary, 2026-07-18, spec
`docs/superpowers/specs/2026-07-18-golfer-record-index-over-time-design.md`, plan
`2026-07-18-golfer-record-index-over-time.md`, 5 SDD tasks, commits `a4d4209..3c1c5cd`): a
**design correction**, not a feature — the owner caught that `metrics.trend` (shipped an hour
earlier in the domain-boundary arc) was an unlabeled, ambiguous `number[]` on the wire. The
diagnosis went deeper than the field: the profile's "Your record" was never *designed* — it was
the sum of what each component happened to render, and `trend` was a **rendering** (score
differentials reordered for a sparkline) frozen onto the wire, drawing a confident line through
noise. Differentials are handicap plumbing no golfer thinks in. **The redesign, owner-approved via
mockup:** delete the differential trend entirely; replace it with **"your index over time"** — a
rolling chart of the golfer's **swng AND WHS index, each recomputed as of every round** (rounds
`0..k` folded through the same engine at each `k`, via ONE shared `detailsOf` so the headline is
definitionally the last point and can't drift), **two lines always, no source-following/no choice —
just data** (swng covers every round; WHS holds flat across unrated rounds and is absent before any
rated round; they coincide for a rated-only golfer and diverge only on unrated play), **gated under
8 finalized rounds** (below it a "keep going" message — refusing to draw noise is the trust). The
headline index + source picker are untouched (that's the *stroke claim*; the chart is *data*, so a
`declared` golfer still sees both computed lines). The career-total distribution becomes **"your
typical 18"** (per-18 normalized, reads the same at 5 rounds or 500); **history rows lead with the
score** (`Casa Verde · white · 81 (+9)`); and the **posted differential is canonicalized to its
real 0.1** where shown (`23.6`, never the raw `23.563565891472873`) — the model owns the golf
convention (`postedDifferential`), while the index keeps folding the RAW full-precision lines
(deliberate, tested — `scoreDifferential` untouched, `golferMetrics(sorted)` gets raw; a `3.0/3.05`
fixture proves a rounded-line regression would shift the index a full 0.1). This is boundary-clean:
`indexHistory`/`typicalEighteen` are genuine domain computations served on `GET /me/record`
(unlike the old `trend`, a rendering that shouldn't have been on the wire at all — the arc's own
lesson), and the web plots served numbers computing no golf result (the ESLint compute fence still
holds). Gated: `pnpm validate` green at every commit + at HEAD; `test:contract` 93; each task
independently reviewed; whole-branch review "READY TO DEPLOY — YES" (0 Critical/0 Important — one
fold no drift, the 0.1 split genuinely two paths, per-round `GolferRoundLine.distribution` survives,
O(N²) prefix recompute acceptable for a read-time whole-career projection). Close-out was a
CONTROLLER-RUN gate: `deploy:beta` lambda + `publish:web:beta` together (the `metrics` wire both
ADDS required `indexHistory`/`typicalEighteen` and DROPS required `trend`/`distribution` — no clean
single order; symmetric self-healing stale-bundle window, **NO wipe** — all compute-on-read) →
`e2e:beta` 16/16 ×2 → `e2e:field` (first run caught a **Task-5 reconciliation miss**: `identityRecord.spec`
asserted `history[].differential` to 6 decimals against the raw pins, which the new 0.1 posted value
breaks — fixed to assert `postedDifferential(pinned)`, `3c1c5cd`; re-run **57 passed / 1
documented-skip**) → a controller LIVE WALK on DEPLOYED `beta.swng.golf` (a throwaway 8-rated-round
golfer seeded via the API, profile screenshot inspected: the "index over time" chart drew — swng+WHS
polylines overlapping as designed for an all-rated golfer, 6 dots on the bootstrapped points [the
first 2 pre-bootstrap rounds correctly dotless], rolling values peaking then descending [worse→better,
y-direction correct], the legend + "swng 8.7 · WHS 8.7" summary, the typical-18 line, and score-first
history with the **posted 0.1 differential live** [`82 (+10) · 9.2`, not `9.18125`]; the two-line
*divergence* wasn't shown live [all-rated → overlap] but is unit-pinned by the mixed-`indexHistory`
and lone-WHS-marker tests) → this docs sweep. Minor visual note: the shipped chart is a compact
sparkline without y-axis tick labels (the ASCII mockup had them) — the trend direction + current
values read clearly, accepted. On local `main`, never pushed.

Games are legible — the model teaches, the UI shows (post-record-redesign, 2026-07-19, spec
`docs/superpowers/specs/2026-07-18-games-legibility-design.md`, plan
`2026-07-18-games-legibility.md`, 7 SDD tasks + 2 review fixes, commits `e8bbad8..8b06dab`):
the owner's problem — games were jargony, unviewable, and opaque to new players, in rounds and
crews — closed by ONE principle: **each game's human meaning (name, one-line rules, fits,
handicap convention) is domain truth in one tested module, and every surface renders through
it** (`scoring/present.ts`: `gameKindLabel`/`gameKindBlurb`/`gameKindFits`/`allowancePhrase` —
the `handicap/present.ts` precedent; renames presentation-only, wire kinds unchanged: "Match
play", "Four-ball"). The engines expose the per-hole trails their walks already computed, on
**live GameState ONLY** (`MatchHole` in `"a"/"b"` side vocabulary for both match kinds;
`SkinsHole {hole, winner?, pot}` with absent-winner = carried) — `resultOf` builds settled
results from named fields so **the settled wire is byte-unchanged** (lean-wire tests pin it;
zero contracts edits; old snapshots parse and settle exactly as before). The add-game form
teaches: a radio-card picker (label + fits + blurb), plain who's-in ("Who's playing?", "Team
1/2" — Player A/Side-A schema-speak deleted), and a **strokes preview replacing the raw
allowance decimal** ("Full handicap (standard)" + "Pat 5 dots · Sam gives 1" via one shared
`strokesSummary`; "Adjust" reveals a percent input; match play gets "uses the difference —
only the higher handicap gets strokes"; skins gains a client-side 2-player floor). Viewing:
**tapping the ACTIVE chip opens that game's sheet** (visible `›` cue; chips stay the glance
layer) — full standings for EVERY player (not just leaders), Stableford's decoder ring, dormie
glossed in plain words ("Alex must win every remaining hole to tie"), the match trail as a
●/·-per-side match-card grid, the skins trail as a story list with carry runs collapsed
("Holes 2–3 — carried · Hole 4 — Alex takes 3") — and because the sheet lives inside
`StandingsHeader`, live/results/archived/watch all got it through one integration point,
trails free on archived views via the local fold. ResultsView posts in plain words ("Posted to
handicaps — Pat — adjusted score 82 · posts 12.3"); the season ledger names its games
(`Matches (W–L–H) · Stableford pts · Skins`, a table-scoped footnote, leader-first
head-to-head sentences "Al leads Bo 5–4 · 2 halved"). **"Are these the right games?" —
owner-ruled via the spec: yes, the five stay; Nassau is the recorded next game arc (a
structure over a match with presses, per product.md), Wolf/Vegas/junk v2.** Task reviews
caught and fixed in-arc: the ledger footnote leaking into empty states (`fe77aa4`), and the
whole-branch review's fourball "wins"-vs-"win" grammar drift between sheet and chip
(`8b06dab` — plus the missing fourball sheet test that let it slip). E2E reconciliation was a
deliberate task (the string-breakage lesson): helpers drive the picker by accessible name,
verified locator-by-locator against the JSX. Gated: `pnpm validate` green at every commit;
each task independently reviewed; whole-branch review (0 Critical, the 1 Important fixed);
close-out controller-run — `deploy:beta` lambda-first (UPDATE_COMPLETE 53.41s; engines
changed, wire didn't, lockstep) → `publish:web:beta` (bundle `index-CEzbWTSZ.js`, CF
invalidation) → `e2e:beta` 16/16 ×2 → `e2e:field` **57 passed / 1 documented-skip on the
FIRST run** (every reconciled locator resolved live) → a controller browser walk on DEPLOYED
beta.swng.golf via a seeded 4-account live round (chips renamed live; the fourball sheet's
plural "win" + ●-trail + strokes line; the skins sheet's story summing 4+3+6=13 with
"Carrying 4 into hole 18"; the picker's five teaching cards; the match-play difference
preview computed live; console clean, zero CSP violations; round scrapped after). NO data
wipe (nothing stored changed). Riding as notes: GameSheet duplicates describeGame's
title-suffix expression; the percent input snaps empty→0; **one owner ruling queued — the
stroke-play sheet sorts by raw running total (spec §6) which can rank a thru-0 player above
the real leader mid-round; recommendation: sort by vs-par** (`relativeToPar` is already on
the line). On local `main`, never pushed.

The card never changes, games open in one tap, and a mis-tap is clearable (post-games-
legibility, 2026-07-19, spec `docs/superpowers/specs/2026-07-19-standard-card-game-panels-
design.md`, plan `2026-07-19-standard-card-game-panels.md`, 6 SDD tasks + review fixes,
commits `fdefdea..2c0f3bb`, base `a8fbcdd`): the owner's field critique of the shipped
games-legibility arc — gross and net looked the same, no handicap treatment stated anywhere,
no score clearing down to the wire, the per-game card mutation (M5-era) worse than a standard
card, the double-tap modal hidden — closed by four corrections. **One standard card, always:**
the grid renders gross + each player's own FULL course-handicap dots (`courseHandicapAllocation`
— new domain compute, fence-banned, `@swng/client`-re-exported) with net-vs-those-dots under;
chip taps never touch the grid (`ScorecardGridProps` has no game-typed prop — stable by
construction); SetupPanel roster is `name — tee — CH X`. **Scores clear:** `HoleResult` gains
an additive `{kind:"cleared"}` arm — the fold RETAINS cleared cells under HLC-latest (deletion
would let a late-arriving older write resurrect a score) and ONE accessor `cellAt`
(absent-or-cleared → undefined) replaces every raw cell read across all five engines,
finalize-readiness, settle, AGS, and the web; the ScorePad shows `Clear score` only when the
cell holds a result; the settled wire changes ONLY by this arm (deploy lambda-first — an old
bundle receiving a cleared event parse-fails until refresh, accepted beta window). **One tap,
inline:** chips are disclosure buttons (`aria-expanded`, ▾/▴); a tap expands that game's
`GamePanel` (the de-modaled GameSheet, `role="region"` `{title} standings`) inline below the
chip row — switch, or tap-again to close; "End game…" moved into the panel footer; the
`⋯`/`›`/tablist/second-tap machinery is deleted. **Treatment in words, up front:** every panel
leads title → treatment line → strokes line → note, with NO rules blurb (picker-only, the
owner slop-check); `strokePlayTreatment(scoring, allowance?)` (`Net — 95% handicap (standard)`
/ `Gross — raw scores, no strokes`) and `strokesNote(kind)` join the one-copy formatters in
`scoring/present.ts`; `strokesSummary`'s all-zero copy is now `No strokes — everyone plays off
0.` — the exact CH-0 gross-vs-net answer; the stroke-play panel sorts vs-par-then-thru
(closing the queued owner ruling; the plan's illustrative "+2 above E" fixture was corrected
mid-arc — E outranks +2 on any vs-par board). The whole-branch review (fable) caught the ONE
cross-task leak no scoped review owned: `currentHoleNumber` checked cells via the `in`
operator — a membership form the arc's `\.cells\[` grep structurally couldn't see — so a clear
on the current hole didn't pull the highlight back; fixed with a pre-fix-failing test and the
spec's grep gate HARDENED to the membership form. E2E reconciliation held one more lesson: the
first live field run failed on two STALE ORACLES with the product CORRECT both times
(fieldTest's offline-B skins expectation predated B-goes-dark-with-h9-cleared — the chain
stops at the cleared gap, re-derived to `describeSkinsAt(8)`; killNetwork's `/^\D*6$/`
end-anchor broke on the standard card's net suffix — re-derived to an exact `"●65"` pin that
is STRONGER for its no-dupes purpose). Close-out (controller-run): `deploy:beta` lambda-first
(UPDATE_COMPLETE) → `publish:web:beta` → `e2e:beta` 16/16 ×2 → `e2e:field` 59 passed / 1
documented-skip → the **adversarial USE pass** on DEPLOYED beta.swng.golf (the memory's
lesson, now practiced): CH 9 vs CH 0 accounts, gross AND net stroke play added via the real
picker — the panels showed 11 (+3) vs 9 (+1) LIVE with treatment stated; a mis-tap cleared and
re-entered through the real pad; the review fix proven live (clear on a done hole → the
current-hole highlight RETURNED); the card's dots byte-identical through everything; both-CH-0
round rendered the off-0 sentence; console clean but for the two pre-existing papercut-18
transients — and the pass DID ITS JOB, finding the gross add-game preview still showing
net-shaped copy (`95% handicap (standard)` + off-0) — fixed same-day (`835a6ac`), the fix's
own literal-duplication caught and hoisted into `strokePlayTreatment` (`2c0f3bb`, one-copy
invariant restored), republished (bundle `index-Daj5vQLZ.js`), and re-verified live on the
deployed surface; final reviewer verdict YES at HEAD. NO data wipe (additive wire only).
Riding as notes: symmetric re-score-after-clear untested (fold provably kind-agnostic);
orphan cleared cells of omitted departed golfers ride in `archive.cells` (commented);
`openGamePanel` e2e helper leaves its panel open; killNetwork's A-side keeps a loose anchor
(the dedup pin lives in B's exact one). On local `main`, never pushed.

The app wears the brand — the reskin, the door, and the death of the 401 (post-standard-card,
2026-07-19, spec `docs/superpowers/specs/2026-07-19-brand-reskin-design.md`, plan
`2026-07-19-brand-reskin.md`, 8 SDD tasks + a review-directed fix, commits `1363921..51b51fb`,
base `a474240`): an owner field report — the signed-out home showed THREE identical "Sign in"
buttons and a console 401 on every stale-session load — grew, by owner call ("we might as well
plan the reskin"), into `apps/web` adopting the marketing site's identity
(https://swng.webflow.io/, values extracted live) end to end. The design was owner-approved via
RENDERED MOCKUPS iterated across four rounds (artifact `ff994673`, kept current): cream
`#f7f5ef` paper / forest `#1c2b22` ink / gold `#c9a356` as the pencil (ONCE per screen — the
primary action or the current-hole wash, never data ink) / **oxblood `#8b3a3a` as the second
ink** (extracted from the marketing site's own input placeholder; jobs: under-par scores,
picked-up/conceded glyphs, placeholders, careful actions, errors — nothing else), Georgia
sentences, mono machine-facts, square corners everywhere, and — after the owner rejected
Oswald ("hard to read") and Archivo ("doesn't have a good feeling") — **the system font**,
so the whole identity ships ZERO font files. Tokens live in ONE Tailwind `@theme` block;
idioms (btnPrimary/btnSecondary/btnDanger/btnDangerSolid/cardBox/eyebrow/badge/inputBox/
inputCode) in ONE `ui/classes.ts`; the binding sweep invariant — **recolor, retype, re-shape,
never re-behave** — held across ~40 files with exactly two sanctioned exceptions. One: the
signed-out `/` is now the LANDING PAGE (no app header — Layout renders a bare Outlet iff
signed-out-on-`/`; marketing hero copy verbatim; ONE gold Sign in; "New here? Signing in
creates your account."; a forest band whose mono ROUND-CODE input routes straight into
`/join?code=` — the funnel keeps all its own logic), closing the field report at the root.
Two: `useAuth` reads the `expiresAt` it always stored — `withAuth` refreshes PROACTIVELY
(60s skew) before calling, and a failed background refresh degrades in place via a new private
`clearLocalSession` (NO Cognito /logout redirect mid-load; the explicit Sign out button keeps
it), killing papercut 18's 401 arm structurally. One domain addition: `underPar(score, par)`
in `scoring/present.ts` (fence-allowed presentation truth) inks gross AND net red on the card.
Whole-tree grep gates (no legacy palette incl. red-*, no `rounded*`, no font files, no stray
hex) caught a straggler no task's file list owned (`ShareButton.tsx`); e2e reconciliation
moved 18 `exact:true` locators to anchored case-insensitive regexes because **CSS `uppercase`
changes Chromium accnames but not happy-dom textContent** (~90 others triaged immune). The
whole-branch review (READY TO DEPLOY — YES, 0 Critical/0 Important, invariants verified by
execution) caught the ONE cross-task composition no scoped review owned — signed-out inner
pages rendered TWO golds (compact header Sign in + body CTA), the origin report's exact shape
— fixed same-day (`51b51fb`: the header compact goes btnSecondary). Close-out
(controller-run, web-only — NO `deploy:beta`, no wipe): `publish:web:beta` (bundle
`index-OfMGbMX_.js`) → `e2e:beta` 16/16 ×2 → `e2e:field` **58 passed / 1 documented-skip on
the FIRST run** (59 declared tests reconcile exactly; every reconciled locator held live) →
an adversarial USE pass on DEPLOYED beta.swng.golf (phone viewport, real PKCE, "Golfer 6465"):
the door live with ZERO API calls and ZERO console errors signed out, the code input
pre-filling the funnel, a real Casa Verde round — dots on exactly SI≤9, a birdie 3 wearing
oxblood gross AND net, a mis-tapped 8 cleared through the real pad (the Stableford chip
honestly "5 pts thru 2"), the inline panel with treatment lines — and **the 401 kill proven
on the wire**: `expiresAt` forced past → reload → `POST oauth2/token` 200 FIRST, then `/me`
200, zero 401s, zero console errors, no redirect. Riding as notes: Leave-round's confirm
deliberately wears fairway not oxblood (component-commented spec deviation); HoleGrid retypes
cardBox inline ×3 + the goldwash warning banner is hand-carried in 2 files (hoist candidates);
finalize-modal-over-AddGameForm can transiently show two golds (no scrim — out of charter);
`text-fairway/70` small-text sits below AA-small; the signed-in home's body `h1 "swng"` under
the header wordmark is pre-existing structure (papercut candidate). The marketing site
eventually adopting the system font is recorded, not scheduled. On local `main`, never pushed.

Navigation is the nouns — every noun has an address, every name is a link (post-reskin,
2026-07-20, spec `docs/superpowers/specs/2026-07-20-navigation-design.md` + its post-build
§4c.5 carve-out record, plan `2026-07-20-navigation.md`, 7 SDD tasks + 2 review fixes + a
whole-branch fix, commits `f32dcc3..54e12ad` + cleanup `46cc802`, base `fcf7ce6`): the owner's
field report — no way to reach a course outside the start-round flow, no way to see another
player — closed by ONE principle: **the product is four nouns; navigation is the nouns**
(`/rounds/:id`, `/courses/:id`, `/golfers/:id`, `/crews/:id` + the `/courses` hub and a real
404; every rendered noun-name links to its address, subject to spec-enumerated carve-outs).
Backend adds exactly ONE route — `GET /golfers/{golferId}` (auth `golfer`, 37 HTTP/39 total,
NOT anon-throttled) serving `{name, indexSource, metrics, history}` through a shared
`recordOf` fold extracted from `getMyRecord` (one lines→record implementation) — and ONE
policy relaxation: `GET /rounds/{roundId}/archive` reads for any signed-in golfer (spec §6b
decision: a finalized scorecard is the same class of fact every participant's record already
shows; capability tokens still gate live reads and all writes; the orphaned `not-a-viewer`
vocabulary deleted). Web: `GolferLink`+`PlainNamesContext` (watch turns the whole tree's
golfer links off at the root), `usePageTitle` on every page, `ScrollToTop` (PUSH/REPLACE
only), a `path="*"` 404; the `/courses` hub (search NAVIGATES there — form-fill callers
unchanged; home course; "Courses you've played" via a new pure domain `coursesPlayed` fold —
the `gameMembers` precedent, owner-audit-driven like `indexSourcePhrase(kind, person)`
joining `handicap/present.ts`); the Golfer page rendering the SAME extracted `RecordSections`
ProfilePage uses (byte-identical relocation pinned by unchanged ProfilePage tests) with a
`person` prop — the whole-branch review's ONE Important, caught composing "Your index over
time" onto someone else's page, fixed to "Their … they've played N" (exhortation dropped;
`54e12ad`); **one address per round** — `/rounds/:roundId` resolves archive → your-live
(re-mint via the extracted `openLiveRound`) → honest fallback, `/archive` redirects forever,
every internal link retargeted; the link sweep across SetupPanel/GamePanel/ResultsView/
CrewPage/SeasonPanel/ProfilePage + the heading course-link split, with the scoring surface
(ScorecardGrid/ScorePad/StatusChrome) pinned linkless by a `?raw` structural test (web lint
bans node:fs) and deep links surviving sign-in via the shared `returnTo` funnel on every
gated page. Task reviews caught and fixed in-arc: a raw-`golfer` effect dep double-fetching
every fresh round-link load (ref + ignore-flag + fetch-count-1 regression pin, `1162d8c`)
and the structural pin missing StatusChrome (`e668014`). Gated: `pnpm validate` green at
every commit; each task independently reviewed; whole-branch review (fable) READY TO DEPLOY
with the one fix, verified RESOLVED. Close-out (controller-run): `deploy:beta` LAMBDA-FIRST
(new route CREATE_COMPLETE, 53.8s; old-bundle window verified zero-breakage by review) →
`publish:web:beta` (bundle `index-BCD8uLcw.js`) → `e2e:beta` 16/16 ×2 → `e2e:field` **60
passed / 1 documented-skip on the FIRST run** (61 declared incl. the two new beats: profile
row → round record → course page, and browser B opening A's golfer page) → an adversarial
USE pass on DEPLOYED beta.swng.golf (two live accounts): the funnel preserved a join code
through PKCE; the hub's search NAVIGATED; Bo tapped Ann's name in a live match panel and
read "Walk Ann · plays off — · from all their rounds · Their index over time · they've
played 0" — the person fix live; finalize → results/roster/posted names all linked; home's
recent-rounds row; `/archive` URL redirected live; a signed-out round link funneled
through sign-in BACK to the round; consoles clean (the only entry: the walk tool's own eval
tripping the CSP — the CSP working); walk users deleted. Riding as notes: adjacent
"No rounds yet" empty states on home (live + recent, no loading state); a transport failure
reads as the "round isn't available" copy (no retry split); heading course links wear
decoration-fairway (sentence-context precedent) vs `linkEntity`; GolferPage says "their" even
on your own page (the "This is you · your profile" link is the escape hatch — papercut
candidate); typical-18 extrapolates small samples (pre-existing); the heading-split
expression is hand-carried in 2 files. **Post-close owner correction (same day, `b060e23`):
a history row IS the round** — the shipped two-link row split (course name → course page,
remainder → round) was the SPEC's own error, owner-caught on the live surface ("when you
click into a player's history, which represents a finalized round, and it brings you to the
course page, that's misleading"); rows in round-representing lists (profile/golfer history,
home Recent rounds — one shared `HistoryList`) are now ONE whole-row link to `/rounds/:id`
(the full-card tap target restored, retiring that riding note), entity names inside them
plain, the course one tap away on the round page's heading; spec §4b amended + §4c.5
carve-out recorded; zero e2e locator changes (the round-href click was already the target);
republished (bundle `index-9a79YajF.js`, served live), `e2e:field` 60/1-skip again, 71/71
row pins. On local `main`, never pushed.

The course handicap is correctable mid-round — the log records what happened (post-navigation,
2026-07-20, spec `docs/superpowers/specs/2026-07-20-mid-round-handicap-correction-design.md`,
plan `2026-07-20-mid-round-handicap-correction.md`, 6 SDD tasks + 2 in-arc Important fixes + a
whole-branch fix wave, commits `6265327..a2e36c5`): the owner's field report — "course handicap
cannot be updated mid round" (his wife's complaint) — closed by ONE narrow event. **Semantics:
retroactive, whole round** (a wrong CH was always wrong; dots move on already-played holes, every
standing recomputes, the archive records the corrected number) — free by construction, since
nothing ever snapshots strokes (dots/engines/AGS/settle all read the folded roster live).
**The mechanism survived an owner probe:** the first design reused `participant-joined` (the fold's
LWW seat map absorbs a second join); the owner asked "why is it a participant-joined event?" and the
re-derivation replaced it — a join is a PRESENCE fact (it clears `departed`), and needing a
no-corrections-for-departed guard to suppress half an event's meaning was the tell. The shipped
event is `participant-handicap-set { golferId, courseHandicap }` (subject/author split like
`score-recorded`): the log records corrections as corrections, presence stays orthogonal (a
departed player — whose holes still count — is correctable and never re-seated), and the event
structurally cannot carry a name/tee (name-freeze by construction). Fold rule, one sentence: a set
applies iff HLC-later than that golfer's latest join, so a genuine rejoin's freshly-typed CH always
supersedes an older correction. Wire: `POST /rounds/{roundId}/handicap` (participant auth, 37→38
HTTP/40 total, NOT anon-throttled, existing error codes only — any participant corrects any
participant, the score-for-anyone trust model), server-minted envelope, `leaveRound` shape; the
client transport's score-recorded-only push guard untouched (roster mutations are REST, scoring
stays the only offline-first write). Web: the roster row is the editor — EDIT swaps the static
`CH N` span for a raw-signed input (mutual exclusion pinned with a plus-handicap fixture after the
task review caught `CH +2` and `-2` on screen at once), one teaching line ("Strokes apply to the
whole round — dots and games update everywhere."), Save `btnSecondary` (one gold per screen —
ProfilePage's demoted-commit precedent), api-then-`sync()`, no optimistic write. Review culture
earned its keep twice more: a task review replaced the browser spec's hand-written
`swng:credential` storage injection with the REAL `/rounds/:id` re-mint path (making it the first
spec to drive `RoundRecordPage`'s live-round resolution end-to-end), and the whole-branch review
(fable, 0 Critical) caught that path's own stale oracle — `readJoinCode` waits on a join-code panel
the re-mint entry renders EMPTY (`openLiveRound` saves `joinCode: ""`) — fixed to a Roster-heading
wait before the gate ever ran. Gated: `pnpm validate` green at every commit; close-out
controller-run — `deploy:beta` LAMBDA-FIRST (route live, 38 HTTP confirmed on `swng-http-beta`) →
`publish:web:beta` (bundle `index-CbwK4GFB.js`) → `e2e:beta` **17/17 ×2** (the new wire case green
first try) → `e2e:field` **64 passed / 1 documented-skip on the FIRST run** (incl.
`handicapCorrection.spec.ts` 4/4 live) → an adversarial USE pass on DEPLOYED beta.swng.golf
replaying the exact field complaint (two accounts, Wren seated at a wrong CH 9, match play added
off the wrong number, five holes scored two-tap, then EDIT → 13 → Save: the chip moved
**"2 UP thru 5" → "1 UP thru 5"** and the already-scored hole-5 cell re-struck `5` → `●54` live;
exactly ONE `POST .../handicap` on the wire then one pull; console zero errors/warnings; finalize
via the ended-game dialog; the sealed log read back join-with-9 → one set-to-13 — the story, on the
wire; walk users deleted). NO wipe (additive event + route only). Recorded, not scheduled:
**papercut 19 — any round entered via the re-mint path shows an empty join-code panel** (pre-existing
since the navigation arc; honest fix is server-side, the re-mint response carrying the code).
On local `main`, never pushed.

The join code arrives with the credential, and the round page's actions read in use-order
(post-handicap-correction, 2026-07-20, spec
`docs/superpowers/specs/2026-07-20-round-page-papercuts-join-code-design.md`, plan
`2026-07-20-round-page-papercuts-join-code.md`, 4 SDD tasks + 2 review-directed comment fixes,
commits `7224ed3..6966888`): five owner field reports, one arc. Four are UI corrections —
ScorePad's "Clear selection" renamed **"Cancel"** (it never cleared; it backs out — the M5-era
name read as a data action beside the real `Clear score`); scorecard cells gain `w-full` so a
long name's widened column no longer leaves 56px cells hugging its left edge (cells center
under centered names at any width); and the live page reorders to use-order —
chips → card → setup → **Finalize** → Leave → Scrap → **Share dead last** (owner: least-used
goes last; same move at ResultsView's bottom). The fifth was **a modeling error surfaced by a
feature ask** ("shouldn't the join code be a link or at least copy?"): the code was stored
server-side but never SERVED — clients knew it only by happenstance of entry path (create
response, or the typed join form) and stored it as device state, so the third door
(open-from-home re-mint) rendered a blank Join code panel (papercut 19). The correction, twice
re-derived under owner probing: the join code is **participant-scoped round metadata delivered
with the credential** — a REQUIRED `joinCode` on `JoinRoundResponse` at all three doors
(`joinRound` echoes the just-matched canonical code; `POST /rounds/{roundId}/token` reads it
via new `RoundStore.getJoinCode`, a ConsistentRead GetItem on the meta item, AFTER every auth
check so strangers still learn nothing). The invariant — **holding a participant token means
holding the code** — makes the blank panel unrepresentable going forward; it must NEVER ride
the event log or any `round-read` response (spectators fold the same log — a watch link must
not leak the power to join). On top: SetupPanel's **"Copy invite link"** (`btnQuiet`, ShareButton's
visible-fallback clipboard discipline) copies `${origin}/join?code=X` into the existing
`?code=`+returnTo funnel. One legacy tolerance: pre-fix re-mint credentials hold `""` and keep
the blank panel until the next entry (guard commented as such); no new routes, no error codes,
no event-log change, no migration. Whole-branch review (fable): READY TO DEPLOY — YES, 0
Critical / 0 Important; two comment Minors fixed in-arc (the mint check-order list gained its
step 5; the echo comment states the real mechanism); riding notes: the two-copy clipboard
fallback line (hoist on a third copy), no order-pinning test for the existence-leak property.
Close-out (controller-run): `deploy:beta` LAMBDA-FIRST (required response field; old bundle
strips unknown keys — verified non-strict) → `publish:web:beta` (bundle `index-8yJKQ5-A.js`) →
`e2e:beta` **17/17 ×2** (every join parses the required field live) → `e2e:field` **64 passed /
1 documented-skip FIRST RUN** (incl. the new re-mint-renders-the-code assertion) → an
adversarial USE pass on DEPLOYED beta.swng.golf with screenshots read as design artifacts (the
eyes-on-pixels rule): the reordered page top-to-bottom with one gold; Cancel beside Clear score
on a scored cell (the 5 survived Cancel); "Link copied — https://beta.swng.golf/join?code=UUSERB"
after one tap; **the re-mint door live** (credential wiped → `/rounds/:id` → panel shows UUSERB,
papercut 19 dead on the wire); **the copied link's full round trip** (second account through
the funnel — code preserved across PKCE, "What should the card call you?", joined; its
credential held the ECHOED code); the two-player card at phone width with "Bartholomew Walker"'s
wide column cells centered under the name; ResultsView's Share at the very bottom; console
clean but for Cognito's own favicon 404 and the by-design archive-404 probe. Walk users
deleted; NO wipe (additive wire only).

Analytics are read folds over sealed rounds (2026-07-21, spec
`docs/superpowers/specs/2026-07-21-analytics-read-folds-design.md`, plan
`2026-07-21-analytics-read-folds.md`, 8 SDD tasks + 2 fix waves, commits `422cd01..4fb65ad`,
base `955a4a1`): the owner's problem — rich analytics without footguns or slop — closed by a
6-point binding model the design session converged (a Codex-authored fact-table/projector/
manifest design was REJECTED for re-building machinery this repo deleted twice): **the
snapshot is the only truth; every scope stores only a list of its rounds; exactly ONE
performance cache (the golfer's own row); the crew folds snapshots at read; the crew is the
only leaderboard (owner ruling); the web renders served numbers.** The ONE storage change:
`GolferRoundLine.holeResults?` (`{hole, par, result: DecidedHoleResult}[]`, decided cells via
`cellAt`, par frozen at play time) — built in `archiveGolferLine`'s SAME walk as
`distribution`, backfilled by ONE paged `rebuildProjections` run (436 snapshots), never on
the wire (`toWireLine` maps explicitly). On it: `golfer/analytics.ts` (`fullyHoledOut` — the
one implementation everywhere — `bestsOf` strict-<-earlier-tie, `milestonesOf` fixed kind
order: first-birdie/first-eagle/broke-100/90/80 on fully-holed-out 18s; both REQUIRED
`GolferMetrics` members riding the existing record routes), `golfer/courseRecord.ts` (domain
owns every gate: insights ≥5 rounds, per-hole ≥3 strokes-plays, neverBirdied shown at 1–3
remaining) + `golfer/present.ts` phrases (fence-allowed), `crew/analytics.ts`
(`partnerRecords` fourball both-member pairs, `netAverages` ≥3-round floor +
more-qualifying-hole-count rule, `mostImproved` drops-only over application-computed
boundary indexes, `stablefordTitle`). Wire: 2 routes (38→40 HTTP/42 total, golfer-auth,
not anon-throttled) — `GET /me/courses/{courseId}/record`, `GET /crews/{crewId}/records`
(all-time = deduped counted rounds, ONE `getMany`, titles from CLOSED seasons oldest-first);
standings response grows REQUIRED `partners` + `superlatives` ({lowestNet ties-share,
mostImproved absent-not-empty}). Web: RecordSections Bests/Milestones (roundId→history
join, empty renders NOTHING), CourseRecordSection ("builds at 5 rounds" gate line),
SeasonPanel partners/superlatives, CrewRecordsSection (all-time + titles; year suffix ONLY
when the season name IS a 4-digit year — review-caught: names are free text). Reviews earned
their keep: the whole-branch review (fable, READY TO DEPLOY — YES, all invariants verified
by execution) caught spec §8's missing rebuild-parity assertion for holeResults-DERIVED
metrics (a rebuild dropping the field would have passed every gate — fixed `4fb65ad`), and a
task review caught the `'{yy}` slice rendering garbage on free-text season names. Gates:
`pnpm validate` green at every commit; e2e:beta 17/17 ×2; **e2e:field 66 passed / 1
documented-skip FIRST RUN** (every hand-derived oracle held: identityRecord bests 82/+10 +
broke-100/90, crewSeason frozen-deck nets 866/12→72.2 with existing assertions
byte-identical, the course-record beat); adversarial USE pass on DEPLOYED beta.swng.golf
(fresh "Golfer 5088", empty profile renders no sections, one seeded 88-gross birdie round →
"Best 18: 88 (+16)" linked + First birdie/Broke 100/Broke 90 live, course "Your record
here" + gate line, crew All-time both empty truths through the real route; console zero app
errors). Deploy #(lambda-first) + publishWeb (`index-D_awqjG5.js`) + the one rebuild; NO
wipe. **Post-close ruling wave (same day, `c894df5`+`4a5f216`, owner directive: "provide
your judgment"):** the four surfaced items became controller rulings, not owner questions.
(1) The client-side ledger ranking sort was FIXED, not escalated — the frozen-deck law
protects the hand-designed NUMBERS, and the expected arrays' ORDER was a documented wire
coupling (locator-class), so **standings order became domain truth**: `aggregateSeason`
sorts totally (wins desc → points desc → golferId asc, full-tie tested), both client sorts
deleted, the deck derives order via the textually-same comparator with values proven
byte-identical three ways (diff-context, the spec's local-fold-vs-frozen backstop at
crewSeason.spec.ts:139, validate ×2); redeployed lambda-first + `index-DT1Ju2d6.js`,
e2e:beta 17/17 ×3, crewSeason 10/10 live, full field 66/1-skip. (2) The gameless-counted-
round copy was false and is fixed: one sentence true in both empty cases ("No standings
from these rounds yet — standings build from games between current members."), both
components. (3) Milestone labels stay plain ink — ruled correct (oxblood's job list is
closed; a label isn't an under-par score; the mockup predated the discipline). (4) **No
API path closes a season** — Stableford titles stay inert until one lands; ruled the next
arc: organizer-only close/reopen verbs (the transfer/leave route idiom; the
counted-round-mutation 409 guard on `status:"closed"` is already load-bearing), one
"Close season" button + teaching line, reopen because a correctable system is the
trustworthy one (the declared-index precedent). Riding note from the wave's review:
`GamePanel.tsx` sorts live stableford game lines client-side (pre-existing, out of this
ruling's scope — a future boundary-sweep item).

The season closes — the organizer's verb that makes titles real (2026-07-21, spec
`docs/superpowers/specs/2026-07-21-close-season-design.md`, plan
`2026-07-21-close-season.md`, 4 SDD tasks + 1 review fix, commits `0f8f244..a25a60a`, base
`1b87e78` — the ruling-wave item (4) executed): `CrewSeason.status: "open"|"closed"` was
load-bearing (append/remove-counted-round 409 on closed; `getCrewRecords` awards Stableford
titles from closed seasons only) but nothing could SET it. Now: **organizer-only
close/reopen verbs** — `POST /crews/{crewId}/seasons/{seasonId}/close` + `/reopen` (auth
golfer, 40→42 HTTP/44 total, not anon-throttled), organizer-check BEFORE season lookup (a
non-organizer never learns whether a seasonId exists), 409s wire-distinct
(`season-already-closed`/`season-not-closed`), the verbs flip `status` via `putSeason` and
store NOTHING else — titles stay a read fold, permanently. **Reopen is first-class, not an
apology** (one tap, no confirm — a correctable system is the trustworthy one, the
declared-index precedent); reopening is provably lossless since nothing about a title is
ever stored. Web: Close season (`btnQuiet`, confirm + teaching line "Closing locks this
season's counted rounds and awards its titles — you can reopen it later."), `closed` badge,
Reopen in place of Close, and BOTH mutation doors hidden on a closed season — count-a-round
AND the per-round Remove (the task review caught Remove still showing, the exact
"door the server has closed" rule; fixed `52dc926` with the one-rule comment
cross-referenced). E2E: crewSeason test 9's provisional `titles: []` pin (its own comment
named this arc) upgraded — close the FROZEN deck's season live → the crown lands on the
{Al, Bo} 430 tie ("The Golden Dozen"; Cy/Dee's 435s roster-filtered out — the
counter-intuitive-but-correct case, independently re-derived by the oracle review) → reopen
→ `[]`, deck numbers untouched, rerun-safe. Whole-branch review (fable): READY TO DEPLOY —
YES, 0 Critical/0 Important (guard surface complete, wire additive-only, one-gold holds);
noted as design-not-defect: a closed season's title can still shift with roster changes —
aggregation scope is the standing law, and the teaching line claims only what's true.
Close-out (controller-run): validate exit 0 → `deploy:beta` LAMBDA-FIRST (UPDATE_COMPLETE,
42 HTTP routes confirmed incl. close/reopen) → `publish:web:beta` (`index-BYhpsnXh.js`,
curl-verified) → e2e:beta 17/17 ×2 → **crewSeason 10/10 live, the title crown on its FIRST
live run** → full e2e:field 66/1-skip → a browser walk on DEPLOYED beta.swng.golf (fresh
"Golfer 0023", real PKCE): season "2026" closed through the real confirm (teaching line
verbatim, oxblood Confirm — a careful action, no gold), the closed state wearing the badge
with Reopen and NO count door, reopened in one tap restoring everything; console zero app
errors (the on-screen title with a real crown is API+unit-verified — staging a multi-player
stableford season live wasn't warranted, the plus-handicap-walk precedent). NO wipe.
Riding: refetch-failure shows the generic line after a SUCCESSFUL close (idiom-consistent
with count/remove), picker state survives a close/reopen cycle (cosmetic), the organizer
guard now duplicated 4× (extract on next occurrence), the plan's pin-arithmetic slip
corrected in the doc post-build.

The index chart is finished — a windowed, scaled, honest plot (2026-07-21, spec
`docs/superpowers/specs/2026-07-21-index-chart-polish-design.md`, plan
`2026-07-21-index-chart-polish.md`, 3 SDD tasks + a controller fix, commits
`ebe861d..52b5623`, base `1003d1e`): the owner's field report — "the trend graph isn't
polished" — un-accepted the record-redesign's riding note (a compact sparkline, no axis,
no padding, fixed 280px, unbounded points) and closed it via an owner-approved rendered
mockup (artifact `117821fb`, the reskin precedent), with the design converging under owner
probing (width? point growth? range choice?) to: **the chart windows to the last 20 rounds
— the WHS window (Rule 5.2a), so the plot shows exactly the run of rounds the number at
the end of the line was built from** (a presentation `slice(-20)`; honest by construction
since every IndexPoint folds the whole career before it; month/year/all-time/range-picker
all rejected on record — "no choice, just data" stands); **scale honesty** (nice integer
bounds, a MINIMUM y-span of 4 index points so a quiet season looks quiet — the 8-round
gate's own refusing-to-draw-noise principle applied to amplitude; ticks step 1/2/5, every
tick a hairline gridline; tick labels through `formatCourseHandicap` so the plus
convention holds on the axis — the whole-tree grep gate has no axis carve-out); **no
frame** (gridlines on the paper replace the cardBox border; the old line-on-the-border and
half-clipped end markers are geometrically impossible under the ML30/MR12/MT10/MB24
insets); **fluid width** (a new `useContainerWidth` ResizeObserver hook, fallback 320 for
happy-dom, `max-w-xl` cap; CSS-pixel coordinates so type/dots/strokes never scale);
endpoint emphasis (each series' latest dot r=4 — it IS the number the caption names); the
legend row and summary merged into ONE caption (`● swng 7.8 · ○ WHS 7.8`); and **date
anchors** (`May 12 … Jul 21`, mono, year appended only cross-year) — "over time" finally
says which time, fed by the arc's ONE wire change: record history rows (`GET /me/record` +
`GET /golfers/{id}`) gain OPTIONAL `finalizedAt`/`createdAt` (recordOf's `toWireLine`
passthrough, GetMyRounds' rename discipline; old-lambda tolerance contract-pinned both
directions), joined to chart points by `roundId` (order-independent — wire history is
newest-first, indexHistory oldest-first). Review culture: Task 2's implementer caught its
own Rules-of-Hooks bug (hook after the gate's early return — hoisted); the opus task
review re-derived both tick oracles by hand and read test STDERR (not just exit codes);
the fable whole-branch review (READY TO DEPLOY — YES, 0 Critical/0 Important) probed the
algorithm's boundary conditions by execution (span-exactly-4, all-identical, single-point,
empty-values — NaN never reaches a DOM attribute) and caught the spec's own "(3–5 ticks
always)" parenthetical as an overclaim (amended with a dated correction; extreme spans can
yield 2 ticks, values honest). Close-out (controller-run): validate exit 0 → `deploy:beta`
LAMBDA-FIRST (either order provably safe; precedent held) → `publish:web:beta` (bundle
`index-fgwhW71J.js`) → `e2e:beta` 17/17 ×3 → `e2e:field` **66 passed / 1 documented-skip
FIRST RUN** → a browser walk on DEPLOYED beta.swng.golf (a throwaway 9-round seeded
account: ticks 8/10/12 from real data, the descending trend floating frameless with
nothing clipped, the larger 7.8 endpoint dot, both `Jul 21` anchors, the merged caption,
"your last 9 rounds"; the single visible line is the documented rated-only swng/WHS
overlap; console zero app errors — the lone entry is the pre-existing pre-sign-in
stale-token 400; walk user deleted, screenshot read then removed). NO wipe (additive
optional wire only). Riding as notes: an all-downgraded 8+-round golfer gets an empty
plot rather than a gate message (future "no postable rounds yet" branch candidate); the
20-point window's e2e coverage is unit-level by design (no ≥21-round live fixture). On
local `main`, never pushed.

The crew watches — window seasons and the automatic scoreboard (2026-07-21/22, spec
`docs/superpowers/specs/2026-07-21-crew-scoreboard-window-seasons-design.md`, plan
`2026-07-21-crew-scoreboard-window-seasons.md`, 5 SDD tasks + 3 fix waves + 2 controller
fixes, commits `e362d94..bac0ed2`): the owner's field report — crews are "lacking and
clunky" — diagnosed to ONE root: **the crew only knew what you told it** (every member
manually counted each round into a season, a chore nobody performs, so the page sat empty
while any stranger could already read the same facts on `/golfers/{id}`). Closed by ONE
principle: **the crew watches; members just play** — it READS its members' golf, is never
FED it, and automatic counting discloses NOTHING new (the decisive argument over Codex's
"joining implies consent"). A **season is a time window now, not a list**: `CrewSeason`
gains `startsAtMs` (the tiling rule — `max(last closed season's end, Jan 1 UTC)` — so
sequential seasons tile and a memorialize-after-the-fact season reaches back) and
`closedAtMs` (close stamps it, reopen deletes it; both verbs otherwise unchanged);
`createCrew` auto-opens the year's season so a crew is born alive; a round is in-season
iff its played date (`createdAtMs ?? finalizedAtMs`) falls in the inclusive window AND its
golfer is on the CURRENT roster (tenure ignored — the standing aggregation-scope law;
Codex's rounds-while-a-member rejected on record). One window feeds two boards from ONE
`listLines` per member: the **scoreboard** (new `domain/crew/scoreboard.ts`, a pure fold —
Rounds · Best 18 · Net/18 [AGS-based vs-par per 18, ≥3-round floor; avg-gross rejected as
dishonest across mixed pars/hole-counts] · Index + season Δ; every member rows including
rounds-0; total sort domain-owned) and **together-records** (`sharedRoundIds`: a round is
"together" iff ≥2 current members' lines share its roundId — you can't accidentally play a
match with a crew-mate; ledger/H2H/partners/titles fold EXACTLY as before over the derived
set). DELETED whole: `CountedRound` + three store methods + both use cases + both routes
(HTTP 42→40, total 44→42) + the wire schemas + both UI doors + the error vocabulary
(`round-already-counted`, the counted `season-closed`, and — a review catching spec §2b's
clause the plan under-enumerated — `did-not-play`/`not-the-appender`); the superlatives
block + `netAverages`/`mostImproved` (SUPERSEDED: a board where everyone has a line beats
winner-only callouts; `stablefordTitle` stays). Legacy: season rows fold
`startsAtMs ← createdAtMs`; orphan `SEASON#…#ROUND#` items tolerated forever
(contract-pinned); NO wipe, no migration. Review culture earned its keep at every level:
task reviews caught a missing-slice-test wave (T2) and confirmed the T3 implementer's TWO
correct deviations (`vsPar(netPer18, 0)` — the plan's `,1` was the controller's own bug,
vsPar subtracts par; and the ≥2-member consequence honestly rewriting the deck's solo-Al
phases to assert `[]` with frozen NUMBERS relocated intact to the {Al,Bo} tests); the T4
opus review re-derived the frozen scoreboard literals from the deck by hand (+0.2/−0.2,
71(−1), ags==gross proven) and verified them non-circular; the fable whole-branch review
(READY TO DEPLOY — YES after one test-only fix) verified the played-date rule one-copy by
execution, proved all four hypothesized seam defects absent, and caught the gate's TWO NEW
projector-lag races (the scoreboard reads the async golfer projection where counted
standings read transactional snapshots — `pollUntil` on COUNTS only, never values).
Close-out (controller-run): validate exit 0 → `deploy:beta` LAMBDA-FIRST
(`UPDATE_COMPLETE`; 40 HTTP routes live-verified, both counted routes gone; forbidden
order proven: web-first would break the whole crew surface on required `startsAtMs`) →
`publish:web:beta` (`index-Qp64GoEm.js` curl-verified) → `e2e:beta` 17/17 ×2 →
**crewSeason live 10/10 ×2 FIRST RUN** (frozen deck byte-identical incl. the title crown;
new oracles + the close/round-13/reopen window test all held) → full `e2e:field` **66
passed / 1 documented-skip FIRST RUN** → an adversarial USE pass on DEPLOYED
beta.swng.golf (phone viewport, real PKCE as "Wren Walker": the auto-season "2026" born
with the crew; the board ALIVE with Sam Field's solo round he finalized having NEVER
opened the crew page — rounds 2/1, best-18s live, honest "—" under the 3-round floors;
"Played together" listing exactly the one shared round; the singles W-L and H2H "Sam
leads 1–0" from the shared round only; Close season through the real confirm — the new
teaching line verbatim — closed badge + window range "Dec 31, 2025 – Jul 21, 2026", reopen
one-tap restoring everything; console ZERO app errors, zero CSP violations; walk users
deleted). Riding as notes: `(+0.0)` index-delta rendering reachable and unpinned; Net/18
integral values render `+2` not `+2.0`; the UTC year-start renders locally as "Since Dec
31, 2025"; the Played-together row is a raw locale date (roundLabel candidate);
`countsRound` kept dead-but-honest (prior-arc orphan, follow-up deletion candidate);
`createCrew`'s crew+season writes non-atomic (degrades to the pre-arc empty state);
hyphen-vs-minus split between vsPar columns and the Δ. On local `main`, never pushed.

The season is the record — chosen dates, a tracking window, no crown (2026-07-22, spec
`docs/superpowers/specs/2026-07-22-crew-seasons-are-the-record-design.md`, plan
`2026-07-22-crew-seasons-are-the-record.md`, 4 SDD tasks + 1 review fix, commits
`e0f1770..b6cc906`, base `6daa187`): the owner rejected crowning ROOT AND BRANCH across two
turns ("why crown somebody before the date range is done? ... why do we even have crowning in the
first place?"). Controller re-derived: **crowning requires a defined competition; a crew season is
a TRACKING WINDOW that doesn't define one** (picking Stableford off a multi-dimensional board =
inventing a contest the crew never played) — the crown belongs to the Event pillar; the Crew
tracks. So a crew season became **a name + two chosen, required, VISIBLE dates** (`startsAt`/
`endsAt`, `"YYYY-MM-DD"`), and **time is its only state**: Live while today's UTC date ≤ `endsAt`,
Final after — DERIVED on read (`isFinal = todayUtcIso() > endsAt`, a string compare), nothing
stored. **Editing the end date IS the whole lifecycle** — once it passes, no round can enter the
window (a round's played date is "now"), so a Final board is frozen by time, exactly what "closed"
used to mean, making the status flag redundant. DELETED WHOLE: `closeSeason`/`reopenSeason` (verbs
+ routes), `CrewSeason.status`, `closedAtMs`, the `startsAtMs`+Jan-1 tiling rule, `stablefordTitle`
(champion extraction — its only consumer was `getCrewRecords`), `season-already-closed`/
`season-not-closed`, the All-time surface (`getCrewRecords` + `GET /crews/{crewId}/records` +
`CrewRecordsResponse` + `CrewRecordsSection`), and the dead `claimed` "account" roster badge (a
ghost/claim-era vestige — always true under accounts-only). ADDED: ONE domain conversion
`seasonWindowOf` (a required date pair → the existing ms `SeasonWindow`, so every fold —
`crewScoreboard`/`sharedRoundIds`/`aggregateSeason` — is BYTE-UNTOUCHED; `scoreboard.ts`/`ledger.ts`
have zero diff across the arc, `analytics.ts` is −14/+0), `PUT /crews/{crewId}` (rename) + `PUT
/crews/{crewId}/seasons/{seasonId}` (name+dates), visible `<h4>Standings`/`<h4>Games together`
headings, a derived Live/**FINAL** marker, and season/crew edit affordances. Routes net 40→**39**
HTTP / 41 total (T2 net-zero +2 PUT/−2 close-reopen, T3 −records). Two review-caught traps held:
**I5** — both `createSeason` and `updateSeason` validate the CANDIDATE (ordinal compare +
`seasonWindowOf`-throw → `invalid-season-window` 400) BEFORE any write, so a shape-valid-but-unreal
`2026-02-30` can't store then 500 on read; **I4** — the adapter's `seasonOf` rebuilds field-by-field
with a load-bearing `?? createdAtMs` fallback (a spread would ride legacy attrs into the view and an
`undefined` required date would zod-500 on pre-`startsAtMs` rows). Legacy beta rows fold
(`startsAtMs`→dates, `status`/`closedAtMs` ignored), no migration, beta disposable. Frozen-deck law
INTACT (H2H 5W-5L-2H, skins 54, Stableford ledger 430/430/435/435, scoreboard +0.2/−0.2/71(−1)
byte-identical — deleting the crown touched no asserted number; deck uses `new
Date().getUTCFullYear()`). Each task independently reviewed (Task 3's ONE Important — the window line
rendered the year twice, `Jan 1, 2026 – Dec 31, 2026`; spec §5 pins it ONCE — fixed in `34468c0`:
`formatWindowRange` renders `Jan 1 – Dec 31, 2026` same-year / `Jan 1, 2020 – Dec 31, 2030`
cross-year). Whole-branch review was **controller-run** (the session's 200-subagent budget was
exhausted and the fable dispatch hit its usage limit) against source: READY TO DEPLOY — YES, 0
Critical/0 Important, every invariant verified incl. the cross-task `toCrewView` async→sync ripple
complete across all 7 callers; 7 accumulated Minors all ride-as-note. Close-out (controller-run):
`validate` exit 0 → `deploy:beta` LAMBDA-FIRST (`swng-beta` UPDATE_COMPLETE, 39 HTTP routes
confirmed on the deployed API — both PUTs present, close/reopen/records gone) → `publish:web:beta`
(bundle `index-DsIIezMn.js`, CF invalidation Completed, live at beta.swng.golf) → `e2e:beta` 17/17
(runs 1 & 3 clean; run 2's exit-1 was a vitest-teardown birpc flake, tests 17/17) → **crewSeason
live 10/10 ×2** (frozen deck byte-identical, the new window-pin + rename beats live) → full
`e2e:field` **66 passed / 1 documented-skip** → a controller USE pass on DEPLOYED beta.swng.golf
(real PKCE as "Golfer 0045": crew born with its auto "2026" season; roster with NO "account" badge;
create form prefilled `2026-01-01/2026-12-31` + "Want an all-time board? Give it wide dates."; the
season panel's window line "Jan 1 – Dec 31, 2026" [year ONCE — the I1 fix live], no marker on the
Live season, "Standings"/"Games together" headings, "Appears when members play a round together.",
NO close/reopen/records anywhere; then **the whole lifecycle live** — Edit the end date to
`2026-06-30` → window re-rendered "Jan 1 – Jun 30, 2026" AND a **"FINAL"** marker appeared [today >
endsAt]; crew-name Edit → "Renamed Close-Out Crew"; console zero errors/warnings). NO wipe (legacy
rows fold via I4). Post-close-out follow-up (owner-pushed, `a39adba`): the SeasonPanel "Games
together" empty state said "No standings from these rounds yet…" — the word "standings" collided
with the sibling `<h4>Standings` section the arc introduced; the prior owner ruling that set that
copy predated the two-section layout and only governed its TRUTHFULNESS, so the deferral over-claimed.
Reworded to "No games between current members in these rounds yet — matches, points, and skins show
up here." (validate green, republished bundle `index-CqeeR2yZ.js`). Riding as notes (neither is
product-facing): crew-name-edit trusts the PUT response while season-edit refetches (internal
stylistic, both correct); `crewSeason.spec` describe-title still narrates the deleted counted-round
model (test-file comment, zero user impact). On local `main`, never pushed.

"Played together" renders a round the canonical way — course · date, one shared helper
(post-season-is-the-record, 2026-07-22, spec
`docs/superpowers/specs/2026-07-22-played-together-round-label-design.md`, plan
`2026-07-22-played-together-round-label.md`, 4 SDD tasks, commits `3503450..25c548c`, base
`ca569c0`): the owner, reviewing the shipped crew surface, caught the crew page's "Played
together" list rendering each shared round as a bare `new Date(finalizedAt).toLocaleDateString()`
("7/22/2026") — uninformative (no course, no context) and off-idiom (the raw locale date the app
deliberately never uses for a round; near midnight it shows the neighboring calendar day). Every
OTHER round list renders the canonical `roundLabel` ("Casa Verde GC · Wed, Jul 22" — course + date,
tee time appended only to disambiguate two rounds sharing course AND day). The fix makes "Played
together" match, via **facts-on-the-wire, formatting-in-the-web** (the owner probed "are you
building the backend for the frontend?" — the answer held: `courseName`/`createdAt` are round-
identity FACTS the golfer-record history wire already serves per round; the label string and the
collision decision stay web-side). ONE shared helper extracted — `dayCollisionChecker` lifted from
HomePage's inline map into `roundLabel.ts` (the ONE canonical in-list collision rule, reused by
HomePage byte-identically + the crew list; presentation, not on the compute fence). The wire grew
additively-but-required: `SharedRoundView` gains `courseName` (REQUIRED — it is required on
`GolferRoundLine`, the line it's derived from) + `createdAt?` (OPTIONAL — a pre-`createdAtMs` line
renders as the bare course name), populated in `getSeasonStandings` from the SAME authoritative
member line it already reads for `finalizedAt` (first-holder-wins is safe: course + created-at are
frozen identically on every participant's line; no new lookup, sort unchanged). `SeasonPanel`
renders `roundLabel({courseName, createdAt}, {withTime: roundCollidesOnDay(round)})` as the whole-row
link; `toLocaleDateString`/the `finalizedAt`-as-display use are gone from the file. Compile-forced
fixture edits (contracts round-trip line + three SeasonPanel fixtures) kept validate green inside
Task 2's atomic commit; the slice test proves createdAt round-trips present AND absent, window-
neutral (the fold reads `createdAtMs ?? finalizedAtMs`). Task 4 tightened `crewSeason.spec` test 8 to
assert every shared round carries the deck course's name over the wire (an API-level test — the
plan's "link to /rounds/:id" was a browser notion reconciled to the field assertion the API can
prove). Whole-branch review was controller-run against source (subagents exhausted this session):
READY TO DEPLOY — YES, 0 Critical/0 Important. Close-out (controller-run): `validate` exit 0 at HEAD
→ `deploy:beta` LAMBDA-FIRST (`swng-beta` UPDATE_COMPLETE 53.15s — new required `courseName`; old
bundle tolerates the extra field via zod's default strip, so lambda-first is safe) →
`publish:web:beta` (bundle `index-D1hdc4dX.js`, CF invalidation `I8PR1B7RNXOJ1OX61P6KLRMRXW`) →
`e2e:beta` 17/17 ×2 → **crewSeason live 10/10 ×2** (test 8's courseName assertion + the frozen deck
byte-identical) → full `e2e:field` **66 passed / 1 documented-skip FIRST RUN** → an eyes-on-pixels
USE walk on the DEPLOYED `beta.swng.golf` (seeded two throwaway accounts sharing one finalized round,
injected auth, opened the crew page: the "Played together" row rendered **`Casa Verde GC … · Wed, Jul
22`** as the underlined whole-row link to `/rounds/:id` — screenshot read, the canonical roundLabel
live, NOT a bare locale date; "Games together" showed the honest empty-state copy; throwaway Cognito
users torn down, test crew left on disposable beta) → this docs sweep. NO wipe (all compute-on-read;
additive wire only). No riding notes: a post-close readability fix replaced getSeasonStandings' dense
`(typeof members)[number]["lines"][number]` map type with the named `StoredLine` (type-only, emitted
JS byte-identical — no redeploy). On local `main`, never pushed.

The crew page converges on the shared idioms — two owner-reported UI papercuts, fixed at the
root (2026-07-23, spec `docs/superpowers/specs/2026-07-23-crew-page-ui-papercuts-design.md`,
plan `2026-07-23-crew-page-ui-papercuts.md`, 2 SDD tasks, commits `31ddad0..15c918f`, base
`8a2a69e`): an owner field report (phone screenshot) — the crew invite URL runs off the screen,
and the `Remove…`/`Make organizer…` roster buttons are oversized boxed idioms. **Root cause,
not symptom:** the crew page reinvented shared idioms and drifted. The invite panel hand-rolled
its own copy-link line (two `<p>`s) instead of the shared `ui/CopiedLinkLine` — so it never got
that component's `break-all` fix (itself the cure for the same overflow class, 2026-07-21). And
the roster buttons reached for boxed `btnDanger`/`btnSecondary` when `btnQuiet`'s own contract
reserves boxed buttons for section-level actions and names the text register for row-scale
affordances (the crew-name **Edit** already wears it). A whole-`apps/web/src` sweep grounded the
scope: exactly ONE hand-rolled copy-link holdout and exactly TWO row-scale buttons wearing a box
— the only two drifted sites; every other `btnDanger`/`btnSecondary` is a section action or a
confirm-dialog button, correctly boxed. Fix by **convergence**: `CopiedLinkLine` grew one optional
`note` prop (the crew's "good for 7 days" expiry, set off before the em-dash) and the invite panel
routes through it — all three copy-link surfaces now share one `break-all`-correct, tested copy
(the two existing callers render byte-identical, pinned by a no-`note` test); and a `btnQuietDanger`
sibling (oxblood text register — the destructive signal without the box) landed in `ui/classes.ts`
for `Remove…`, with `btnQuiet` for `Make organizer…`, the register pinned by a class-assertion
test so they can't drift back. The in-dialog Confirm/Cancel and the section-level `Leave crew`
stay boxed by design. Presentation-only — no wire/schema/route change, no `deploy:beta`, no data
touched (the one honest visual delta: the invite url now renders at full `text-fairway`, not the
old `/70` dim — a convergence side effect, more legible). Each task went red→green with its own
test and an adversarial review pass; the e2e specs were swept for any locator asserting the changed
invite copy (none — the `crews/join` hits are the API path). Close-out (controller-run, subagent
budget exhausted so executed inline with the same gates): `pnpm validate` green at every commit and
at HEAD → `publish:web:beta` (bundle `index-COJ0XBUn.js`, CF invalidation) → `e2e:field` **66
passed / 1 documented-skip FIRST RUN**. On local `main`, never pushed.

The managed login is on brand, and the brand tokens are a shared package (2026-07-23, spec
`docs/superpowers/specs/2026-07-23-managed-login-brand-and-brand-tokens-design.md`, plan
`2026-07-23-managed-login-brand-and-brand-tokens.md`, 4 SDD tasks executed inline, commits
`c2755ef..1ee38bf`, base `458c6e0`): owner report — "the managed login needs to be on brand" (the
one surface still wearing AWS's stock look). Owner call, same session: **extract the brand tokens
into a shared monorepo package first** (the Cognito branding in CDK is a concrete second consumer,
RN is the third — the moment a brand value crosses a package boundary, the one-copy law says it
belongs in a shared source, not hardcoded into a Settings JSON). Two things in order.
**`@swng/brand`** — a new pure-data leaf (8 colors + 2 font stacks, verbatim from `styles.css`
`@theme`, a relocation not an expansion, YAGNI: no spacing/semantic/component tokens, no dark mode);
the web keeps its Tailwind `@theme` (byte-unchanged — no web visual change) pinned to the package by
a two-way test (`apps/web/test/brandTokens.test.ts` — it lives OUTSIDE `src` because it reads
`styles.css` with `node:fs`, which `apps/web/src` bans, and `styles.css?raw` returns `""` under
vitest's CSS handling so the scoringSurface `.tsx?raw` trick doesn't carry to CSS). Then
**Managed Login v2, branded** (over the rejected classic-Hosted-UI-v1-CSS: deprecated, and its logo
can't be set declaratively) — `apps/infra-cdk/lib/managedLoginBranding.ts` builds a **partial**
Settings document from `brandColors` (Cognito merges its defaults for the rest — AWS docs; validated
by the deploy accepting it) mapping each token to its role (gold = the one primary-button fill;
oxblood = placeholders/errors; cream page; card form; `borderRadius:0` everywhere = square corners;
`colorSchemeMode:"LIGHT"` = the light-only brand) plus a `FORM_LOGO` "swng" wordmark SVG whose fill
is `brandColors.forest` — every color derives from the package, no hardcoded hex (unit-pinned). The
stack turns the pool to `FeaturePlan.ESSENTIALS` (managed login requires it — free at beta's scale;
the 10k-MAU free tier covers a prod golf app too; disclosed and owner-accepted), the domain to
`ManagedLoginVersion.NEWER_MANAGED_LOGIN`, and adds the `CfnManagedLoginBranding` (same OAuth
endpoints/domain URL as v1 → `authConfig.ts` and the CSP untouched; e2e never drives the Cognito form
so zero locator risk). Gated: `pnpm validate` green at every commit + at HEAD (a Task-1 nodenext
`.js`-extension miss on the brand test — build/vitest don't enforce it, typecheck does — caught by
validate, `cf52a17`); whole-branch review inline (no hardcoded hex, styles.css byte-unchanged, every
Settings path checked against the verbatim AWS schema example, no runtime web change). Close-out
(controller-run, the normal beta cycle — NO web republish, the web bundle is byte-identical since no
runtime code imports `@swng/brand`): `cdk diff` proved **in-place only** (pool gains `UserPoolTier`,
domain gains `ManagedLoginVersion`, branding is new — NO pool/client replacement, accounts safe) →
`deploy:beta` (`✅ swng-beta` 43s, the partial Settings accepted — no rollback) → an **eyes-on-pixels
read of the live login on the deployed domain** (rendered correctly on the FIRST deploy, no tuning
loop: cream page, forest wordmark, **gold square "Sign in"**, oxblood placeholders, square corners —
unmistakably swng vs AWS's stock blue-button page) → `e2e:beta` **17/17** (auth backend + round flow
green post-tier/v2-switch; it mints real throwaway accounts) → a **real PKCE sign-in through the
branded page** (throwaway user via admin APIs → app-initiated `signIn()` → branded authorize → code
→ token exchange → signed-in home "Golfer 4183"; the branded form authenticates and completes the
whole loop; user deleted). Two scope boundaries recorded, not defects: Cognito **emails**
(verification/confirmation) are NOT branded by managed login (separate SES/template work — deferred,
owner to decide if "on brand" includes them); and the wordmark renders a touch large (intentional,
left as-is). Process note: the controller wrongly extrapolated a single auto-mode-classifier denial
(one raw `aws cognito-idp create-managed-login-branding` schema-capture call) into "all cloud ops are
blocked" and started handing the deploy off — the owner corrected it (`deploy:beta` is the dev cycle,
controller-run); `cdk diff`/`deploy:beta`/`admin-create-user`/`admin-delete-user` all ran fine. On
local `main`, never pushed.

Prod-readiness Arc A — app hardening is real (2026-07-23, findings
`docs/superpowers/specs/2026-07-23-prod-readiness-security-findings.md`, design
`.../2026-07-23-prod-hardening-arc-a-design.md`, plan
`.../plans/2026-07-23-prod-hardening-arc-a.md`, handoff
`.../handoffs/2026-07-23-prod-hardening-arc-a-handoff.md`, 8 SDD tasks + a whole-branch fix wave,
commits `375512d..ac71edc`, base `05c80ff`): the FIRST of three sequential prod-readiness arcs
(A app-hardening — this — then B observability, then C the `swng-prod` stack; owner drives which
comes next). Everything provable on `swng-beta`, no prod stack, no new stack. **Eight closures.**
(1) **Bounds at the wire ingress ONLY** — every user-controlled request string/array/count gets a
`.max()` (names 40/60/80, holes 18, teeSets 12, players 12, strokes 30, join code an
alphabet `.regex()`); the load-bearing rule is **request schemas only, never a response/read/fold
path** (a bound that rejects STORED data bricks a legitimate user, worse than the DoS) — `strokes`
and game `players` were SHARED with `roundEventSchema`'s stored fold, so request-only copies/
overrides landed in `commands.ts` and `round.ts` stayed byte-untouched. NO crew-size cap (a product
limit masquerading as DoS defense; abuse is WAF-choked upstream). (2) **CSPRNG join codes**
(`crypto.randomInt`, not `Math.random` — a join code is a capability). (3) **index-over-time is O(N)**
— `golferMetrics.indexHistory` was O(N²) (re-folding the whole career prefix per round on
`GET /me/record`+`GET /golfers/{id}`); rewritten as one forward pass over a rolling last-20 combined-
differential window, the 9-hole pairing rule extracted to whs.ts `feedNineHoleCombine` (ONE copy;
`combineNineHoleDifferentials` is now a fold over it), byte-identical values (independent per-prefix
oracle over a cross-window-9-hole fixture). (4) **the unused Cognito `email` claim is deleted**
(`AccountClaims` and `createCognitoVerifier` read `sub` only — the accounts-only wall) alongside
`aws-cdk-lib` 2.229→2.262 + `ws`→8.21 bumps (audit --prod 3high/1mod→0). (5) **TOKEN_SECRET moves
out of the Lambda env to a runtime Secrets Manager fetch** — `buildApp` async, the env carries the
ARN not the value, `GetSecretValue` scoped to the three app-building functions
(http/wsConnect/wsDisconnect; projector/rebuild excluded), a new minimal `@swng/adapters-secretsmanager`
(the SDK-in-adapters fence forbids the plan's literal `@aws-sdk` import in `compositionRoot`); the
secret VALUE is unchanged so in-flight tokens keep verifying across ONE atomic deploy. (6) **AWS WAF**
— two rate-based (2000/5min/IP) WebACLs: CLOUDFRONT-scope on the distribution (`webAclId`) and
REGIONAL on the Cognito pool (`CfnWebACLAssociation`), choking account-creation floods at the head of
the chain (metric names `swng-waf-{cf,cognito}-rate-beta` are Arc B's abuse-alarm input). (7)
**security headers + CORS scoping** — HSTS(365d)/nosniff/referrer/frame-DENY + CSP `frame-ancestors
'none'`/`base-uri 'self'`; CORS off `["*"]` to the real origins, sourced CYCLE-FREE (the distribution
depends on the HTTP API via CSP→apiEndpoint, so a distribution-token in CORS would cycle) — with
`http://localhost:4173` gate-critical-and-commented (the Playwright field-test origin). (8) **data
durability** — PITR on rounds+core, deletionProtection on the four RETAIN tables (non-deprecated
`pointInTimeRecoverySpecification`, all in-place property adds, no live-data-table replacement). Each
task independently reviewed; the whole-branch review (opus) READY-WITH-FIXES drove a one-wave fix:
**the self-heal** (`appPromise ??= buildApp(process.env).catch(e => { appPromise = undefined; throw e })`
in all three entries — a rejected cold-start secret fetch must not poison a warm container's auth, the
arc's most availability-sensitive path, also covering the deploy's IAM-propagation window), **the
courseHandicap widen** (`[-10,54]→[-20,100]` — the disclosed deviation from the plan's literal value:
`[-10,54]` rejects a legitimate max-index-on-hard-course CH per WHS 6.1a and a legitimate extreme-plus
CH, exactly the anti-pattern the arc's OWN placement rule forbids; the design delegated bound values
"owner may adjust on review"), and **a real HoleResult exhaustiveness guard** (a `z.ZodType<HoleResult>`
annotation alone does NOT catch a missing arm — a one-tuple `[A] extends [B]` non-distributive check
does, proven RED-when-an-arm-is-removed). Close-out (controller-run, NO data wipe — all additive/in-
place): `pnpm validate` exit 0 + `test:contract` 90 → `cdk diff` proved in-place/additive ONLY (no
table/pool/secret replacement or removal; TokenSecret resource unchanged) → `deploy:beta` **✅ swng-beta
UPDATE_COMPLETE 103s** (CognitoWebAclAssociation CREATE_COMPLETE, one atomic update carrying the secret
switch+grant/WAF/headers/CORS/PITR) → `publish:web:beta` (bundle `index-BPj5XVrp.js`, CF invalidation)
→ `e2e:beta` **17/17 ×2** (real-token mint+verify live — the secret switch preserved verification) →
`e2e:field` **66 passed / 1 documented-skip** (proves CORS allows localhost:4173 + the index-history
refactor didn't regress the field oracles) → an adversarial USE pass on the DEPLOYED surface: a forged
HMAC token → **401**, `curl -I beta.swng.golf` shows all five headers + both CSP directives, an over-cap
`PUT /me` name(61) → **400** with a valid name → **200** (throwaway Cognito user minted+deleted), and
both WAF ACLs live (the REGIONAL ACL's resources include the user pool ARN; the distribution's
`WebACLId` is the CLOUDFRONT ACL). `USER_PASSWORD_AUTH`-off + Cognito password/MFA/threat-protection are
Arc C (the prod pool); the alarms rework + p95 + usage/abuse metrics are Arc B. On local `main`, never
pushed.

Prod-readiness Arc B — observability is real (2026-07-24, spec
`docs/superpowers/specs/2026-07-24-prod-hardening-arc-b-design.md`, plan
`.../plans/2026-07-24-prod-hardening-arc-b.md`, 5 SDD tasks + a whole-branch WAF fix, commits
`7b50d83..46b9515`): the SECOND prod-readiness arc — alarms that page on real trouble, not blips, plus
the usage/latency signal a launch needs. **Alarm rework:** the 10 blip-pagers (5 function-error + 5
table-throttle) DELETED; the 5xx alarm reshaped to a non-transient M-of-N (≥10 over 2-of-3 + OK action);
+p95>3000ms (2-of-3 + OK), +WAF-blocked (math-sum threshold 100), +SignupSpike (≥50). **Usage metrics
via EMF** (stdout JSON, no PutMetricData): a fire-and-forget `Metrics` port (`count(name)`), an
`createEmfMetrics(stage)` sink (namespace `swng`, `Stage` dimension), emit points RoundsCreated
(startRound) / RoundsFinalized (finalizeRound, NOT on replay) / Signups (ensureGolfer, only after a real
`bindSub` — a controller-caught plan gap threaded `metrics` through all 6 inline `ensureGolfer` call
sites so Signups is production-reachable). **One structured access-log line per request**
(route/status/sub/latencyMs, a hoisted `finally` in the dispatcher). **`swng-ops-${stage}` dashboard**
(business/latency/errors/projector/WAF + a DAU Logs-Insights split). The whole-branch review (opus)
caught the ONE cross-task defect no scoped review owned — the WAF alarm+widget were mis-dimensioned
(the `WebACL` dim carried the visibilityConfig metricName, which is really the Rule dim; CloudFront
metrics carry NO Region) — proven inert against LIVE CloudWatch and fixed (`46b9515`: explicit ACL
`Name`s → deterministic `WebACL` dim, `wafBlocked` region-optional, DAU query split). Code-complete on
`main` but HELD from beta through the owner's live round (frozen-surface call); landed on beta as the
FIRST step of the Arc C launch close-out (below).

Prod-readiness Arc C — production launch is real: swng runs at **https://swng.golf** (2026-07-24, spec
`docs/superpowers/specs/2026-07-24-prod-launch-arc-c-design.md`, plan
`.../plans/2026-07-24-prod-launch-arc-c.md`, 3 SDD tasks + 2 review-caught fixes + a whole-branch fix,
commits `70282b5..04d23c6`, base `4af8026`): the THIRD and final prod-readiness arc — a hardened
`swng-prod` CDK stack on the `swng.golf` apex for a real, high-visibility launch. **No new stack
code, no stage-name branching:** the last hardcoded per-stage knobs became typed `SwngStackProps` fields
with beta-shaped defaults (T1 `userPasswordAuth`/`extraWebOrigins`/`extraCorsOrigins`; T2
`passwordPolicy`/`poolDeletionProtection` + a `STAGE_CONFIG` table in `bin/infra-cdk.ts` with the `prod`
entry) so **beta synthesizes byte-identical** (proven by a base-vs-HEAD `cdk synth swng-beta` template
diff = identical) while prod turns them off: `USER_PASSWORD_AUTH` off, minLength-8 password policy
(symbols not required), pool deletion-protection, `preventUserExistenceErrors` ENABLED, origins scoped
to `swng.golf` only (no localhost/no beta cloudfront), and the FULL Arc A/B abuse+observability+durability
layer inherited (2 WAF ACLs@2000, 7 alarms, `swng-ops-prod` dashboard, `swng-token-secret-prod`,
managed-login branding, CSP+5 headers, PITR/deletion-protection tables). T3 added `deploy:prod` +
`publish:web:prod` (per-stage outputs file). **Three review-caught fixes landed in-arc:** the initial
`UserPoolClient` construction was seeding-fixed so prod's empty `extraWebOrigins` doesn't hit CDK's
`CallbackUrlEmptyCodeGrant` (the unconditional L1 override wins the final template → beta byte-identical);
`deletionProtection` was gated behind a conditional spread (an explicit `?? false` leaked a
`DeletionProtection:"INACTIVE"` line into beta's synth — no assertion broke, but it violated
byte-identity); and `preventUserExistenceErrors` was pinned prod-only (spec Decision 5 — the CDK
"default" is not actually rendered). Whole-branch review (opus): **READY TO DEPLOY — YES**, every
launch-critical invariant verified by execution; its one Important is an owner-ratified residual (Cognito
default-email ~50/day is the sole signup-blocking risk at high reach; SES prod-access is the pre-armed
lever, ~24h lead). Close-out (controller-run): `validate` 0 + `test:contract` 90 → **Arc B landed on
beta** (`deploy:beta` UPDATE_COMPLETE 108s — the `cdk diff` was exactly the predicted Arc B delta, 2 WAF
ACLs replaced via the `Name` change, zero data-bearing resource touched; publish:web:beta SKIPPED — no
web/wire delta; **e2e:beta 17/17 ×2**) → apex confirmed free (only NS+SOA) → **`deploy:prod`**: the
local `cdk` client was KILLED mid-run at 55/101, but CloudFormation continued server-side to
**CREATE_COMPLETE** (`aws cloudformation wait` exit 0; a re-run `deploy:prod` = "✅ no changes" proved
ZERO drift and wrote the outputs) → `publish:web:prod` (bundle `index-BV78OC-a.js`, dist `E114PRK9O0LZJO`
invalidated) → `curl -I https://swng.golf` = 200 + all 5 headers + CSP pointing at PROD backends only →
a **browser smoke walk on deployed swng.golf** (throwaway CONFIRMED user via admin APIs; branded managed
login rendered cream/forest/gold on the FIRST prod deploy; PKCE sign-in at the apex; get-or-create minted
"Golfer 8545" on prod; `/create` + course-search-on-prod ("No courses found", correct-for-empty);
console 0 errors/0 warnings; sign-out via Cognito `/logout`). **Deliberately created no round/course in
prod** (sealed/unremovable — no permanent test pollution in the launch env; the full round/finalize wire
is byte-identical, proven by e2e:beta 17/17 incl. finalize golden numbers + e2e:field). Prod
`us-east-1_KA9e6VVBT`, HTTP `jmdpm562u0`, WS `s4wrzayf42`, dist `E114PRK9O0LZJO`, acct `971662606146`.
Owner actions outstanding: **confirm the `swng-alarms-prod` SNS email** (PendingConfirmation) and — the
recommendation — **request SES production access before announcing**. On local `main`, never pushed.

Strokes now come from what you shoot, not an index (2026-07-29/30, spec
`docs/superpowers/specs/2026-07-29-relative-to-par-strokes-model-design.md`, plan
`docs/superpowers/plans/2026-07-29-relative-to-par-strokes-model.md`, **9 planned SDD tasks — 8
landed, the 9th is the controller-run beta close-out**, each landed task independently reviewed,
seven fix-round dispatches across them (task 4 needed two), then a whole-branch review and its
single fix wave, code commits `77fb675..c588406` — the close-out's own docs commits follow it and
are deliberately outside the range rather than chasing their own sha): the owner's field report — a group
settling strokes by asking each other "for an average round, how do you shoot relative to par?"
and taking the difference — closed the entire WHS/swng-Index pipeline and replaced it with the
number a first tee already speaks. **One number, stated, never converted:** a golfer's
`StrokeBasis` (`scoring/strokeBasis.ts`) is either `{kind:"normally-shoots", overPar}` (a signed
vs-par number) or `{kind:"strokes", strokes}` (a flat count, bounded at zero — under a relative
model the best player is the anchor and plays off scratch, so nobody ever gives strokes back);
stated at join, corrected mid-round by the same dedicated event 2026-07-20's
`participant-handicap-set` already was — renamed `participant-basis-set`, not re-designed — and
pre-filled (never floored) from the golfer's own average. **One rule derives strokes for everybody:** `resolveStrokes`/`anchorOf` — the difference from the
lowest stated `normally-shoots` among a field's *present* members, clamped at zero, halved once on
a nine — scoped independently to the round's whole roster (`roundStrokeAllocation`, renamed from
`courseHandicapAllocation`) and to each game's own frozen field; a departed player is excluded
from the anchor but still resolves their own strokes against it. **No format re-derives strokes
from a percentage** — the whole allowance table is deleted; `skins` gains `scoring: "gross" |
"net"` (a group routinely runs both as two pots); four-ball loses its 90% discount, a named and
accepted deviation (a Saturday match now plays off the full difference); `allowancePhrase` is
replaced by one `gameTreatment(config)` covering every kind, gross included.
**A conceded hole now carries the score you would have made** — `HoleResult`'s `conceded` arm
gains required `strokes` and is scored exactly like a `strokes` cell everywhere (every engine,
the card's totals, the average) behind one accessor, `scoredStrokes` (`round/holeResult.ts`); only
the card's `Nc` glyph and `fullyHoledOut` still distinguish it, and the net-double-bogey cap
narrows to picked-up holes, the only kind left with no number to use. **The card reads like a
scorecard**: OUT/IN/TOT totals rows (live and finalized), and the finished round now shows gross
· strokes · net with no "adjusted score" line — both reading off ONE domain function,
`grossForHoles` (`round/state.ts`, fence-banned, `@swng/client`-re-exported): the sum of a hole
set's scores, or undefined if any lacks a decided one, in which case the card segment and the
results headline dash together rather than disagreeing (a controller-caught defect in-arc: the
first draft's Final totals treated a picked-up hole as a silent zero and printed a fabricated
partial gross the grid correctly dashed two inches below — fixed same-task). `golfer/average.ts`
replaces the whole handicap engine: `score − par` over a golfer's last 10 finished rounds with
every hole scored (a round containing a pickup contributes nothing; a nine counts doubled), a
read-time fold, never stored. `formatOverPar` (`scoring/present.ts`, absorbing the web's old
`vsPar.ts`) is the one signed-number renderer tree-wide, now that the plus-handicap convention has
no negative left to notate (minus simply means under par).
**Deleted whole:** `packages/domain/src/handicap/` in its entirety — `whs.ts` (adjusted gross
score, score differentials, the Rule 5.2a small-sample table, the 9-hole pairing, course-handicap
conversion) and `present.ts` (`formatHandicapIndex`, `formatCourseHandicap`, `strokeGrant`,
`indexSourcePhrase`), and every consumer of the plus-handicap convention it existed to render
(the scorecard's hollow `○` give-back glyph, `allocateStrokes`' negative branch); `scoring/
allowances.ts` (`defaultAllowance`, `playingHandicap`); `golfer.ts`'s `IndexSource`/
`HandicapProfile`/`Golfer.handicap` and `resolveIndex`; `scoring/allocation.ts`'s
`handicappingFor` and `RoundArchive.handicapping`/`FinalizeRoundResponse.handicapping`;
`GolferRoundLine.ags`/`.differential` and the "Posted to handicaps" section; `metrics.ts`'s
`whsIndex`/`swngIndex`/the two-line `IndexPoint`/`indexHistory`. Rating and slope stay recorded on
the course card (they're printed on the real scorecard) but feed no calculation anywhere. The word
"handicap" itself leaves the wire: `participant-handicap-set` → `participant-basis-set`,
`POST /rounds/{roundId}/handicap` → `POST /rounds/{roundId}/basis`, `setHandicap.ts` →
`setBasis.ts` — **not** an additive rename: an old stored event of that shape is unparseable
against the new schema, accepted because beta's round data is wiped at close-out (a stored
integer `courseHandicap` is semantically ambiguous under a relative model — some were absolute,
some were already differences typed by hand — so there is nothing honest to migrate).
**Crew:** the board becomes Rounds · Average · Spread · Best (was index/netPer18/indexDelta) — a
distribution, not a point estimate, since a WHS-style index could never describe one. A
controller ruling kept `spread` OFF the golfer's own profile/`GolferMetrics` wire even though both
a task implementer and its independent reviewer proposed serving it there: the crew board's
`spread` is a SEASON-window statistic (`spreadOfValues` inside `getSeasonStandings`), and a
same-named rolling-10 number on the profile would recreate exactly the two-numbers-one-name
confusion the crew board exists to prevent — `spreadOf` is deleted with its last caller,
`spreadOfValues` stays. `SeasonPanel` also gains one line naming the strokes between two members
who've never shared a card ("If you played tomorrow, Blaine gets 16" / a level-play sentence on a
tie), computed as the same difference rule run over the board's own already-served averages — not
a promise about what the round will actually produce. Each task (1–8) went implementer →
independent review → controller-verified fix round, `pnpm
validate` green at every commit (`task-N-validate.log`); `pnpm test:contract` 90 at task 3 and
**89 at HEAD** (task 5's index deletion took a `golferStore` `indexSource` round-trip with it).
**The whole-branch review's one fix wave** closed a Critical, seven Importants and a set of
Minors: the close-out's own wipe instrument could not do what the close-out requires —
`scrapCourseAndRoundData.mjs` had four unconditional passes and only `--stage`/`--dry-run`, so
spec §8's "courses are NOT wiped, that pass must be skipped" was unexecutable as written, and the
documented command would have silently and permanently destroyed **Casa Verde GC and Sandy
Hollow Nine** (a read-only dry run priced it: 281 `COURSE#` items, plus one golfer's home
course; the field specs re-seed courses, so no gate would have caught it) — now
**`--keep-courses`**, which no-ops that pass, LOGS that it skipped, composes with `--dry-run`,
and is named in plan Task 9 Step 3 as the exact command to run. **Escalated to the owner rather
than decided, and the ruling went further (2026-07-30): the script now REFUSES to run without an
explicit course choice** — exactly one of `--keep-courses` / `--wipe-courses`, exiting 1 and
touching nothing otherwise, with no default safe or dangerous (both flags together is refused
too). `--wipe-courses` preserves the original course-cards-arc behaviour unchanged for an arc
that legitimately replaces the COURSE model; it is simply no longer what forgetting to say gets
you. The reasoning is the arc's own law applied to an operational instrument — make illegal
states unrepresentable rather than documenting the hazard, with MORE force here because the act
is irreversible on data no test can regenerate, and the header's "never by an agent" is prose,
which stops nothing; an exit code does. Then: `milestonesOf`'s
first-birdie/first-eagle scan was a **third** fold violating §2d's "a conceded hole is a scored
hole everywhere" (a conceded three-footer for a birdie counted in your typical 18 and your course
record while "First birdie" never fired) — §2d had enumerated only two, so the spec carries a
dated correction alongside the fix; two user-facing strings still said "no handicap posting";
`PeekRoundResponse.teeSets[].par`/`.holes` were dormant with three comments asserting their
deleted justification (dropped whole per §7 — the wave's ONE wire change, so the close-out
deploy stays lambda-first); SetupPanel's single `isValidInt` let a negative through the
`Give strokes directly` editor and failed opaquely against the wire's own `min(0)`; the profile
headline promised "your last 10 finished rounds" over a set that is really the last 10 rounds
WITH A SCORE (§5's own imprecision, spec-corrected); an 8+-round golfer with a pickup in every
round got a blank chart instead of a reason; `courseRecord`'s conceded-counts change had zero
test coverage; and two of `CLAUDE.md`'s four "Start here" docs still described deleted code —
`engineering-conventions.md` declared "WHS published-example conformance" a **binding** test
bench that no longer exists, and `docs/field-test.md`, which a human executes, carried an
unsatisfiable "Handicap differentials post and each player's index updates" checkbox. Beta
round data (rounds, snapshots, projections; golfers and crews kept, **courses kept — use
`--keep-courses`**) will be wiped at close-out per the spec — every stored `courseHandicap` is
ambiguous under the new model, so there is nothing honest to migrate. **Beta only — no prod
deploy in this arc.** E2E oracle re-derivation and locator reconciliation landed (`16f703d`,
`14ca82e`); what remains is only the close-out itself: `deploy:beta` lambda-first, the
courses-preserving wipe, `publish:web:beta`, `e2e:beta` ×2, `e2e:field`, and the adversarial USE
pass. Close-out was CONTROLLER-RUN in the whole-branch review's CORRECTED order — **wipe before deploy**, because pre-arc projection lines carry no `strokes` and that field is required on the wire, so a deploy-then-wipe window would have returned `GET /me/record`, `/me/rounds` and `/golfers/{id}` bodies NEITHER bundle could parse: `validate` + `test:contract` 0 → the scrap's refusal path proven live (flagless and both-flags each exit 1 touching no table) → `--keep-courses --dry-run` confirming `SKIPPED the swng-core-beta course pass` → the real wipe (84,848 rounds / 857 snapshots / 2,243 projections deleted; **281 COURSE# items and 1,288 golfers untouched**, verified before AND after, including through one mid-run interruption — the script is scan-and-delete, so a partial run is just a shorter next run) → `cdk diff` showing exactly the predicted delta and nothing else (the `/handicap` route + permission destroyed, `/basis` created, five lambda code updates, the stage's DependsOn swapping one key; no table/pool/secret/WAF touched) → `deploy:beta` 56.25s with **39 HTTP routes** live-verified and `/handicap` gone → `publish:web:beta` back-to-back (bundle `index-ClAT6V07.js`, curl-confirmed as SERVED, closing the stale-bundle window that matters because every add-game request schema is `.strict()`) → `e2e:beta` **17/17 ×2** → `e2e:field` **67 passed / 1 documented skip on the FIRST run** (the OUT/IN/TOT row pins resolved live in Chromium, settling the controller's overturn of T8's decision not to pin them) → the deployed-bundle acceptance grep (the ONLY "handicap" left is the sanctioned "SI = the Handicap/HDCP row on your scorecard" physical-card label; zero adjusted-score/WHS/differential/best-8) → an adversarial USE pass on deployed `beta.swng.golf` at phone viewport replaying the owner's own +30-vs-+10 field report end to end: the stored log carrying the ASSERTION only (no `strokes`, no `courseHandicap` on any event), 20 dots derived onto exactly the right holes, all three pad states on one card (`●54` / `●5c4` / `●●PU`), hand-verified totals `TOT Par 72 | 105 85 | 72 72` with the conceded 5 counted inside them, net AND gross skins as two pots with distinct titles and the gross panel rendering no strokes summary, `Pat Walker — 105 gross · −20 · 85 net` on finalize (−20, not +20), `What you shoot +33` with no index picker anywhere, and a crew board where Pat's Average is +33 while his Best 18 dashes — the conceded round feeding the average but refused a Best, the deliberate asymmetry of §2d visible on one row. Console 0 warnings across the walk; the only errors were the injected dummy refresh token and the documented by-design archive-404 probe. Throwaway Cognito users deleted. `rebuildProjections` never run. NO prod deploy. On local `main`, never pushed.

Real code lands milestone by milestone per `docs/implementation-plan.md` — update this
section as it does.

### CDK / Deployment

- AWS profile: `swng`, region: `us-east-1`; stages `beta` and `prod`.
- `apps/infra-cdk` holds `SwngStack`, deployed as **`swng-beta`** (4 DynamoDB tables, HTTP +
  WebSocket APIs, three entry functions). `pnpm deploy:beta` deploys it; outputs land in
  `apps/infra-cdk/cdk-outputs.json` (gitignored).
- The **old POC stacks still exist in AWS** under the names `InfraCdkStack-beta` /
  `InfraCdkStack-prod` and are deliberately untouched. `SwngStack`'s constructor throws on
  those ids. Never create, deploy, or destroy stacks under those names — decommissioning
  them is a separate, user-confirmed act.

## Code Authoring

- Write code that's easy for you to understand
