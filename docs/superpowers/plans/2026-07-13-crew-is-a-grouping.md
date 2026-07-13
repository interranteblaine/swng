# Crew Is a Grouping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the owner's amendment (spec §11a, `docs/superpowers/specs/2026-07-12-projection-realignment-design.md`): a crew is a grouping/competition ONLY — delete the standing game, "Play the usual," the setup-screen crew quick-add, the co-membership consent arm, and move crews off the home page.

**Architecture:** Delete-only plus one relocation. After this, round use cases read zero crew data; the crew is a name + join code + roster + seasons + counted rounds + standings-on-read + leave.

**Tech Stack:** existing monorepo.

## Global Constraints

- Spec §11a is the authority. This is deletion — resist any urge to preserve "useful" machinery; the owner has overruled `docs/product.md`'s prior text.
- Stored crew documents on beta carry a `standingGame` attribute — reads must tolerate-and-ignore it (raw casts already do; wire schemas drop the field). Never a migration.
- Event schema untouched (no round event changes in this plan).
- Every task: `pnpm validate` green before commit; `pnpm test:contract` if adapters touched. Deploys controller-run only (`pnpm deploy:beta`, swng-beta, never InfraCdkStack-*).
- Proof-greps close the plan: `grep -rn "standingGame\|StandingGame\|applyStandingGame\|referencedGolferIds\|play the usual\|Play the usual" packages/ apps/` → zero non-comment hits (a tolerate-and-ignore comment on the crew store read path may name the dead attribute); `grep -rn "crewStore\|CrewStore" packages/application/src/rounds/` → zero hits.

---

### Task 1: Backend strip — the crew stops knowing rounds exist

**Files:**
- Modify: `packages/domain/src/crew/crew.ts` (delete `StandingGame`, `applyStandingGame`, `referencedGolferIds`; `Crew` loses `standingGame`), `packages/domain/src/index.ts` (exports)
- Delete: `packages/application/src/crews/saveStandingGame.ts` (+ its route/wiring/contract types `SaveStandingGameRequest/Response` + schema)
- Modify: `packages/application/src/rounds/golferIdentity.ts` (co-membership arm DELETED — a claimed golfer whose sub doesn't match the caller is `golfer-claimed`, full stop; ctx stays `{ sub? }`), `startRound.ts`/`joinRound.ts`/`addParticipant.ts` (drop `crewStore`/`golfer-consent` deps if now unused), `packages/lambda/src/http/routes.ts` + `dispatch.ts` + `compositionRoot.ts` (route removed — update `HTTP_ROUTES`, routesParity, count pins DOWN by one), `packages/contracts/src/crews.ts` (Crew wire type loses `standingGame`; a stored doc WITH the attribute still round-trips — the store returns the whole doc, so pin a test that `get` on a legacy doc yields a Crew without the field and `put` never writes it back… check how the adapter maps the doc and keep it honest)
- Tests: golferIdentity matrix rewritten (as-self and unclaimed arms byte-identical; claimed-non-self → `golfer-claimed` ALWAYS — including for crew-mates, pinned explicitly); crew slice tests lose standing-game cases; contract test: legacy crew doc with `standingGame` attribute reads clean.

**Interfaces:**
- Produces: `resolveSuppliedGolfer(deps: { golferStore })` — crewStore GONE from its deps. Round use cases have zero crew imports (the proof-grep).

- [ ] Steps: failing tests → implement deletions → `pnpm validate` + `pnpm test:contract` → proof-grep `crewStore` in rounds/ → commit `feat(domain,contracts,application,lambda): a crew is a grouping — the standing game and crew-consent seating are deleted`

### Task 2: Web strip + relocation — crews leave the play surface

**Files:**
- Delete: `apps/web/src/crews/StandingGameEditor.tsx` (+ test)
- Modify: `apps/web/src/crews/CrewPage.tsx` ("The standing game" section + "Play the usual" button gone; page = name, code, roster, seasons, leave), `apps/web/src/round/SetupPanel.tsx` (crew quick-add gone — ghost free-text form only; delete the listMyCrews/getCrew fetches), `apps/web/src/routes/HomePage.tsx` ("Your crews" section REMOVED — home = start a round, join by code, your rounds), `apps/web/src/routes/ProfilePage.tsx` (gains the crews section exactly as home had it: list of my crews, "New crew" link, join-by-code input), `apps/web/src/routes/CreateRoundPage.tsx` (any play-the-usual prefill plumbing gone — check `location.state`/params it consumed and the CrewPage navigation that fed it)
- Tests: HomePage (no crews section, all states), ProfilePage (crews section renders + join works), CrewPage (no standing game/play-the-usual), SetupPanel (ghost form only, no crew fetches — pin with a no-fetch assertion).

- [ ] Steps: failing tests → implement → `pnpm validate` → full proof-grep from Global Constraints → commit `feat(web): crews are a grouping — off the home page, out of round setup`

### Task 3 (CONTROLLER): deploy #5, gates, docs, close

- [ ] `pnpm deploy:beta` (route removal — one route DOWN, no stateful changes) + `pnpm publish:web:beta`.
- [ ] Gates: `pnpm e2e:beta` ×2; `pnpm e2e:field` full (crewSeason spec should be unaffected — it never used standing games post-T12; if anything references the deleted surface, that's a finding).
- [ ] Docs: `docs/product.md` §5/§6 corrected (owner call 2026-07-13 — remove "play the usual"/"crew members in one tap"/"a standing game" from the crew's definition); `docs/architecture.md` crew section drops the preset mention; `CLAUDE.md` amendment note. Commit docs.
- [ ] Hosted spot-walk: home has no crews; profile has them; crew page is grouping-only; a round still creates/scores clean.
- [ ] Ledger + final review of the two-task diff (single reviewer pass — small branch).
