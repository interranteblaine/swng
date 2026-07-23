# Managed login on brand — and the brand tokens become a shared package

**Date:** 2026-07-23
**Status:** approved (owner green-light, this session)

## The report

> "the managed login needs to be on brand"

The one surface in the whole product still wearing AWS's stock look is the Cognito
sign-in page the PKCE flow redirects to. Beta runs the **classic Hosted UI (v1)** with
**zero branding** — AWS's default white page, blue "Sign in" button, Amazon-default type.
Every other pixel is swng (cream paper, forest ink, gold pencil, oxblood second ink, square
corners); the login is not.

## Root framing — this is two things, in order

1. **Extract the brand tokens into a shared monorepo package** (`@swng/brand`). Owner call,
   this session: the tokens are about to have their **second** consumer (the Cognito branding,
   built in CDK/TypeScript) and their **third** (a future React Native app). Today they live
   only in `apps/web/src/styles.css`'s Tailwind `@theme` block — CSS, unreadable from TypeScript.
   The moment a brand value crosses a package boundary, this monorepo's deepest law (**one copy,
   every surface renders through it**) says it belongs in a shared source, not duplicated.
   Hardcoding `#c9a356` into the Cognito Settings JSON would be exactly the drift this codebase
   kills everywhere. So the extraction is the **foundation** for the login work, not a side quest.

2. **Brand the Cognito sign-in surface**, consuming `@swng/brand` — no hardcoded hex.

It is a **relocation, not an expansion** (the domain-boundary-arc precedent): we extract *only*
the 8 colors + 2 font stacks `styles.css` already declares as the brand. No spacing scale, no
semantic aliases, no dark-mode infra, no component tokens. YAGNI holds — we stop walling RN out;
we do not build a theming system for an app that doesn't exist yet.

## Decision — Managed Login v2, branded (not classic-CSS v1)

There are two mechanisms to brand the Cognito login. We choose **Managed Login v2** with a
`CfnManagedLoginBranding` document.

- **Managed Login v2** (`AWS::Cognito::ManagedLoginBranding` + a Settings JSON + logo asset) —
  the newer, AWS-supported experience (literally "managed login"). Colors, square corners, logo,
  favicon, background — all declarative in CloudFormation.
- ~~Classic Hosted UI v1 + CSS~~ (`AWS::Cognito::UserPoolUICustomizationAttachment`) — **rejected.**
  It is the path AWS is steering away from (the console barely surfaces it); it is limited to a
  fixed CSS-class list; and — decisively — its **logo cannot be set through CloudFormation** (only
  via an imperative `set-ui-customization --image-file` API call), which would put a non-declarative
  wart in an otherwise IaC-clean stack.

### Why this is low-risk (the discovery that de-risked it)

- **The e2e suites never drive the Cognito form.** `fieldTest.spec.ts:146` injects tokens and
  re-lands on the funnel — "the Hosted-UI round trip itself is Cognito's stock form — the
  controller's live spot-walk covers it, not this automated gate." So a login-page layout change
  breaks **no** automated locator. No e2e reconciliation is needed for the login itself.
- **The OAuth endpoints are unchanged.** v2 uses the same `/oauth2/authorize`, `/oauth2/token`,
  `/logout` endpoints as v1 — only the *rendered pages* differ. `authConfig.ts` needs no change,
  and the CSP `connect-src` already lists the (unchanged) domain URL.
- **Partial Settings are supported** (AWS docs, verbatim): "Amazon Cognito doesn't require that
  you pass all parameters... preserves existing style settings that you don't specify" — a PATCH/
  merge model. We specify **only our brand overrides**; Cognito fills every other value with its
  default. We do not reproduce the ~600-line default document.

### The one visible consequence (disclosed, owner-approved)

v2 replaces the stock page with AWS's modern managed-login **card** layout — a nicer, more
brandable structure, not a re-skin of the old page. For "on brand" this is an upgrade; it is
flagged, not slid past.

### The one cost/config consequence (disclosed)

Managed login **requires the pool's feature plan to be Essentials or Plus** (not Lite). We set
`featurePlan: FeaturePlan.ESSENTIALS` **explicitly** on the `UserPool` (deterministic, rather than
relying on the AWS default). Cost is negligible at beta's handful-of-test-users scale, and prod
requires Essentials for managed login regardless — so this is a requirement of the feature, not an
optional spend. The pool already RETAINs; changing the tier is a no-interruption in-place update
(verified by `cdk diff` at close-out).

## Architecture

### `@swng/brand` — the source of truth (new leaf package)

A pure-data package, depends on nothing, importable by anyone (web, infra-cdk, future RN). Mirrors
`@swng/domain`'s package shape (`tsconfig.build.json` → `dist`, `build`/`typecheck`/`test` scripts).

```ts
// packages/brand/src/index.ts
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

Values are copied **verbatim** from `styles.css`. The names are the existing token names.

### The web stays in sync — a pin test, not codegen

Tailwind v4's `@theme` must be CSS, so the web cannot `import` the TS values into its class
generation. Rather than introduce a codegen build step + a committed artifact, we keep the
hand-authored `@theme` and **pin it to `@swng/brand` with a test** — the codebase's pervasive
"pin the invariant with a test" idiom (the `?raw` structural-test precedent,
`scoringSurface.structural.test.ts`). The test imports `styles.css?raw` and `@swng/brand`, and
asserts a two-way match: every `--color-*`/`--font-*` in `@theme` equals its `brandColors`/
`brandFonts` value, and no token exists on one side without the other. Editing a color means
editing the package **and** the CSS; the test fails on drift.

`styles.css` is **byte-unchanged** by this arc (the pin only observes it) — so there is **no
visual change** to the web app.

### The managed-login branding — built from `@swng/brand` in CDK

A new `apps/infra-cdk/lib/managedLoginBranding.ts` imports `brandColors` and builds:

- `managedLoginSettings` — a **partial** Settings object, light-mode only
  (`categories.global.colorSchemeMode: "LIGHT"`, matching the app's light-only brand), mapping each
  brand token to its managed-login role and setting every `borderRadius` to `0` (the square-corners
  principle). Colors are emitted in Cognito's `RRGGBBAA` format via a local `rgba(hex)` helper
  (strip `#`, append `ff`). The mapping:

  | Brand token | Managed-login role(s) |
  |---|---|
  | `cream` | `pageBackground.color`; secondary-button hover bg; error/alert wash |
  | `card` | `form.backgroundColor`; `input.backgroundColor`; primary-button-disabled bg (via hairline) |
  | `hairline` | `form.borderColor`; `input.borderColor`; `divider.borderColor`; disabled bg/border |
  | `forest` | primary-button **text**; `pageText.body/heading`; `inputLabel`; secondary-button border/text; `focusState.borderColor` |
  | `fairway` | `pageText.description`; `inputDescription`; `link.defaults`; success indicator |
  | `gold` | primary-button **background** (the one gold — the pencil) |
  | `oxblood` | `input.placeholderColor`; error indicator/border (the second ink) |
  | `goldwash` | *(not mapped — no managed-login role; carried in the package for the web/RN)* |

  `borderRadius: 0` at `componentClasses.{buttons,input,dropDown}` and `components.{form,alert}` —
  square corners. `components.pageBackground.image.enabled: false` and `form.backgroundImage.enabled:
  false` (no imagery — the brand is spare). Interactive button states do **not** flip color on hover
  (faithful to the app's "recolor, retype, re-shape, never re-behave" — the gold button stays gold).

- `managedLoginAssets` — one `FORM_LOGO` asset: a **"swng" wordmark SVG** (forest text on transparent,
  system sans to match the app's font-less wordmark), its `fill` sourced from `brandColors.forest`,
  base64-encoded, `ColorMode: LIGHT`, `Extension: SVG`. `components.form.logo.enabled: true`. The SVG
  uses only Cognito's allowed SVG elements/attributes (`svg`/`text`; `fill`/`font-family`/`font-size`/
  `font-weight`/`x`/`y`/`width`/`height`/`viewBox`). **Favicon is a non-goal** this arc — the web app
  ships no favicon either; add both together when the app gets one (consistency).

A unit test (`managedLoginBranding.test.ts`) asserts the token→path mapping (primary-button bg ===
`rgba(gold)`, page background === `rgba(cream)`, placeholder === `rgba(oxblood)`, every radius `0`,
`colorSchemeMode === "LIGHT"`) and the asset's `Category`/`ColorMode`/`Extension` + that its bytes
decode to an SVG carrying the forest hex — so drift between `@swng/brand` and the login is caught in
CI, not on the deployed page.

### The stack wiring (`swngStack.ts`)

- `UserPool`: add `featurePlan: FeaturePlan.ESSENTIALS`.
- `UserPoolDomain`: add `managedLoginVersion: ManagedLoginVersion.NEWER_MANAGED_LOGIN`.
- Add `new CfnManagedLoginBranding(this, "ManagedLoginBranding", { userPoolId, clientId,
  useCognitoProvidedValues: false, settings: managedLoginSettings, assets: managedLoginAssets })`.
- `swngStack.test.ts`: assert the template carries `AWS::Cognito::ManagedLoginBranding` bound to the
  pool + client, the domain's `ManagedLoginVersion: 2`, and the pool's `UserPoolTier: ESSENTIALS`.

No new stack, no prod (the standing rule). The POC stacks are never touched.

## Non-goals

- No dark mode (the brand is light-only, owner call — matched by `colorSchemeMode: LIGHT`).
- No favicon, no background image, no header/footer branding (spare brand; add later if wanted).
- No font customization of the login (managed login exposes no `fontFamily` token; its default
  sans is already close to the app's system font — `brandFonts` feeds the web/RN, not the login).
- No spacing scale / semantic aliases / component tokens in `@swng/brand` (YAGNI — relocation only).
- No change to `styles.css` (byte-identical; the web is visually unchanged).
- No change to `authConfig.ts` / OAuth endpoints / CSP (v2 shares v1's endpoints and domain URL).

## Testing & gate

- `pnpm validate` green at every commit and at HEAD (lint + typecheck + build + test).
- The web pin test proves `@theme` ≡ `@swng/brand` (two-way).
- The `managedLoginBranding` unit test proves the token→Settings mapping + the logo asset.
- The stack test proves the three template additions.
- **Close-out (controller-run):** `cdk diff` (confirm the domain/pool updates are **in-place**, no
  replacement of the pool or client) → `deploy:beta` → an **eyes-on-pixels** before/after screenshot
  of the real sign-in page on `beta.swng.golf` (the verification that matters — the whole point is
  how it looks) → `e2e:beta` + `e2e:field` as backend/funnel regression sanity → docs sweep.
