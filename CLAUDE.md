# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

## Architecture

This is a **pnpm monorepo** (Node 20+, pnpm 8+) for a real-time golf scoring app. ESM throughout (`"type": "module"`).

### Workspace Layout

- **`apps/web`** — React 19 SPA (Vite, Tailwind CSS 4, React Router 7, TanStack React Query 5)
- **`apps/infra-cdk`** — AWS CDK infrastructure (API Gateway HTTP + WebSocket, DynamoDB, S3/CloudFront)
- **`packages/`** — Shared libraries following clean architecture

### Clean Architecture (packages)

Strict dependency direction — inner layers never import outer layers:

```
domain          → Pure types, entities, domain logic (no dependencies)
application     → Services orchestrating domain logic
contracts       → Zod schemas for API request/response validation
adapters-*      → External integrations (DynamoDB, API Gateway, Powertools)
lambda-*        → AWS Lambda entry points (HTTP handler, WebSocket handlers)
client          → Client SDK (createClient, createHttpClient, connectEvents)
browser-client  → Browser-specific build of client (built with tsup)
```

### Web App Patterns

- **Path alias**: `@/*` maps to `apps/web/src/*`
- **UI components**: Shadcn/Radix UI primitives in `apps/web/src/components/ui/`
- **State flow**: React Query fetches initial round snapshot → WebSocket `connectEvents()` streams domain events → `eventsReducer` applies events to cached snapshot
- **Session persistence**: `sessionStorage` keyed by `round:{roundId}:{key}` stores sessionId, selfPlayerId, currentRoundId
- **Routes**: `/` (home), `/rounds/create`, `/rounds/join`, `/rounds/:roundId` (tabbed view: Play, Totals, Settings)
- **Round view context**: `RoundDataContext` + `RoundActionsContext` provide round state and mutations to child components
- **Forms**: React Hook Form + Zod validation via contracts

### TypeScript

- Base config: `tsconfig.base.json` (ES2020, NodeNext modules, strict)
- Web app: ES2022 target, ESNext modules, DOM libs
- ESLint: Unused vars prefixed with `_` are allowed

### CDK / Deployment

- AWS profile: `swng`, region: `us-east-1`
- Stages: `beta` and `prod` (separate CDK stacks: `InfraCdkStack-beta`, `InfraCdkStack-prod`)
- CDK outputs written to `apps/infra-cdk/cdk-outputs-{stage}.json`
- `pnpm cdk:deploy:beta` / `pnpm cdk:deploy:prod` for infrastructure
- `pnpm web:publish:beta` / `pnpm web:publish:prod` for frontend (S3 + CloudFront invalidation)

## Code Authoring

- Write code that's easy for you to understand
