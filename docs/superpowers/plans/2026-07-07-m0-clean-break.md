# M0 — Clean Break & Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An empty, correctly-tooled monorepo for the swng rebuild: POC deleted (preserved at tag `poc-final`), target workspace skeleton in place, conventions mechanically enforced, `pnpm validate` green.

**Architecture:** Milestone M0 of `docs/implementation-plan.md`, building toward `docs/architecture.md` §3's package layout. No product code lands here — only the ground it will stand on.

**Tech Stack:** pnpm 10 workspace (catalogs), TypeScript 5.9 strict/NodeNext/ESM, ESLint 9 flat config + typescript-eslint 8, Vitest 4, AWS CDK (placeholder app only).

## Global Constraints

- Work lands directly on `main` (repo convention; POC preserved at tag `poc-final`).
- `pnpm validate` (lint + build + test) must be green at every commit.
- Conventions (`docs/engineering-conventions.md` §6) bind: flat `src/`, one `index.ts` barrel per package, co-located `*.test.ts`, `…Store` never `…Repository`, no `Port` suffix on interfaces, layer direction lint-enforced, comment the why only.
- Every commit message ends with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Node >= 20, pnpm >= 9.5 (catalogs require it; local: node 24, pnpm 10).
- Package names are `@swng/<dir>`; the nine target packages are exactly: `domain`, `contracts`, `application`, `client`, `adapters-dynamodb`, `adapters-apigateway`, `adapters-cognito`, `adapters-powertools`, `lambda`.

---

### Task 1: Tag the POC and clear the decks

**Files:**
- Delete: `packages/` (all 13 POC packages), `apps/web/`, `tools/`
- Replace: `apps/infra-cdk/bin/`, `apps/infra-cdk/lib/`, `apps/infra-cdk/apps/` → single placeholder `bin/infra-cdk.ts`
- Modify: `README.md`
- Untrack if tracked: `apps/infra-cdk/cdk-outputs-beta.json`, `apps/infra-cdk/cdk.context.json`

**Interfaces:**
- Consumes: nothing.
- Produces: a repo containing only docs, root tooling, and an infra-cdk shell. Later tasks assume `packages/` does not exist yet.

- [ ] **Step 1: Tag the POC**

```bash
git tag poc-final
git tag -l poc-final   # Expected: poc-final
```

- [ ] **Step 2: Delete POC code**

```bash
git rm -r -q packages apps/web tools
git rm -q --cached --ignore-unmatch apps/infra-cdk/cdk-outputs-beta.json apps/infra-cdk/cdk.context.json
rm -rf apps/infra-cdk/apps apps/infra-cdk/lib apps/infra-cdk/bin apps/infra-cdk/dist apps/infra-cdk/cdk.out
```

- [ ] **Step 3: Placeholder CDK app**

First read `apps/infra-cdk/cdk.json` and note its `"app"` command; keep that command working with the single new bin file below (if it points at a `lib/` or `apps/` path, change it to run `bin/infra-cdk.ts` the same way it ran the old entry; if it runs compiled `dist/` output, leave it — `build` still emits).

Create `apps/infra-cdk/bin/infra-cdk.ts`:

```ts
import { App, Stack } from "aws-cdk-lib";

// Placeholder so the CDK app synthesizes while the real stacks wait for M3.
// Deliberately NOT named InfraCdkStack-{beta,prod}: deploying an empty stack
// under the deployed POC's names would delete its live resources.
const app = new App();
new Stack(app, "PlaceholderStack");
```

Verify `apps/infra-cdk/tsconfig.json` includes `bin/` (adjust `include` to `["bin"]` if it listed deleted dirs).

- [ ] **Step 4: Minimal README**

Replace `README.md` content with:

```markdown
# swng

Golf with your people, for keeps.

Ground-up rebuild in progress. Start with the docs: `docs/product.md` (what and why),
`docs/roadmap.md` (v1 and the arc), `docs/architecture.md` (how), 
`docs/engineering-conventions.md` (how the code reads). The pre-rebuild proof-of-concept
lives at tag `poc-final` and holds no authority.

​```bash
pnpm install
pnpm validate   # lint + build + test
​```
```

(Remove the zero-width characters around the inner fence when writing the file — write a normal fenced code block.)

- [ ] **Step 5: Verify green and commit**

```bash
pnpm install
pnpm validate
```

Expected: install prunes the lockfile; lint/build/test all pass (only `@swng/infra-cdk` builds; no package defines `test`, so `pnpm -r test` succeeds vacuously).

```bash
git add -A
git commit -m "chore: delete POC (preserved at tag poc-final), reduce infra-cdk to placeholder

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Root tooling

**Files:**
- Modify: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`

**Interfaces:**
- Consumes: Task 1's cleared repo.
- Produces: the workspace catalog (`typescript`, `vitest`, `@types/node`) that Task 3's packages reference as `"catalog:"`; `tsconfig.base.json` that package tsconfigs extend; root scripts `lint`/`build`/`test`/`validate`.

- [ ] **Step 1: Rewrite root `package.json`**

```json
{
  "name": "swng",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20",
    "pnpm": ">=9.5.0"
  },
  "scripts": {
    "test": "pnpm -r test",
    "lint": "eslint .",
    "build": "pnpm -r build",
    "validate": "pnpm lint && pnpm build && pnpm test",
    "cdk:guard": "node -e \"if(!process.env.AWS_PROFILE){console.error('Set AWS_PROFILE before running CDK');process.exit(1)}\"",
    "cdk:synth": "pnpm -F @swng/infra-cdk cdk synth",
    "cdk:diff": "pnpm -F @swng/infra-cdk cdk diff"
  },
  "devDependencies": {
    "@eslint/js": "^9.39.1",
    "@types/node": "^22.7.9",
    "eslint": "^9.39.1",
    "typescript": "^5.9.3",
    "typescript-eslint": "^8.46.4",
    "vitest": "^4.0.9"
  }
}
```

(Lint runs once at the root — one flat config governs every package; per-package `lint` scripts do not exist. Stage-specific cdk scripts return in M3 with the real stacks. The `gen`/web/ejs/yargs/ts-node toolchain died with the POC.)

- [ ] **Step 2: Workspace catalog in `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"

catalog:
  typescript: ^5.9.3
  vitest: ^4.0.9
  "@types/node": ^22.7.9
```

- [ ] **Step 3: Rewrite `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "types": []
  }
}
```

- [ ] **Step 4: Verify green and commit**

```bash
pnpm install && pnpm validate
```

Expected: all green (infra-cdk still builds under the new base config; if its own `tsconfig.json` overrides conflict, prefer the base and minimize its local overrides).

```bash
git add -A
git commit -m "chore: root tooling — catalog, strict ES2022 base config, root-level lint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: The nine package skeletons

**Files:**
- Create, for each `<name>` in `domain`, `contracts`, `application`, `client`, `adapters-dynamodb`, `adapters-apigateway`, `adapters-cognito`, `adapters-powertools`, `lambda`:
  - `packages/<name>/package.json`
  - `packages/<name>/tsconfig.json`
  - `packages/<name>/src/index.ts`
  - `packages/<name>/src/index.test.ts`

**Interfaces:**
- Consumes: Task 2's catalog and base tsconfig.
- Produces: the `@swng/*` package graph Task 4's lint rules govern. Inter-package `dependencies` (all `workspace:*`): `contracts → domain`; `application → domain, contracts`; `client → domain, contracts`; each `adapters-* → domain, application, contracts`; `lambda → domain, application, contracts, adapters-dynamodb, adapters-apigateway, adapters-cognito, adapters-powertools`. `domain` has none.

- [ ] **Step 1: Write the failing test for the first package (domain)**

`packages/domain/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@swng/domain barrel", () => {
  it("identifies itself", () => {
    expect(packageName).toBe("@swng/domain");
  });
});
```

- [ ] **Step 2: Create the domain package files**

`packages/domain/package.json`:

```json
{
  "name": "@swng/domain",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

`packages/domain/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/domain/src/index.ts`:

```ts
// Bootstrap barrel — replaced by real exports from M1 on.
export const packageName = "@swng/domain";
```

- [ ] **Step 3: Run the domain test**

```bash
pnpm install
pnpm -F @swng/domain test
```

Expected: 1 passing.

- [ ] **Step 4: Replicate for the remaining eight packages**

Same four files per package with `<name>` substituted everywhere (`packageName` value = `"@swng/<name>"`), plus the `dependencies` block from **Interfaces** above added to each `package.json` (e.g. `application` gets `"dependencies": { "@swng/domain": "workspace:*", "@swng/contracts": "workspace:*" }`). `domain` gets no `dependencies` block.

- [ ] **Step 5: Verify green and commit**

```bash
pnpm install && pnpm validate
```

Expected: 9 packages build in topological order; 9 test suites pass (one test each); lint green.

```bash
git add -A
git commit -m "feat: nine target package skeletons with catalog deps and barrels

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: The layer law — lint enforcement, proven

**Files:**
- Rewrite: `eslint.config.mjs`
- Modify: `CLAUDE.md` (Build & Development Commands section only)
- Temporary (created then deleted): `packages/domain/src/_layer-violation.ts`

**Interfaces:**
- Consumes: Task 3's package graph.
- Produces: the lint rules every subsequent milestone works under.

- [ ] **Step 1: Rewrite `eslint.config.mjs`**

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Layer direction is law (conventions §2): domain → application → adapters → lambda.
// Each layer config bans the imports that would point the arrow outward.
const layer = (dirGlob, patterns) => ({
  files: [`packages/${dirGlob}/src/**/*.ts`],
  rules: {
    "no-restricted-imports": ["error", { patterns }],
  },
});

const AWS = {
  group: ["@aws-sdk/*", "aws-sdk"],
  message: "AWS SDKs are importable only inside adapters (conventions §2).",
};

export default [
  { ignores: ["**/dist", "**/node_modules", "**/cdk.out"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSInterfaceDeclaration[id.name=/Repository$/]",
          message: "Persistence interfaces are named …Store, never …Repository (conventions §1).",
        },
        {
          selector: "TSInterfaceDeclaration[id.name=/Port$/]",
          message: "Ports are named for the capability — no Port suffix (conventions §1).",
        },
      ],
    },
  },
  layer("domain", [
    { group: ["@swng/*"], message: "domain imports nothing (conventions §2)." },
    { group: ["node:*"], message: "domain is runtime-neutral: it runs in the browser and in Lambda." },
    AWS,
  ]),
  layer("contracts", [
    { group: ["@swng/*", "!@swng/domain"], message: "contracts may import only @swng/domain." },
    AWS,
  ]),
  layer("application", [
    {
      group: ["@swng/adapters-*", "@swng/lambda", "@swng/client"],
      message: "application depends on ports it defines, never on adapters, entries, or the client.",
    },
    AWS,
  ]),
  layer("client", [
    { group: ["@swng/*", "!@swng/domain", "!@swng/contracts"], message: "client depends on domain + contracts only." },
    AWS,
  ]),
  layer("adapters-*", [
    { group: ["@swng/lambda", "@swng/client"], message: "adapters implement ports; they never import entry points or the client." },
  ]),
  layer("lambda", [
    { group: ["@swng/client"], message: "server entries never import the client SDK." },
    AWS,
  ]),
];
```

- [ ] **Step 2: Prove the law bites (red)**

Create `packages/domain/src/_layer-violation.ts`:

```ts
import "@swng/application";

export interface RoundRepository {
  id: string;
}
```

```bash
pnpm lint
```

Expected: FAIL with exactly two rule hits on that file — `no-restricted-imports` ("domain imports nothing") and `no-restricted-syntax` (`…Repository`). If either does not fire, fix the config, not the proof file.

- [ ] **Step 3: Remove the violation (green)**

```bash
rm packages/domain/src/_layer-violation.ts
pnpm validate
```

Expected: all green.

- [ ] **Step 4: Update CLAUDE.md build commands**

Replace the `## Build & Development Commands` section's code block and following two paragraphs with:

````markdown
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
````

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: lint-enforced layer direction and naming law; update build docs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
