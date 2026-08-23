# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Start here

Design intent lives in `docs/` — read before non-trivial work:

- `docs/product.md` — what swng is and why (the product north star)
- `docs/architecture.md` — the domain & backend architecture, and **where golf logic lives**
- `docs/engineering-conventions.md` — how code should read (naming, layout, layering, testing)
- `docs/roadmap.md` — v1 scope and the release arc
- `docs/arc-log.md` — **what changed and why**, newest first, with links to each spec and plan
- `docs/papercuts.md` — the known-and-unfixed list
- `docs/implementation-plan.md` — milestones M0–M9 (history; everything since ships as arcs)

Two rules about history:

- **Do not resurrect superseded designs.** The old proof-of-concept is deleted from the tree and
  exists only at git tag `poc-final`; it holds no authority. Arcs marked **⚠ SUPERSEDED** in
  `docs/arc-log.md` describe models that no longer exist — their specs are archaeology, not
  design input. Most notably, the entire WHS/handicap-index model was deleted on 2026-07-29.
- **`docs/` is the current state; `arc-log.md` is the changelog.** A rule that outlives an arc
  belongs in `architecture.md` / `engineering-conventions.md` / `product.md`, not in this file.
  This file holds operating instructions only — never a running narrative.

Conventions are enforced by ESLint where possible — a lint failure is the source of truth, not
prose here.

## Build & Development Commands

```bash
pnpm install              # Install all dependencies
pnpm validate             # Lint + typecheck + build + test (full CI check, hermetic — no network/AWS)
pnpm lint                 # ESLint at the root (one flat config) + the golf-arithmetic fence check
pnpm build                # Build all packages (topological)
pnpm test                 # All package tests + scripts/ tests (hermetic)
pnpm -F @swng/domain test # Run a single package's tests
pnpm test:contract        # DynamoDB adapter contract tests (DynamoDB Local under Java; NOT in validate)
pnpm e2e:beta             # E2E gate against the deployed beta stack (AWS creds; NOT in validate)
pnpm e2e:field            # Playwright field-test gate against beta (AWS creds; NOT in validate)
pnpm -F @swng/web dev     # Web dev server (Vite; needs apps/web/.env.local — see scripts/webEnv.mjs)
pnpm cdk:diff             # Read this before every deploy
pnpm deploy:beta          # CDK deploy of swng-beta       (profile swng)
pnpm deploy:prod          # CDK deploy of swng-prod       (profile swng)
pnpm publish:web:beta     # Build + publish the SPA to beta   (separate from deploy)
pnpm publish:web:prod     # Build + publish the SPA to prod   (separate from deploy)
```

Run a single test file: `pnpm -F <package> exec vitest run <file>` (e.g. `pnpm -F @swng/domain
exec vitest run src/index.test.ts`) — `exec` is load-bearing: packages expose a `test` script, not
a `vitest` one, so the form without it fails with "None of the selected packages has a 'vitest'
script". Tests are Vitest, co-located as `*.test.ts` (web component tests are `*.test.tsx` under
happy-dom), importing from `vitest` explicitly.

**Before claiming a change is done, run `pnpm validate`** — the same gate CI enforces. Changes to
`adapters-dynamodb` also warrant `pnpm test:contract`; anything deployed warrants `pnpm e2e:beta`.

## Architecture

A **pnpm monorepo** (Node 20+, pnpm 9.5+, ESM throughout). Eleven packages under `packages/` —
`domain`, `contracts`, `application`, `client`, `brand`, five `adapters-*`, `lambda` — plus
`apps/web`, `apps/infra-cdk`, and the root `e2e/` workspace. Layer direction and package
boundaries are lint-enforced (`eslint.config.mjs`): `domain` imports nothing, AWS SDKs live only
in adapters, and the web imports golf **compute** only from `@swng/client`.

`docs/architecture.md` is the authority on the model and the system shape. Read its
**"Where golf logic lives"** section before touching anything in `apps/web` — the compute fence
has two halves (imports *and* inline re-derivation), both fail `pnpm lint`, and the reasons are
written down there.

swng is live: **beta at https://beta.swng.golf**, **prod at https://swng.golf**.

## CDK / Deployment

- AWS profile `swng`, region `us-east-1`; stages `beta` and `prod`.
- `apps/infra-cdk` holds one `SwngStack`, deployed as **`swng-beta`** and **`swng-prod`** — no
  stage-name branching in the stack. Per-stage differences are typed props resolved from the
  `STAGE_CONFIG` table in `bin/infra-cdk.ts`. Beta must synthesize byte-identical when a prod-only
  knob is added.
- The stack holds 5 DynamoDB tables (rounds, snapshots, core, projections, connections), HTTP +
  WebSocket APIs, and 5 Lambda entries (`http`, `wsConnect`, `wsDisconnect`, `projector`,
  `rebuild`). `HTTP_ROUTES` in `lib/swngStack.ts` is the source of truth for the route list — read
  it rather than trusting a count written down anywhere.
- Deploy outputs land in `apps/infra-cdk/cdk-outputs.json` (gitignored). **The web publishes
  separately** from the stack deploy — the two are ordered deliberately, never together by habit.
- **The old POC stacks still exist in AWS** as `InfraCdkStack-beta` / `InfraCdkStack-prod` and are
  deliberately untouched. `SwngStack`'s constructor throws on those ids. Never create, deploy or
  destroy stacks under those names — decommissioning them is a separate, user-confirmed act.

Two skills carry the procedures, and you should invoke them rather than re-deriving:

- **`closing-an-arc`** — the close-out gate, and how to derive deploy order rather than repeat it.
- **`beta-and-prod-data`** — wipes, migrations, projections. **Prod data is never wiped.**

## Code Authoring

- Write code that's easy for you to understand.
- Golf logic is one tested copy in `@swng/domain`. Views render; they compute nothing.
- A type must not assert what the read path cannot guarantee — parse stored data, never cast it.
- Bounds go on request schemas only, never on a stored/read/fold schema.
- Before accepting a test, name the line that would make it fail — then delete that line and watch.
