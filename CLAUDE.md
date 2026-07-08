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
pnpm validate             # Lint + build + test (full CI check)
pnpm lint                 # ESLint once at the root (one flat config governs all packages)
pnpm build                # Build all packages (topological)
pnpm test                 # Run all package tests
pnpm -F @swng/domain test # Run a single package's tests
```

Run a single test file: `pnpm -F <package> vitest run <file>` (e.g. `pnpm -F @swng/domain vitest run src/index.test.ts`). Tests are Vitest, co-located as `*.test.ts`, importing from `vitest` explicitly. The web app and its dev server return in M5.

**Before claiming a change is done, run `pnpm validate`** — lint + build + test, the same gate CI enforces.

## Architecture

This is a **pnpm monorepo** (Node 20+, pnpm 9.5+, ESM throughout) for the ground-up rebuild
of swng per `docs/product.md` → `docs/roadmap.md` → `docs/architecture.md`. The old
proof-of-concept is **deleted from the tree** — it exists only at git tag `poc-final`, holds
no authority, and must never be resurrected as design input.

Current state (M0 complete): nine skeleton packages under `packages/` matching
`docs/architecture.md` §3 (`domain`, `contracts`, `application`, `client`, four `adapters-*`,
`lambda`), with the layer direction and package boundaries enforced by `eslint.config.mjs`.
Real code lands milestone by milestone per `docs/implementation-plan.md` — update this
section as it does.

### CDK / Deployment

- AWS profile: `swng`, region: `us-east-1`; stages `beta` and `prod`.
- `apps/infra-cdk` currently contains only a synthesizable `PlaceholderStack`; the real
  stacks and stage deploy scripts return in M3.
- The **deployed POC stacks still exist in AWS** under the names `InfraCdkStack-beta` /
  `InfraCdkStack-prod`. Do not create or deploy stacks under those names until M3
  deliberately replaces them — deploying an empty stack under a live name deletes its
  resources.

## Code Authoring

- Write code that's easy for you to understand
