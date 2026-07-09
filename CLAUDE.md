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

Current state (M0–M5 complete): nine packages under `packages/` matching
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
(`useRoundSession`); `describeGame` is the only game-kind switch site in the UI. Gated by
`pnpm e2e:field`: a two-browser Playwright field test against beta playing the full
18-hole `fieldDeck18` (engine-pinned oracle exported from `@swng/domain`) with an offline
stretch, a mid-round correction that moves a 5-skin pot, and finalize parity across
browsers.
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
