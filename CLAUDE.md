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
pnpm dev:web              # Start Vite dev server (localhost:5173)
pnpm validate             # Lint + build + test (full CI check)
pnpm lint                 # ESLint across all packages
pnpm build                # Build all packages
pnpm test                 # Run all tests
pnpm -F @swng/web test    # Run web app tests only
pnpm -F @swng/adapters-dynamodb test  # Run a single package's tests
```

Run a single test file: `pnpm -F <package> vitest run <file>` (e.g. `pnpm -F @swng/web vitest run src/lib/roundCalcs.test.ts`).

Web tests use Vitest with jsdom environment and `@testing-library/react`. Globals are enabled (no vitest imports needed).

**Before claiming a change is done, run `pnpm validate`** — lint + build + test, the same gate CI enforces.

## Architecture

This is a **pnpm monorepo** (Node 20+, pnpm 8+) for a real-time golf scoring app, ESM
throughout. The code currently in the repo is the **proof-of-concept**, which is
reference-only and being replaced ground-up per `docs/product.md` / `docs/roadmap.md` —
never patch it, and never treat its patterns as design input. The POC's architecture is
deliberately not described here; if you need to consult it, read the code knowing it holds
no authority.

### CDK / Deployment

- AWS profile: `swng`, region: `us-east-1`
- Stages: `beta` and `prod` (separate CDK stacks: `InfraCdkStack-beta`, `InfraCdkStack-prod`)
- CDK outputs written to `apps/infra-cdk/cdk-outputs-{stage}.json`
- `pnpm cdk:deploy:beta` / `pnpm cdk:deploy:prod` for infrastructure
- `pnpm web:publish:beta` / `pnpm web:publish:prod` for frontend (S3 + CloudFront invalidation)

## Code Authoring

- Write code that's easy for you to understand
