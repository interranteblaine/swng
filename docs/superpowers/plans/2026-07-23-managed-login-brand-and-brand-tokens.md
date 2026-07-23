# Managed Login on brand + `@swng/brand` tokens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the brand tokens into a shared `@swng/brand` leaf package, then brand Cognito's Managed Login v2 by consuming it — the sign-in page becomes swng, with zero hardcoded hex.

**Architecture:** `@swng/brand` (pure-data leaf) is the source of truth for the 8 colors + 2 font stacks. The web keeps its Tailwind `@theme` (CSS, byte-unchanged) and a test pins it ≡ the package. `apps/infra-cdk` builds a partial Managed-Login Settings document + a FORM_LOGO SVG from `brandColors`, and the stack turns on Managed Login v2 (domain `ManagedLoginVersion: 2`, pool `FeaturePlan.ESSENTIALS`) + a `CfnManagedLoginBranding`.

**Tech Stack:** pnpm monorepo, TypeScript (ESM), Vitest, aws-cdk-lib 2.229.1, Cognito Managed Login v2.

## Global Constraints

- **Relocation, not expansion:** `@swng/brand` holds ONLY the 8 colors + 2 font stacks already in `styles.css`, copied verbatim. No spacing/semantic/component tokens, no dark mode.
- **No hardcoded hex** in the Cognito branding — every color derives from `brandColors`.
- **`styles.css` is byte-unchanged** — the web has NO visual change this arc; the pin test only observes it.
- **Light-only** brand: Managed Login `colorSchemeMode: "LIGHT"`, lightMode values only.
- **Square corners:** every `borderRadius` in the Settings is `0`.
- **Faithful:** button states do not flip color on hover (recolor/retype/re-shape, never re-behave).
- **Color format:** Cognito wants `RRGGBBAA` — `#c9a356` → `c9a356ff` via `rgba()`.
- **Tooling:** prefix node/pnpm with `env -u NODE_OPTIONS`. Single web test: `env -u NODE_OPTIONS pnpm -F @swng/web exec vitest run <file>`.
- `pnpm validate` green at every commit and at HEAD. Never push. Beta is disposable. Never touch the POC stacks.

---

### Task 1: `@swng/brand` — the source-of-truth leaf package

**Files:**
- Create: `packages/brand/package.json`
- Create: `packages/brand/tsconfig.json`
- Create: `packages/brand/tsconfig.build.json`
- Create: `packages/brand/src/index.ts`
- Create: `packages/brand/src/index.test.ts`

**Interfaces:**
- Produces: `brandColors` (`Record<8 names, "#rrggbb">`, `as const`) and `brandFonts` (`{serif, mono}`, `as const`), importable as `@swng/brand`.

- [ ] **Step 1: package.json** (mirrors `@swng/domain`)

```json
{
  "name": "@swng/brand",
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
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

- [ ] **Step 2: tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "declaration": false,
    "declarationMap": false,
    "sourceMap": false
  },
  "include": ["src"]
}
```

- [ ] **Step 3: tsconfig.build.json**

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

- [ ] **Step 4: src/index.ts** (values copied verbatim from `apps/web/src/styles.css`)

```ts
// The swng brand tokens — the ONE source of truth, shared across the monorepo (the web's Tailwind
// @theme mirrors these and is pinned to them by a test; apps/infra-cdk builds the Cognito Managed
// Login branding from them; a future React Native app imports them directly). A pure-data leaf:
// depends on nothing, importable by anyone. Relocated verbatim from styles.css @theme (2026-07-23);
// light-only by owner call. Add tokens here ONLY when a real second consumer needs them.
export const brandColors = {
  forest: "#1c2b22",
  fairway: "#3d5a45",
  cream: "#f7f5ef",
  card: "#fffdf8",
  hairline: "#ddd8c9",
  gold: "#c9a356",
  goldwash: "#f3e9d2",
  oxblood: "#8b3a3a",
} as const;

export const brandFonts = {
  serif: 'Georgia, "Iowan Old Style", serif',
  mono: '"Courier New", Courier, monospace',
} as const;
```

- [ ] **Step 5: src/index.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { brandColors, brandFonts } from "./index";

describe("@swng/brand", () => {
  it("exposes the eight brand colors as 6-digit hex", () => {
    expect(Object.keys(brandColors)).toHaveLength(8);
    for (const value of Object.values(brandColors)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("exposes the serif and mono font stacks", () => {
    expect(brandFonts.serif).toContain("Georgia");
    expect(brandFonts.mono).toContain("Courier");
  });
});
```

- [ ] **Step 6: install + build + test**

Run: `env -u NODE_OPTIONS pnpm install` (links the new workspace package)
Run: `env -u NODE_OPTIONS pnpm -F @swng/brand build && env -u NODE_OPTIONS pnpm -F @swng/brand test`
Expected: build emits `dist/index.js` + `dist/index.d.ts`; 2 tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/brand pnpm-lock.yaml
git commit -m "feat(brand): @swng/brand — the shared brand-token source of truth"
```

---

### Task 2: Pin the web `@theme` to `@swng/brand`

**Files:**
- Modify: `apps/web/package.json` (add `@swng/brand` dependency)
- Create: `apps/web/src/brandTokens.test.ts`
- Modify: `eslint.config.mjs` (allow the web to import `@swng/brand`)

**Interfaces:**
- Consumes: `brandColors`, `brandFonts` from `@swng/brand`; `styles.css?raw` (Vite raw import, typed by `vite/client`'s `*?raw` ambient — the `scoringSurface.structural.test.ts` precedent).

- [ ] **Step 1: Write the failing pin test** — `apps/web/src/brandTokens.test.ts`

```ts
// The brand tokens are ONE source of truth (@swng/brand); styles.css's @theme mirrors them because
// Tailwind v4 needs CSS. This pins the mirror two ways: every --color-*/--font-* equals its package
// value, and neither side has an orphan. Editing a color means editing the package AND the CSS —
// drift fails here. Reads styles.css via Vite's ?raw (the scoringSurface.structural.test.ts
// precedent; apps/web lint bans node:fs).
import { describe, expect, it } from "vitest";
import { brandColors, brandFonts } from "@swng/brand";
import cssText from "./styles.css?raw";

function themeVars(css: string): Record<string, string> {
  const theme = css.match(/@theme\s*\{([\s\S]*?)\}/);
  if (!theme) throw new Error("no @theme block in styles.css");
  const out: Record<string, string> = {};
  for (const line of theme[1]!.split("\n")) {
    const m = line.match(/^\s*(--[\w-]+):\s*(.+?);\s*$/);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

describe("styles.css @theme mirrors @swng/brand", () => {
  const vars = themeVars(cssText);

  it("every brand color is the @theme --color-* value", () => {
    for (const [name, hex] of Object.entries(brandColors)) {
      expect(vars[`--color-${name}`]).toBe(hex);
    }
  });

  it("every brand font is the @theme --font-* value", () => {
    expect(vars["--font-serif"]).toBe(brandFonts.serif);
    expect(vars["--font-mono"]).toBe(brandFonts.mono);
  });

  it("has no --color-*/--font-* token absent from @swng/brand (no orphans)", () => {
    const colorNames = Object.keys(vars)
      .filter((v) => v.startsWith("--color-"))
      .map((v) => v.slice("--color-".length));
    expect(new Set(colorNames)).toEqual(new Set(Object.keys(brandColors)));
    const fontNames = Object.keys(vars)
      .filter((v) => v.startsWith("--font-"))
      .map((v) => v.slice("--font-".length));
    expect(new Set(fontNames)).toEqual(new Set(Object.keys(brandFonts)));
  });
});
```

- [ ] **Step 2: Add the dependency** — `apps/web/package.json`, in `dependencies`, alongside the other `@swng/*` entries:

```json
    "@swng/brand": "workspace:*",
```

- [ ] **Step 3: Allow the import** — `eslint.config.mjs`, the `layer("apps/web", ...)` group, add `!@swng/brand`:

```js
        group: ["@swng/*", "!@swng/domain", "!@swng/contracts", "!@swng/client", "!@swng/brand"],
```

- [ ] **Step 4: install + run the test**

Run: `env -u NODE_OPTIONS pnpm install`
Run: `env -u NODE_OPTIONS pnpm -F @swng/web exec vitest run src/brandTokens.test.ts`
Expected: 3 tests pass (the @theme already matches the verbatim-copied values).

- [ ] **Step 5: lint + validate** (no visual change — styles.css untouched)

Run: `env -u NODE_OPTIONS pnpm lint`
Expected: PASS (the `!@swng/brand` allow lets the web import it).

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json apps/web/src/brandTokens.test.ts eslint.config.mjs pnpm-lock.yaml
git commit -m "test(web): pin styles.css @theme to @swng/brand (the mirror can't drift)"
```

---

### Task 3: The Managed-Login branding, built from `@swng/brand`

**Files:**
- Modify: `apps/infra-cdk/package.json` (add `@swng/brand` devDependency)
- Create: `apps/infra-cdk/lib/managedLoginBranding.ts`
- Create: `apps/infra-cdk/test/managedLoginBranding.test.ts`

**Interfaces:**
- Consumes: `brandColors` from `@swng/brand`; `CfnManagedLoginBranding.AssetTypeProperty` (fields: `bytes?`, `category`, `colorMode`, `extension`, `resourceId?`) from `aws-cdk-lib/aws-cognito`.
- Produces: `managedLoginSettings` (a partial Settings object, `as const`) and `managedLoginAssets` (`AssetTypeProperty[]`), consumed by Task 4's stack.

- [ ] **Step 1: Add the dependency** — `apps/infra-cdk/package.json`, in `devDependencies` (alongside the other `@swng/*`):

```json
    "@swng/brand": "workspace:*",
```

- [ ] **Step 2: The builder** — `apps/infra-cdk/lib/managedLoginBranding.ts`

```ts
import { brandColors } from "@swng/brand";
import type { CfnManagedLoginBranding } from "aws-cdk-lib/aws-cognito";

// Cognito's managed-login Settings encode colors as RRGGBBAA (8 hex, no '#'). The brand is fully
// opaque, so each token maps to <rrggbb>ff. ONE conversion — the login's colors ARE the @swng/brand
// tokens, never a second copy.
const rgba = (hex: string): string => `${hex.replace("#", "")}ff`;

const c = brandColors;

// A PARTIAL Settings document — Cognito merges its own defaults for everything we don't specify
// (AWS docs: "preserves existing style settings that you don't specify"). Light-mode only: the brand
// is light-only (owner call), so colorSchemeMode LIGHT forces it and we set only lightMode values.
// Every borderRadius is 0 (the square-corners principle). Button states DON'T flip color on hover
// (faithful to the app: recolor/retype/re-shape, never re-behave). Gold is the ONE primary fill
// (the pencil); oxblood is placeholders + errors (the second ink).
export const managedLoginSettings = {
  categories: {
    global: { colorSchemeMode: "LIGHT", spacingDensity: "REGULAR" },
    form: { location: { horizontal: "CENTER", vertical: "CENTER" } },
  },
  componentClasses: {
    buttons: { borderRadius: 0 },
    input: {
      borderRadius: 0,
      lightMode: {
        defaults: { backgroundColor: rgba(c.card), borderColor: rgba(c.hairline) },
        placeholderColor: rgba(c.oxblood),
      },
    },
    dropDown: { borderRadius: 0 },
    inputLabel: { lightMode: { textColor: rgba(c.forest) } },
    inputDescription: { lightMode: { textColor: rgba(c.fairway) } },
    link: { lightMode: { defaults: { textColor: rgba(c.fairway) }, hover: { textColor: rgba(c.forest) } } },
    focusState: { lightMode: { borderColor: rgba(c.forest) } },
    divider: { lightMode: { borderColor: rgba(c.hairline) } },
  },
  components: {
    pageBackground: { image: { enabled: false }, lightMode: { color: rgba(c.cream) } },
    form: {
      borderRadius: 0,
      backgroundImage: { enabled: false },
      lightMode: { backgroundColor: rgba(c.card), borderColor: rgba(c.hairline) },
      logo: { enabled: true, formInclusion: "IN", location: "CENTER", position: "TOP" },
    },
    pageText: {
      lightMode: { bodyColor: rgba(c.forest), headingColor: rgba(c.forest), descriptionColor: rgba(c.fairway) },
    },
    primaryButton: {
      lightMode: {
        defaults: { backgroundColor: rgba(c.gold), textColor: rgba(c.forest) },
        hover: { backgroundColor: rgba(c.gold), textColor: rgba(c.forest) },
        active: { backgroundColor: rgba(c.gold), textColor: rgba(c.forest) },
        disabled: { backgroundColor: rgba(c.hairline), borderColor: rgba(c.hairline) },
      },
    },
    secondaryButton: {
      lightMode: {
        defaults: { backgroundColor: rgba(c.card), borderColor: rgba(c.forest), textColor: rgba(c.forest) },
        hover: { backgroundColor: rgba(c.cream), borderColor: rgba(c.forest), textColor: rgba(c.forest) },
        active: { backgroundColor: rgba(c.cream), borderColor: rgba(c.forest), textColor: rgba(c.forest) },
      },
    },
    alert: { borderRadius: 0, lightMode: { error: { backgroundColor: rgba(c.cream), borderColor: rgba(c.oxblood) } } },
  },
} as const;

// The "swng" wordmark on the form card — forest text (from @swng/brand), transparent ground, the
// app's own font-less system-sans wordmark. Only Cognito-allowed SVG elements/attributes
// (svg/text; fill/font-*/x/y/width/height/viewBox). base64 into the asset Bytes.
const wordmarkSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="48" viewBox="0 0 160 48">` +
  `<text x="0" y="37" font-family="-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif" ` +
  `font-size="42" font-weight="700" fill="${c.forest}">swng</text></svg>`;

export const managedLoginAssets: CfnManagedLoginBranding.AssetTypeProperty[] = [
  {
    category: "FORM_LOGO",
    colorMode: "LIGHT",
    extension: "SVG",
    bytes: Buffer.from(wordmarkSvg, "utf8").toString("base64"),
  },
];
```

- [ ] **Step 3: The unit test** — `apps/infra-cdk/test/managedLoginBranding.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { brandColors } from "@swng/brand";
import { managedLoginAssets, managedLoginSettings } from "../lib/managedLoginBranding";

const rgba = (hex: string): string => `${hex.replace("#", "")}ff`;

describe("managed-login branding is built from @swng/brand", () => {
  it("forces light mode (the brand is light-only)", () => {
    expect(managedLoginSettings.categories.global.colorSchemeMode).toBe("LIGHT");
  });

  it("paints the page cream and the form card", () => {
    expect(managedLoginSettings.components.pageBackground.lightMode.color).toBe(rgba(brandColors.cream));
    expect(managedLoginSettings.components.form.lightMode.backgroundColor).toBe(rgba(brandColors.card));
  });

  it("makes the primary button gold with forest text (the one pencil)", () => {
    const btn = managedLoginSettings.components.primaryButton.lightMode.defaults;
    expect(btn.backgroundColor).toBe(rgba(brandColors.gold));
    expect(btn.textColor).toBe(rgba(brandColors.forest));
  });

  it("uses oxblood for input placeholders (the second ink)", () => {
    expect(managedLoginSettings.componentClasses.input.lightMode.placeholderColor).toBe(rgba(brandColors.oxblood));
  });

  it("squares every corner", () => {
    expect(managedLoginSettings.componentClasses.buttons.borderRadius).toBe(0);
    expect(managedLoginSettings.componentClasses.input.borderRadius).toBe(0);
    expect(managedLoginSettings.components.form.borderRadius).toBe(0);
    expect(managedLoginSettings.components.alert.borderRadius).toBe(0);
  });

  it("ships one FORM_LOGO SVG carrying the forest wordmark", () => {
    expect(managedLoginAssets).toHaveLength(1);
    const logo = managedLoginAssets[0]!;
    expect(logo.category).toBe("FORM_LOGO");
    expect(logo.colorMode).toBe("LIGHT");
    expect(logo.extension).toBe("SVG");
    const svg = Buffer.from(logo.bytes as string, "base64").toString("utf8");
    expect(svg).toContain("<svg");
    expect(svg).toContain("swng");
    expect(svg).toContain(brandColors.forest);
  });
});
```

- [ ] **Step 4: install + test**

Run: `env -u NODE_OPTIONS pnpm install`
Run: `env -u NODE_OPTIONS pnpm -F @swng/infra-cdk exec vitest run test/managedLoginBranding.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/infra-cdk/package.json apps/infra-cdk/lib/managedLoginBranding.ts apps/infra-cdk/test/managedLoginBranding.test.ts pnpm-lock.yaml
git commit -m "feat(infra): build the Managed Login branding from @swng/brand (no hardcoded hex)"
```

---

### Task 4: Wire the branding into the stack (domain v2 + ESSENTIALS + CfnManagedLoginBranding)

**Files:**
- Modify: `apps/infra-cdk/lib/swngStack.ts`
- Modify: `apps/infra-cdk/test/swngStack.test.ts`

**Interfaces:**
- Consumes: `managedLoginSettings`, `managedLoginAssets` (Task 3); `CfnManagedLoginBranding`, `FeaturePlan`, `ManagedLoginVersion` from `aws-cdk-lib/aws-cognito`.

- [ ] **Step 1: Imports** — `swngStack.ts` line 9, extend the cognito import:

```ts
import { CfnManagedLoginBranding, CfnUserPoolClient, FeaturePlan, ManagedLoginVersion, OAuthScope, UserPool, UserPoolClient, UserPoolDomain } from "aws-cdk-lib/aws-cognito";
```

And add after the cognito import line:

```ts
import { managedLoginAssets, managedLoginSettings } from "./managedLoginBranding";
```

- [ ] **Step 2: Feature plan on the pool** — in the `new UserPool(this, "UserPool", {...})` block, add (after `removalPolicy: RemovalPolicy.RETAIN,`):

```ts
      // Managed login (below) requires the Essentials feature plan; set it explicitly (deterministic
      // rather than relying on the AWS default). No-interruption update; prod needs it regardless.
      featurePlan: FeaturePlan.ESSENTIALS,
```

- [ ] **Step 3: Managed Login v2 on the domain** — in the `new UserPoolDomain(this, "UserPoolDomain", {...})` block, add:

```ts
      // Managed login v2 (the branding designer's experience), branded by the CfnManagedLoginBranding
      // below — same OAuth endpoints/domain URL as v1, only the rendered pages change.
      managedLoginVersion: ManagedLoginVersion.NEWER_MANAGED_LOGIN,
```

- [ ] **Step 4: The branding resource** — immediately AFTER the `userPoolDomain` construct (both `userPool` and `userPoolClient` exist by then):

```ts
    // The swng-branded managed login style (docs/superpowers/specs/2026-07-23-managed-login-brand-
    // and-brand-tokens-design.md). Settings + logo asset are built from @swng/brand — the login's
    // colors are the same tokens the web renders. Partial Settings: Cognito merges its defaults for
    // everything unspecified.
    new CfnManagedLoginBranding(this, "ManagedLoginBranding", {
      userPoolId: userPool.userPoolId,
      clientId: userPoolClient.userPoolClientId,
      useCognitoProvidedValues: false,
      settings: managedLoginSettings,
      assets: managedLoginAssets,
    });
```

- [ ] **Step 5: Stack test** — `swngStack.test.ts`, add a `describe` block (mirror the existing `template.hasResourceProperties` + `Match` idiom; `template` is the module-level `Template.fromStack(...)`):

```ts
  describe("managed login branding", () => {
    it("turns the domain on to Managed Login v2", () => {
      template.hasResourceProperties("AWS::Cognito::UserPoolDomain", { ManagedLoginVersion: 2 });
    });

    it("puts the pool on the Essentials feature plan (managed login requires it)", () => {
      template.hasResourceProperties("AWS::Cognito::UserPool", { UserPoolTier: "ESSENTIALS" });
    });

    it("provisions a branding style: light mode + a FORM_LOGO svg, not Cognito defaults", () => {
      template.hasResourceProperties("AWS::Cognito::ManagedLoginBranding", {
        UseCognitoProvidedValues: false,
        Settings: Match.objectLike({
          categories: Match.objectLike({ global: Match.objectLike({ colorSchemeMode: "LIGHT" }) }),
        }),
        Assets: Match.arrayWith([Match.objectLike({ Category: "FORM_LOGO", Extension: "SVG" })]),
      });
    });
  });
```

(If `Match` is not already imported in the test file, it is — the tables tests use `Match.objectLike`/`Match.arrayWith`.)

- [ ] **Step 6: test + synth**

Run: `env -u NODE_OPTIONS pnpm -F @swng/infra-cdk exec vitest run test/swngStack.test.ts`
Expected: all stack tests pass incl. the 3 new ones.
Run: `env -u NODE_OPTIONS pnpm -F @swng/infra-cdk exec cdk synth swng-beta --profile swng -q` (or `pnpm -F @swng/infra-cdk build` if synth needs creds)
Expected: synth succeeds; template carries `AWS::Cognito::ManagedLoginBranding`.

- [ ] **Step 7: full validate**

Run: `env -u NODE_OPTIONS pnpm validate`
Expected: exit 0 (lint + typecheck + build + test across all packages).

- [ ] **Step 8: Commit**

```bash
git add apps/infra-cdk/lib/swngStack.ts apps/infra-cdk/test/swngStack.test.ts
git commit -m "feat(infra): enable Managed Login v2 + the swng branding style on swng-beta"
```

---

## Close-out (controller-run)

Not a task — the milestone gate, after all 4 tasks + the whole-branch review.

1. `pnpm validate` green at HEAD.
2. `cdk diff swng-beta` — **confirm the pool + domain updates are in-place (no Replacement)** of the UserPool or UserPoolClient. If either shows Replacement, STOP and reassess (a pool replacement would orphan real accounts).
3. `pnpm deploy:beta`.
4. **Eyes-on-pixels:** open the real sign-in page on `beta.swng.golf` (drive the PKCE flow to Cognito), screenshot before/after — cream page, forest text, gold square "Sign in", the swng wordmark on the card, square corners. This is the verification that matters.
5. `pnpm e2e:beta` ×2 and `pnpm e2e:field` — backend/funnel regression sanity (the login form is not automated, so these prove nothing about the branding; they prove nothing else broke).
6. Docs sweep: add the arc paragraph to `CLAUDE.md`.
