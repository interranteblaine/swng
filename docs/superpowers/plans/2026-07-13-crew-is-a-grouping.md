# Crew Is a Grouping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the owner's amendment (spec §11a, `docs/superpowers/specs/2026-07-12-projection-realignment-design.md`): a crew is a grouping/competition ONLY. Delete the standing game, "Play the usual," the setup-screen crew quick-add, and the co-membership consent arm; move crews off the home page onto the profile; standings aggregate the current roster only.

**Architecture:** Delete-only plus one relocation and one aggregation-scope change. After this: round use cases import zero crew code; the crew is a name + join code + roster of accounts + seasons + counted roundIds + standings computed on read from (counted snapshots ∩ current roster) + leave. Nothing about a crew helps run a round; nothing about a round names a crew.

**Tech Stack:** existing monorepo (TypeScript ESM, Vitest, Zod, DynamoDB, CDK, React 19).

## Global Constraints

- Spec §11a is the authority. This is deletion — do not preserve "useful" machinery; the owner has explicitly overruled `docs/product.md`'s prior text ("play the usual," "crew members in one tap," "a roster, a standing game, and a ledger").
- Stored crew documents on beta carry a `standingGame` attribute. Reads tolerate-and-ignore it; the next `put` drops it naturally (whole-document write). NEVER a migration script.
- Round event schema untouched. No new GSIs/shards/pointer items. No stored standings — the members-only rule is a read-time filter, never a stored flag or membership history.
- Every task: `pnpm validate` green before commit; `pnpm test:contract` where adapters/fakes are touched. Deploys controller-run only (`pnpm deploy:beta`, swng-beta, never `InfraCdkStack-*`).
- Closing proof-greps (run in G-T2, re-run at G-T3):
  - `grep -rn "standingGame\|StandingGame\|applyStandingGame\|referencedGolferIds\|saveStandingGame\|play the usual\|Play the usual" packages/ apps/` → only tolerate-and-ignore comments on the crew store read path may remain.
  - `grep -rn "crewStore\|CrewStore\|listMyCrews\|getCrew\b" packages/application/src/rounds/ apps/web/src/round/` → zero hits.
  - `grep -rn "member: \|\"guest\"\|Former member" packages/contracts/src/crews.ts apps/web/src/crews/` → zero hits (the flag and both labels are dead).

---

### Task G-T1: Backend — the crew stops knowing rounds exist; standings are members-only

**Files:**
- Modify: `packages/domain/src/crew/crew.ts` — delete `StandingGame`, `applyStandingGame`, `referencedGolferIds`; `Crew` loses `standingGame`. `packages/domain/src/index.ts` exports follow. (`referencedGolferIds`' only non-test consumer is `saveStandingGame.ts` — verified; it dies here too.)
- Delete: `packages/application/src/crews/saveStandingGame.ts` + its tests.
- Modify: `packages/contracts/src/crews.ts` — crew wire shape loses `standingGame`; `SaveStandingGameRequest/Response` + schemas deleted; `SeasonStandingsResponse.ledger` rows become `SeasonLedgerLine & { name: string }` (the `member` flag is deleted — every row is a member by construction).
- Modify: `packages/application/src/crews/getSeasonStandings.ts` — before the fold, filter each contribution's `lines` to golferIds on the CURRENT roster and `headToHead` to pairs where BOTH sides are members; `aggregateSeason` (domain) stays pure and untouched. **Names now come from the roster** (`CrewMember.name`) — DELETE the snapshot-participant name-resolution and its most-recently-finalized-wins logic entirely; the roster is the single name source for standings rows.
- Modify: `packages/application/src/rounds/golferIdentity.ts` — the co-membership arm is DELETED. Arms: as-self (sub matches) → allowed; unclaimed → reuse; claimed-non-self → `ApplicationError("golfer-claimed")`, ALWAYS — including for crew-mates (pin that case explicitly). `resolveSuppliedGolfer` deps become `{ golferStore }` — crewStore gone.
- Modify: `packages/application/src/rounds/startRound.ts`, `joinRound.ts`, `addParticipant.ts` — drop now-unused `crewStore` deps; `packages/lambda/src/compositionRoot.ts` follows. `requireCrewMember`/`membership.ts` are untouched (crew routes still need them).
- Modify: `packages/lambda/src/http/routes.ts` + `apps/infra-cdk/lib/swngStack.ts` `HTTP_ROUTES` + `routesParity.test.ts` + count pins — the standing-game route is REMOVED (find its exact path in routes.ts; counts go DOWN by one: 36→35 HTTP, 38→37 total).
- Modify: `packages/application/src/testing/fakes.ts` — in-memory crew store loses standing-game surface; crew fakes mirror the new Crew shape.
- Contract test (`packages/adapters-dynamodb/src/contract/crewStore.contract.test.ts`): a LEGACY crew document seeded with a raw `standingGame` attribute (write it with a raw PutCommand, not the store) reads back as a clean `Crew` (no such property), and a subsequent `put` leaves no `standingGame` attribute on the stored item (raw GetCommand proof).

**Interfaces:**
- Consumes: existing CrewStore season/counted-round surface (unchanged), `SnapshotStore.getMany` (unchanged).
- Produces: `resolveSuppliedGolfer(deps: { golferStore: GolferStore })`; `SeasonStandingsResponse` ledger rows `SeasonLedgerLine & { name }`; one fewer route. G-T2 relies on: no `member` flag on the wire; crew wire type has no `standingGame`.

- [ ] **Step 1: failing tests** — golferIdentity matrix rewrite (as-self + unclaimed byte-identical; claimed-non-self → golfer-claimed even when caller and target share a crew — the explicit pin); getSeasonStandings members-only cases: a counted round containing a non-roster golfer yields NO row and NO H2H pair for them; a departed member's rows vanish while the counted round stays listed; re-adding the member restores their rows (compute-on-read reversibility); names sourced from roster (rename a roster member → standings row shows the roster name, not the snapshot name); legacy-doc contract test.
- [ ] **Step 2: implement the deletions + the filter.** Run the route-count sweep (routes.ts, HTTP_ROUTES, parity, pins) in lockstep.
- [ ] **Step 3:** `pnpm validate` + `pnpm test:contract` green; grep `crewStore` in `packages/application/src/rounds/` → zero.
- [ ] **Step 4:** commit `feat(domain,contracts,application,lambda): a crew is a grouping — standing game, crew-consent seating, and guest aggregation deleted`

### Task G-T2: Web — crews off the play surface, standings members-only in the view

**Files:**
- Delete: `apps/web/src/crews/StandingGameEditor.tsx` + its test.
- Modify: `apps/web/src/crews/CrewPage.tsx` — "The standing game" section, "Play the usual" button, the "Save a standing game first." copy, and the failed-preset-seeding notice are all deleted. Page = name, join code, roster, seasons, leave.
- Modify: `apps/web/src/routes/CreateRoundPage.tsx` — the play-the-usual prefill plumbing dies: whatever navigation state/params CrewPage passed (crewRows/course/tee/games seeding) is removed; the page is the plain course + playing-as + handicap form.
- Modify: `apps/web/src/round/SetupPanel.tsx` — the crew quick-add and its `listMyCrews`/`getCrew` fetches are deleted; "Add player" is the free-text ghost form only.
- Modify: `apps/web/src/routes/HomePage.tsx` — the "Your crews" section (list, New crew link, join-by-code) is REMOVED; home = start a round, join by code, your rounds.
- Modify: `apps/web/src/routes/ProfilePage.tsx` — gains the crews section exactly as home had it (list of my crews linking to crew pages, "New crew" link, join-by-code input with the same error copy).
- Modify: `apps/web/src/crews/SeasonPanel.tsx` — guest labeling deleted (the wire flag is gone per G-T1); ledger rows render name + numbers, nothing else.
- Modify: `apps/web/src/api.ts`-equivalent — `saveStandingGame` client call deleted; standings response type follows contracts.

**Interfaces:**
- Consumes: G-T1's wire shapes verbatim (no `member` flag, no `standingGame` on crew).

- [ ] **Step 1: failing tests** — HomePage: no crews section in ANY auth state (signed-out, loading, no-golfer, full); ProfilePage: crews section renders, join-by-code works, New crew link present; CrewPage: no standing-game/play-the-usual remnants (query for the strings → null); SeasonPanel: no "guest" label anywhere for any fixture; SetupPanel: ghost form only AND a no-crew-fetch pin (assert the mocked api's crew calls are never invoked).
- [ ] **Step 2: implement.** Delete the dead tests with their features; keep every surviving assertion at full strength.
- [ ] **Step 3:** `pnpm validate` green; run ALL closing proof-greps from Global Constraints.
- [ ] **Step 4:** commit `feat(web): crews are a grouping — off the home page, out of round setup, members-only standings`

### Task G-T3 (CONTROLLER): deploy #5, e2e alignment, gates, docs, close

- [ ] **Step 1:** `pnpm deploy:beta` (one route removed; no stateful resource changes — verify the diff shows route deletion only) + `pnpm publish:web:beta`.
- [ ] **Step 2: crewSeason e2e alignment** (e2e-only; dispatchable): the FROZEN DECK does not change, but the standings assertions change scope under members-only aggregation:
  - Test 5 (standings vs frozen ledger): at that point the roster is Al only → assert ONLY Al's row (his frozen stableford/skins/W-L-H numbers from the deck) and an EMPTY head-to-head (no pair has two members). The ghosts' numbers stay in the spec as constants — they move to the post-claim assertion below.
  - Test 8 (V claims Bo's ghost): EXTEND — after the claim, V joins the crew by code; re-fetch standings; NOW Bo's rows appear with the frozen numbers and the Al–Bo head-to-head materializes. This is the live proof that membership is pure aggregation scope (nothing was lost while Bo was a non-member).
  - Un-count/re-count test (6): deltas recomputed against Al-only rows.
  - Remove any standing-game/`applyStandingGame` residue in e2e support code.
  - Iterate the single spec live to green ×2; the frozen deck numbers themselves must not change.
- [ ] **Step 3: gates** — `pnpm e2e:beta` ×2; full `pnpm e2e:field` (all specs; fieldTest/identityRecord/primaryPath must pass untouched — if any references a deleted surface, that's a finding).
- [ ] **Step 4: docs** — `docs/product.md`: §5's "crew members in one tap… hit 'play the usual' to load the crew's standing game" and §6's "a roster, a standing game, and a ledger" corrected to the grouping model (dated owner call 2026-07-13); `docs/architecture.md` crew paragraph drops the preset mention; `CLAUDE.md` gains the amendment note. Commit docs.
- [ ] **Step 5: hosted spot-walk** — home has no crews; profile has them; crew page is grouping-only; standings show members only; a round still creates/scores clean; zero CSP violations.
- [ ] **Step 6:** ledger + single final review pass over the whole G-branch diff (small, one reviewer), then close.
