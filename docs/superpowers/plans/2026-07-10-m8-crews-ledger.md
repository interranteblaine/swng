# M8 — Crews & the Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the Saturday Boys exist — a persistent crew with a roster (ghosts welcome), a standing game, "play the usual" as one tap, and a season ledger + head-to-head records computed from real rounds — **plus the identity wave M7's field test demanded: signed-in golfers play as themselves** (create/join/add — no claiming in the primary flow, ever), the host can type Dave in from their own phone, and a crew ghost is ONE golfer all season (one claim adopts everything).

**Architecture:** `docs/architecture.md` §2 — Crew is a plain entity (no event sourcing): roster + standing-game preset on the `core` table; a round is a crew round via an optional `crewId` carried on the `round-created` event into the archive; ledger/H2H are rebuildable projections over archives, computed by the SAME `projectArchive` (one implementation, stream + rebuild). Ledger idempotence reuses M7's proven pattern: upsert one per-round contribution fact keyed by roundId, recompute season aggregates from the full list — never `+=`.

**Tech stack:** unchanged (no new dependencies).

## Global Constraints

- Work directly on `main`; `pnpm validate` green at every commit; TDD; comments why-only; conventions per `docs/engineering-conventions.md`; every commit message ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Layer law (lint-enforced): `apps/web` imports `@swng/client|contracts|domain` only; `domain` stays pure/zero-deps; `aws-jwt-verify` stays in `adapters-cognito` ONLY.
- `adapters-dynamodb` changes warrant `pnpm test:contract`; deploys touch ONLY `swng-beta` (profile `swng`, us-east-1), exactly ONE deploy, in Task 4; POC stacks `InfraCdkStack-*` are never touched.
- **Process law from M7's close (papercuts §4):** Task 7's gate MUST include the unmodified primary user path driven through the real browser UI (API shortcuts allowed only in steps that are not the thing being gated), and the controller personally flow-walks the primary paths before close.
- **Design decisions fixed by this plan** (do not relitigate; ⚑ = flagged for user veto at plan review):
  - **Play-as-yourself is M8 core, not a rider.** Signed in ⇒ StartRound/JoinRound carry YOUR `golferId`; the participant IS your account's golfer; finalized rounds land on your record with zero claiming. A signed-in user with no golfer yet gets one created from the form's name (the web calls PUT /me first, then creates the round with the returned golferId — one extra call, no new backend semantics). Claiming shrinks to its real job: adopting ghosts from rounds you weren't signed in for.
  - **Claimed-golferId reuse rule (extends M7 T5b):** presenting a CLAIMED golferId on create/join/add requires a valid Bearer whose `sub` matches that golfer's binding (403 `golfer-claimed` otherwise — same code as T5b). ⚑ **One deliberate exception: crew standing consent** — adding a crew MEMBER (claimed or not) to a round tagged with that crew's `crewId` is allowed without the member's Bearer; joining a crew (or being claimed into one) IS the consent to appear in crew rounds. Beta-grade like round-membership-was; M9's claim-challenge work revisits.
  - **AddParticipant is a participant-auth command** (any participant may add a player, matching the finalize/terminate rule), online HTTP like all game management; the added player holds no device/token — score-for-anyone already covers them. ⚑
  - **Crew ghosts have STABLE GolferIds**: a member is added once (name → minted golferId, or an account's existing golferId), and every crew round reuses that id. This — not merging — is what makes "Dave signs up in August and claims his whole season" true going forward.
  - **⚑ Stranded pre-M8 rounds are a recorded write-off.** Rounds played before sign-in (or before this milestone) whose ghosts differ from your one claimed/created golfer stay off your record; `GolferMerged` remains out of v1 (M7 ledger). Papercut 7 closes with this resolution stated honestly. (The user's own two finalized M7 rounds are in this set.)
  - **H2H v1 = singles matches only** (`kind: "singles-match"` results between a canonical `a<b` pair: win/loss/halve). Fourball contributes to wins/points in the ledger but partner records are deferred (product §6 lists them; they are additive projections later). ⚑
  - **Season = UTC calendar year of the archive's `finalizedAtMs`.** ⚑
  - **Standing game v1 = one saved preset per crew**: `{ courseId?, tee?, games: GameConfigInput[] }` whose player references are crew-member golferIds. "Play the usual" pre-fills round creation with the preset's course/tee/players/games, all editable before create; presets referencing members who aren't in the final roster are dropped game-by-game at apply time (a game survives iff every referenced player is present). Any crew member may edit the crew/preset (matches the any-participant spirit). ⚑
  - **Ledger idempotence pattern (INVARIANT beside the interface):** projector writes are (1) `putCrewRound` upsert keyed `(crewId, roundId)` holding that archive's whole contribution, then (2) season aggregates recomputed from `listCrewRounds` — commutative and duplicate-safe by construction; projecting the same archive twice is a no-op. Rebuild wipes crew projections and replays — identical results (the gate proves it, like M7's).
  - **Claim carries the roster name (papercut 5):** `ClaimGolferRequest` gains optional `name`; a claim that CREATES the lazy golfer row uses it (the client sends the roster row's name it has on screen); a claim binding an existing row never renames.

## File Structure

```
packages/domain/src/crew/crew.ts ledger.ts                      # T1: Crew/StandingGame types+invariants; crewContribution/aggregateSeason
packages/domain/src/round/events.ts state.ts archive.ts        # T1: round-created gains crewId?; state+archive carry it
packages/contracts/src/crews.ts commands.ts golfers.ts round.ts # T2: crew schemas; StartRound players/golferId/crewId; AddParticipant; claim name
packages/application/src/crews/*.ts ports/crewStore.ts          # T2: create/get/listMine/addMember/saveStandingGame
packages/application/src/rounds/{startRound,joinRound,addParticipant}.ts  # T2: as-self + claimed-arm + crew consent
packages/application/src/projections/projectArchive.ts ports/projectionStore.ts  # T2: crew extension
packages/adapters-dynamodb/src/createDynamoCrewStore.ts createDynamoProjectionStore.ts keys.ts  # T3 (+contract tests)
packages/lambda/src/http/{routes,dispatch}.ts compositionRoot.ts  # T4: optional-golfer tier, 8 new routes, ONE deploy
apps/web/src/auth src/routes/{CreateRoundPage,JoinRoundPage,RoundPage}.tsx src/round/SetupPanel.tsx  # T5: as-self, add-player, claim name
apps/web/src/crews/{CrewPage,CrewCreatePage,StandingGameEditor}.tsx src/App.tsx  # T6
apps/web/e2e/crewSeason.spec.ts primaryPath.spec.ts             # T7 gate
docs/implementation-plan.md docs/papercuts.md CLAUDE.md         # T7
```

---

### Task 1: Domain — the Crew entity, crewId on the round, and the ledger math

**Files:** create `packages/domain/src/crew/crew.ts`, `crew/ledger.ts` (+tests); modify `round/events.ts`, `round/state.ts`, `round/archive.ts` (+tests); barrel `index.ts`.

**Interfaces (produced):**

```ts
// crew/crew.ts
export type CrewId = string & { readonly __brand: "CrewId" };   // mirror existing id brands exactly
export type CrewRole = "organizer" | "member";
export interface CrewMember { readonly golferId: GolferId; readonly name: string; readonly role: CrewRole; }
export interface StandingGame { readonly courseId?: CourseId; readonly tee?: string; readonly games: readonly GameConfigInput[]; }
export interface Crew { readonly id: CrewId; readonly name: string; readonly members: readonly CrewMember[]; readonly standingGame?: StandingGame; }
export const addMember = (crew: Crew, member: CrewMember): Crew;  // throws DomainError "duplicate-member" on golferId already present; name min 1
export const applyStandingGame = (preset: StandingGame, presentGolferIds: ReadonlySet<GolferId>): readonly GameConfigInput[];
// a game survives iff EVERY golferId it references is present; order preserved. Test: preset
// [singles(A,B), skins(A,B,C,D), stableford(A,B,C)] with {A,B,C} present → [singles, stableford].

// round events.ts — round-created gains (strict wire schema follows in T2):
readonly crewId?: CrewId;
// state.ts: RoundState.crewId?: CrewId (set by the round-created fold, immutable after);
// archive.ts: RoundArchive.crewId?: CrewId (carried verbatim). Convergence + settlement suites
// stay green; one new test pins crewId surviving create→fold→settle.

// crew/ledger.ts — one archive's contribution to a crew's records (pure; the projector applies it):
export interface CrewRoundContribution {
  readonly roundId: RoundId;
  readonly lines: readonly { readonly golferId: GolferId; readonly wins: number; readonly losses: number;
    readonly halves: number; readonly points: number; readonly skins: number }[];   // one per participant in ≥1 counted game
  readonly headToHead: readonly { readonly a: GolferId; readonly b: GolferId;       // canonical a < b (lexicographic)
    readonly outcome: "a" | "b" | "halved" }[];                                     // singles-match results ONLY (v1)
}
export const crewContribution = (archive: RoundArchive): CrewRoundContribution;
// wins/losses/halves from singles + fourball results (fourball: each winning-side player +1 win);
// points = stableford totals; skins = skins won per player. Terminated games contribute nothing
// (they have no results — falls out of archive.results). Hand-pin against a hand-built archive:
// singles A beats B + 4-way skins (A 3, C 2) + stableford (A 36, B 34, C 33, D 31) →
// lines A {wins 1, losses 0, halves 0, points 36, skins 3}, B {0,1,0,34,0}, C {0,0,0,33,2},
// D {0,0,0,31,0}; headToHead [{a:min(A,B), b:max(A,B), outcome: winner-side}].

export interface SeasonLedgerLine { readonly golferId: GolferId; readonly rounds: number; readonly wins: number;
  readonly losses: number; readonly halves: number; readonly points: number; readonly skins: number; }
export interface HeadToHeadRecord { readonly a: GolferId; readonly b: GolferId; readonly aWins: number;
  readonly bWins: number; readonly halves: number; }
export const aggregateSeason = (contributions: readonly CrewRoundContribution[]):
  { readonly ledger: readonly SeasonLedgerLine[]; readonly headToHead: readonly HeadToHeadRecord[] };
// Pure fold, order-independent (INVARIANT: permutation of contributions ⇒ identical output —
// property-test it); ledger sorted by golferId, headToHead by (a, b). rounds counts
// contributions in which the golfer has a line.
```

- [ ] **Step 1 (RED):** tests for addMember/duplicate, applyStandingGame survival rule, crewId create→fold→settle carry, crewContribution hand-pin above, aggregateSeason permutation property + a 3-contribution hand-pin (A 2–1–0 vs B etc.).
- [ ] **Step 2 (GREEN):** implement; existing suites green unchanged.
- [ ] **Step 3:** `pnpm -F @swng/domain test` ×2; `pnpm validate`; commit `feat(domain): crew entity and standing game; crewId on the round; season ledger math`.

---

### Task 2: Contracts + application — crew use cases, as-self rounds, AddParticipant, projector extension

**Files:** create `packages/contracts/src/crews.ts`; modify `contracts/src/{commands,golfers,round}.ts`; create `application/src/ports/crewStore.ts`, `crews/{createCrew,getCrew,listMyCrews,addCrewMember,joinCrewByCode,saveStandingGame}.ts`, `rounds/addParticipant.ts`; modify `rounds/{startRound,joinRound}.ts`, `golfers/claimGolfer.ts`, `projections/{projectArchive,rebuildProjections}.ts`, `ports/projectionStore.ts`, `testing/fakes.ts`.

**Interfaces (produced):**

```ts
// contracts crews.ts (.strict() requests, like the others):
CrewMemberView    = { golferId, name, role, claimed: boolean }   // claimed = golfer row carries a sub (store lookup)
CrewView          = { crewId, name, joinCode, members: CrewMemberView[], standingGame? }
CreateCrewRequest = { name }                  → 200 { crew }     // creator (their account golfer) becomes organizer.
                                                                  // Caller with no golfer yet → 400 `golfer-required`;
                                                                  // the web creates the profile first (T5's PUT-/me-first
                                                                  // pattern), so this arm is a wire honesty check, not a flow.
AddCrewMemberRequest = { name }               → 200 { crew }     // mints a stable ghost golfer for people without
                                                                  // accounts. Account holders NEVER enter this way —
                                                                  // they join by code (below) as their own golfer, or
                                                                  // were added as a ghost and claim it later.
JoinCrewRequest   = { code }                  → 200 { crew }     // POST /crews/join — adds the CALLER's account golfer
                                                                  // as a member (role "member"); the crew's joinCode is
                                                                  // minted at creation with the round-join-code machinery
                                                                  // (same normalization); already-a-member → idempotent 200.
SaveStandingGameRequest = { standingGame }    → 200 { crew }
GetCrewResponse   = { crew }                                     // member-only: the caller's account golfer must be on
                                                                  // the roster (403 `not-a-member` otherwise).
ListMyCrewsResponse = { crews: { crewId, name, memberCount }[] } // member items found via gsi2 (GOLFER#id), then a
                                                                  // batch-get of the crew items for name + memberCount.

// commands.ts — StartRoundRequest gains:
golferId?: GolferId;                       // as-self create (same rules as JoinRound's T5b field)
crewId?: CrewId;                           // tags the round; requires caller's golfer ∈ crew members
players?: { name, tee, courseHandicap, golferId? }[];  // initial roster beyond the host, appended
                                           // as participant-joined events in order (crew one-tap)
// AddParticipantRequest (POST /rounds/{roundId}/players, participant auth):
{ name, tee, courseHandicap, golferId? }   → 200 { events }      // recordScore's append idiom

// golfers.ts — ClaimGolferRequest gains: name?: string (papercut 5; used only on lazy-create).

// Claimed-golferId rule, ONE implementation shared by startRound/joinRound/addParticipant
// (extract rounds/golferIdentity.ts — resolveSuppliedGolfer(deps)(golferId, ctx {sub?, crewId?})):
//   unclaimed (no row or no sub)          → allowed (T5b behavior unchanged)
//   claimed + ctx.sub matches             → allowed (as-self)
//   claimed + golferId ∈ crew(crewId)     → allowed (standing consent; only when the command
//                                            carries/targets a crew-tagged round)
//   claimed otherwise                     → ApplicationError "golfer-claimed" (403, exists)
// INVARIANT beside the interface: the rule NEVER mints — absent golferId still mints fresh ids
// byte-identically to today (pin with existing tests untouched).

// ports/crewStore.ts (revision-conditional, mirror CourseStore/GolferStore):
export interface CrewStore {
  put(crew: Crew, expectedRevision: number | undefined): Promise<void>;   // conflict → "crew-conflict"
  get(crewId: CrewId): Promise<{ crew: Crew; revision: number } | undefined>;
  listByGolfer(golferId: GolferId): Promise<readonly { crewId: CrewId; name: string; memberCount: number }[]>;
}

// ports/projectionStore.ts gains:
putCrewRound(crewId: CrewId, season: number, entry: CrewRoundContribution & { finalizedAtMs: number }): Promise<void>; // upsert by (crewId, roundId)
listCrewRounds(crewId: CrewId, season: number): Promise<readonly (CrewRoundContribution & { finalizedAtMs: number })[]>;
putSeasonRecords(crewId: CrewId, season: number, records: { ledger; headToHead }): Promise<void>;
getSeasonRecords(crewId: CrewId, season: number): Promise<{ ledger; headToHead } | undefined>;
wipeCrew(crewId: CrewId, seasons: readonly number[]): Promise<void>;  // seasons come from the caller — rebuildProjections
                                                                       // already collected them from the archives it replays,
                                                                       // so the store never has to discover its own keyspace.

// projectArchive extension (SAME single implementation): archives WITH crewId additionally
// putCrewRound(crewContribution(archive)) then recompute that (crew, season)'s records via
// listCrewRounds → aggregateSeason → putSeasonRecords. season = UTC year of finalizedAtMs.
// Idempotent by the upsert+recompute construction (test: project twice ⇒ identical records).
// rebuildProjections: wipe touched CREWS too (collect crewIds from archives), then replay.
```

- [ ] **Step 1 (RED):** use-case tests over fakes — crew CRUD happy paths + duplicate-member + crew-conflict + join-by-code (happy, idempotent re-join, bad code, golfer-required); the claimed-golferId rule ALL FOUR arms via the shared resolver (and startRound/joinRound/addParticipant each delegating to it — assert by behavior, all three surfaces × claimed-as-self and claimed-stranger); StartRound `players` appends participant-joined in order incl. crew-consent arm; claim `name` on lazy-create vs never-rename; projector crew extension idempotence + rebuild-equals-incremental incl. wipeCrew (mirror the M7 T2 test construction).
- [ ] **Step 2 (GREEN):** implement; wire round-trips in contracts.
- [ ] **Step 3:** `pnpm validate`; both packages ×2; commit `feat(application,contracts): crews and standing games; rounds played as yourself; the season ledger projector`.

---

### Task 3: DynamoDB crew store + crew projections

**Files:** create `packages/adapters-dynamodb/src/createDynamoCrewStore.ts` (+contract tests); modify `createDynamoProjectionStore.ts`, `keys.ts`, `index.ts`, local harness if needed.

Item shapes: crew on `core` — pk `CREW#<crewId>`, sk `"CREW"`, attrs `{ revision, name, standingGame? }`; one MEMBER item per member — pk `CREW#<crewId>`, sk `MEMBER#<golferId>`, attrs `{ name, role, gsi2pk: "GOLFER#<golferId>", gsi2sk: "CREW#<crewId>" }` (reuses the existing gsi2 for `listByGolfer` — golfer→crews per architecture §3; the golfer item's own gsi2pk is `SUB#…` so keyspaces don't collide). `put` writes the crew item revision-conditionally and reconciles MEMBER items (transactional write of crew+changed members; members are small and ≤ crew size). Projections table — pk `CREWROUNDS#<crewId>#<season>`, sk `ROUND#<finalizedAtMs>#<roundId>` for contributions (zero-padded ms like HISTORY); pk `RECORDS#<crewId>#<season>`, sk `"RECORDS"` for the aggregate snapshot (one item holding ledger + H2H together — a deliberate consolidation of architecture §3's illustrative `LEDGER#`/`H2H#` keys: they are always written and read as one recompute, and rebuildability is the invariant, not the key literals). `wipeCrew` deletes both keyspaces for every season present (query by pk prefix — enumerate seasons via the CREWROUNDS partitions actually touched; store a season set attribute on RECORDS or scan both known patterns — pick the simplest correct shape and why-comment it).

- [ ] **Step 1 (RED):** contract tests (DynamoDB Local): crew put/get round-trip incl. revision conflict + member reconcile (add/remove member reflected in items); listByGolfer across two crews; contribution upsert-by-roundId (re-put → single item); records round-trip; wipeCrew completeness across the supplied seasons (leaves other crews, other seasons, and golfer projections untouched).
- [ ] **Step 2 (GREEN):** implement; `pnpm test:contract` ×2.
- [ ] **Step 3:** `pnpm validate`; commit `feat(adapters-dynamodb): crew store with member items; season ledger projections`.

---

### Task 4: Routes + optional-golfer auth + the ONE deploy

**Files:** modify `packages/lambda/src/http/{routes,dispatch}.ts`, `compositionRoot.ts` (+tests), `apps/infra-cdk` route registration + `routesParity.test.ts`.

Dispatcher gains `auth: "optional-golfer"`: no Bearer → proceed with `ctx.account` unset; Bearer present-and-valid → `ctx.account` set; Bearer present-and-INVALID → 401 `invalid-token` (fail loud — a client that sent a token meant it). StartRound/JoinRound routes move from their current tier to `optional-golfer` (existing anonymous behavior must stay byte-identical — pin with the untouched existing dispatch tests).

| Route | Auth | Use case |
| --- | --- | --- |
| POST `/rounds/{roundId}/players` | participant | addParticipant |
| POST `/crews` | golfer | createCrew |
| GET `/crews/{crewId}` | golfer | getCrew (member-only → 403 `not-a-member`) |
| GET `/me/crews` | golfer | listMyCrews |
| POST `/crews/{crewId}/members` | golfer | addCrewMember (member-only) |
| PUT `/crews/{crewId}/standing-game` | golfer | saveStandingGame (member-only) |
| POST `/crews/join` | golfer | joinCrewByCode |
| GET `/crews/{crewId}/records?season=` | golfer | getSeasonRecords (member-only; season defaults to current UTC year) |

Route parity 17 → 25. Error map: `crew-conflict` → 409, `duplicate-member` → 409, `not-a-member` → 403, `golfer-required` → 400, `unknown-crew`/bad join code → 404 (drive REAL codes end-to-end, the standing lesson).

- [ ] **Step 1:** RED→GREEN dispatch/route/composition tests (incl. optional-golfer all three arms; a crew route rejecting a non-member; StartRound with players+crewId under a signed-in caller).
- [ ] **Step 2:** `pnpm validate` + `pnpm test:contract`.
- [ ] **Step 3: deploy** `pnpm deploy:beta` (UPDATE_COMPLETE; lambda-code + route additions only — no table/pool changes). `pnpm e2e:beta` ×2 (16/16). Live smokes (paste outputs): signed-in create-crew → add ghost member "Dave" → save standing game → GET /me/crews; StartRound as-self with crewId + players (Dave via his stable id) → score → finalize → GET records shows the contribution; invoke the rebuild lambda and re-GET records → identical (proves crew wipe+replay live).
- [ ] **Step 4:** commit `feat(lambda): crew routes and optional golfer auth; rounds as yourself live on beta`.

---

### Task 5: Web — the identity wave (as-self, add a player, claim name)

**Files:** modify `apps/web/src/routes/{CreateRoundPage,JoinRoundPage,RoundPage}.tsx`, `src/round/{SetupPanel,ClaimAffordance}.tsx`, `src/api.ts` (+tests).

Behavior contracts:
- **Create/join as yourself:** signed in with a golfer → the name field is replaced by a "Playing as <name>" line (link to /profile to change it) and the request carries `golferId` + Bearer; signed in with NO golfer → the typed name first creates your golfer (PUT /me) then creates/joins as-self (assert call order); signed out → byte-identical to today (existing tests untouched). After finalize, the round appears on your profile with no claim step — this is the milestone's headline behavior.
- **Add a player (host types Dave in):** SetupPanel's roster gains "Add player" — name + tee + course handicap → POST `/rounds/{id}/players`; the new row appears via the fold (no optimistic insert — the SetupPanel precedent). When the round has a `crewId`, the add form offers the crew's not-yet-in-round members first (one tap each, stable golferIds), free-text ghost below.
- **Claim name (papercut 5):** ClaimAffordance sends the roster row's `name` with the claim; a fresh claim's profile is named after the row, not the email.
- **Roster states:** rows that ARE you (your account golfer) show "You"; claimed-by-others show nothing (unchanged); unclaimed show "This is me" (unchanged).

- [ ] **Step 1 (RED):** component tests per contract (fake api idiom): as-self request shapes for create and join + the PUT-/me-first ordering; signed-out unchanged; add-player form → wire body + fold-driven row; crew-member quick-add uses the stable golferId; claim carries name; "You" state.
- [ ] **Step 2 (GREEN):** implement; `pnpm -F @swng/web test` ×2; `pnpm validate`.
- [ ] **Step 3:** commit `feat(web): play as yourself; add players from the host's phone; claims keep the roster name`.

---

### Task 6: Web — crew home and "play the usual"

**Files:** create `apps/web/src/crews/{CrewPage,CrewCreatePage,StandingGameEditor}.tsx` (+tests); modify `src/App.tsx` (routes `/crews/new`, `/crews/{crewId}`), home page (your crews list), `src/routes/CreateRoundPage.tsx` (preset application).

Behavior contracts:
- **Home:** signed-in home gains "Your crews" (GET /me/crews), "New crew", and "Join a crew" (code entry → POST /crews/join → crew page).
- **CrewCreatePage:** name → POST /crews → crew page.
- **CrewPage:** the crew's join code shown big (the round-page idiom — how account-holding friends get in); roster (members, claimed badge, "Add member" — name for ghosts, mirroring papercut-legible form rules); StandingGameEditor (course/tee pickers reused from round creation + the SetupPanel game-config idiom, players from the roster); **season records**: ledger table (rounds/W-L-H/points/skins per member, sorted by wins then points) + head-to-head list ("Al 5–5–2 vs Bo") from GET records, with an empty-state explainer ("records build as crew rounds finalize"); **"Play the usual"** button → CreateRoundPage pre-filled from the preset (course, tee, players incl. you as-self, games per `applyStandingGame` against the chosen roster) — ONE further tap (Create round) starts Saturday.
- Every `state.games`/roster walk added here filters/labels terminated + crew states consistently with M7's audit discipline (re-run the grep, adjudicate new sites in the report).

- [ ] **Step 1 (RED):** component tests: crews list; create; roster add-member (ghost mints, claimed badge renders); standing-game editor round-trips the preset; records table + H2H render from a fake response incl. empty state; play-the-usual pre-fill exactness (players/games/course/tee) and the one-remaining-tap assertion.
- [ ] **Step 2 (GREEN):** implement; web tests ×2; `pnpm validate`.
- [ ] **Step 3:** screenshot walk (crew page with records, standing-game editor, play-the-usual → create; 375px + desktop) saved to `.superpowers/sdd/screenshots/` for controller review. Commit `feat(web): crew home, the standing game, and one-tap Saturdays`.

---

### Task 7: The gate — golden season, the unmodified primary path, flow-walk, docs

**Files:** create `apps/web/e2e/crewSeason.spec.ts`, `apps/web/e2e/primaryPath.spec.ts`; extend `e2e/support.ts` (crew + as-self helpers); modify docs (`implementation-plan.md` M8 as-executed, `CLAUDE.md`, `papercuts.md` items 5+7 resolutions).

**crewSeason.spec.ts — the golden season (API-driven against beta; browser only where the thing gated is UI):** create user U (JWT) → U creates crew "The Saturday Boys" as-self (golfer gA named "Al") → adds ghosts Bo (gB), Cy (gC), Dee (gD) → saves the standing game (singles Al–Bo allowance 1, 4-way skins WITH carryover on, 4-way stableford, fixture course, all CH 0). Play 12 crew rounds via the API (StartRound as-self + players + crewId, per-hole scripted scores), finalize each. **Deck construction contract (BLOCKED-don't-fudge):** the implementer designs hole scores achieving EXACTLY — singles: Al wins rounds 1–5, rounds 6–7 halved, Bo wins 8–12 → **H2H Al–Bo 5W/5L/2H**; skins: every round all holes halved except hole 18, whose outright winner rotates Al,Bo,Cy,Dee,Al,… → the full 18-skin pot each round → **season skins 54 each** (3 rounds × 18); stableford points hand-derived from the constructed deck and FROZEN as the expectation before the first run (the reviewer checks the derivation; a live mismatch is BLOCKED with a trace, never a re-pin). Assert GET records deep-equals the frozen expectation (ledger lines: rounds 12 each, Al 5W-5L-2H, Bo 5W-5L-2H, Cy/Dee 0-0-0, skins 54×4, frozen points; H2H exactly one pair). Then **rebuild parity**: invoke the rebuild lambda → re-GET → deep-equal. Then **mid-season claim continuity**: user V signs in, claims gB (Bo) from any crew round, GET /me/record shows Bo's 12 history lines (stable crew id = whole season adopts — the M8 promise).
**primaryPath.spec.ts — the unmodified primary path, all-browser (process law):** a fresh user's token is minted via USER_PASSWORD_AUTH and injected into localStorage (the Hosted UI form itself stays the user's manual smoke — everything AFTER sign-in is driven through the real UI) → signed-in home → Start a round ("Playing as" line, no name typed) → score 18 on the real grid → finalize → Profile shows the history line. No API substitutions anywhere in this spec.
**Controller close-out:** `pnpm e2e:field` ×3 consecutive green (ALL specs incl. the two new); controller personally reruns validate/e2e:field/e2e:beta AND flow-walks (real browser): primary path, play-the-usual, add-Dave, Dave-claims-his-season. Legibility screenshots reviewed.
**Docs:** implementation-plan M8 as-executed; CLAUDE.md current-state; papercuts 5 (claim name — landed) and 7 (stranded rounds — write-off recorded) closed.

- [ ] **Step 1:** implement specs + helpers; freeze the expectation file; `pnpm e2e:field` ×3.
- [ ] **Step 2:** docs; `pnpm validate`.
- [ ] **Step 3:** commit `feat(web,e2e): the golden season gate — exact ledger, one-tap usual, unbroken primary path`.

---

**M8 gate (from `docs/implementation-plan.md`):** "scripted season simulation (a dozen golden rounds) produces the exact expected ledger and H2H records; creating Saturday's usual game is one tap from the crew page." As specified: Task 7's crewSeason ×3 + primaryPath ×3 + all prior suites green ×3 + controller personal runs and flow-walk + the user's manual smoke (sign up fresh through the Hosted UI, play as yourself, watch the record update — the flow that failed M7's smoke, now the headline).
