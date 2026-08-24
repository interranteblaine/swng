# MCP arc — handoff

For the agent picking this up cold. Nothing is implemented; the repo is clean.

## Read, in this order

1. `docs/superpowers/specs/2026-08-23-swng-speaks-mcp-design.md` — **§1.1 first.** It is the reason the plan is shaped the way it is.
2. `docs/superpowers/plans/2026-08-23-swng-speaks-mcp.md` — 22 tasks in two phases.

## State

- **Nothing built.** No code, no infra. Both documents are committed; the tree is otherwise untouched.
- **Beta is unchanged.** A spike on 2026-08-23 created a throwaway Cognito app client, two resource servers and one user on the beta pool to measure the behaviour in spec §4.2, and deleted all four. Verify with `aws cognito-idp list-resource-servers --user-pool-id us-east-1_4SHIP2Bmr` (expect `[]`) if you want to be sure.
- **Prod is not in scope.** `swng-prod` is not deployed in this arc.

## Owner decisions — settled, do not re-litigate

1. **The refactor comes first.** Phase 1 contains no MCP. Every task must be worth doing if the MCP arc were cancelled tomorrow.
2. **Anything with a golf job lives in `@swng/domain`** and every consumer uses it from there — UI, server, tests, MCP. Not a copy per consumer. *How* a runtime reaches it (the web goes through `@swng/client` for on-device compute) is separate from *where it lives*.
3. **The round is covered whole** — every round-scoped verb is a tool, including `abandon_round`, `set_round_holes`, `share_round`.
4. **Writes ship in v1.**
5. **Beta only.**

## How to execute

Subagent-driven development, one task at a time, review between tasks. `pnpm validate` before any task is called done. Commit per task — every task in the plan ends with one, so a bad move reverts in isolation.

Start with **Task 1**. It is the lowest-risk change in the plan (a file move plus one lint rule; zero runtime change) and it proves the loop before anything with blast radius.

**Task 5 (dispatcher decoupling) is the one to slow down on** — every API route flows through it. Require `pnpm e2e:beta` green, not just `validate`.

## Failure modes this plan already suffered — do not repeat them

Four adversarial reviews found something real each time. The root cause every time was the same: **asserting a fact from inference when verifying it was cheap.**

- The "Verified foundation" table in the plan is **spot-checkable, not trustworthy**. Every review round found a false row in it, including the row describing the safety net that makes Phase 1 safe. Check a row before you rely on it.
- **`vitest run` does not typecheck** (no vitest config for most packages). A compile-time assertion is only checked by `pnpm -F <pkg> typecheck` or `pnpm validate`.
- **A test that recomputes its own expectation proves nothing about a move.** `ResultsView.test.tsx:113` calls `describeGame` and asserts the render matches it; `:121-122` hardcodes the strings. Only the second is a real pin.
- Read the shipped `.d.mts` before writing against an SDK. Do not write signatures from documentation summaries.

## Known open items

- **Task 6** (`z.ZodType<GameState>`) carries the most unestimated depth: five arms plus five nested line schemas that do not exist yet. If it grows past a task, split it rather than rushing it.
- **Task 14's home** — `packages/lambda/src/oauth/` or `packages/adapters-dynamodb`. Decide from that package's existing test idiom.
- **No runtime step-up** in v1 — a read-only golfer gains write by reconnecting. Deliberate; see spec §4.4.

## Useful skills

`closing-an-arc` for the close-out gate and deploy order. `beta-and-prod-data` for anything touching stored data. Prod data is never wiped.
