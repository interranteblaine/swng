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
