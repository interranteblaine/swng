import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// The layer direction (domain → application → adapters → entry points) is enforced here as
// allow-lists: each layer block bans every import that would point the dependency arrow
// outward. Naming rules are NOT lint-enforced — whether a name tells the truth is a review
// judgment, not a string property. `pathGlob` is the package's full path from the repo root
// (e.g. "packages/domain", "apps/web") so this one helper covers both packages/* and apps/*;
// `extensions` defaults to source-only ".ts" and widens to include ".tsx" for the one
// consumer (apps/web) that has React components.
const layer = (pathGlob, patterns, extensions = ["ts"]) => ({
  files: [`${pathGlob}/src/**/*.${extensions.length === 1 ? extensions[0] : `{${extensions.join(",")}}`}`],
  rules: {
    "no-restricted-imports": ["error", { patterns }],
  },
});

const AWS = {
  group: ["@aws-sdk/*", "aws-sdk"],
  message: "AWS SDKs are importable only inside adapters.",
};

const NODE = {
  group: ["node:*"],
  message: "This package also runs in the browser — no Node built-ins.",
};

export default [
  { ignores: ["**/dist", "**/node_modules", "**/cdk.out"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  layer("packages/domain", [
    { group: ["@swng/*"], message: "domain imports nothing." },
    NODE,
    AWS,
  ]),
  layer("packages/contracts", [
    { group: ["@swng/*", "!@swng/domain"], message: "contracts may import only @swng/domain." },
    NODE,
    AWS,
  ]),
  layer("packages/application", [
    {
      group: ["@swng/adapters-*", "@swng/lambda", "@swng/client"],
      message: "application depends on the ports it defines, never on adapters, entries, or the client.",
    },
    AWS,
  ]),
  layer("packages/client", [
    {
      group: ["@swng/*", "!@swng/domain", "!@swng/contracts"],
      message: "client depends on domain + contracts only.",
    },
    NODE,
    AWS,
  ]),
  layer("packages/adapters-*", [
    {
      group: ["@swng/*", "!@swng/domain", "!@swng/contracts", "!@swng/application"],
      message: "adapters implement application's ports; they import only domain, contracts, and application.",
    },
  ]),
  layer("packages/lambda", [
    { group: ["@swng/client"], message: "server entries never import the client SDK." },
    AWS,
  ]),
  layer(
    "apps/web",
    [
      {
        group: ["@swng/*", "!@swng/domain", "!@swng/contracts", "!@swng/client"],
        message: "the web app depends on domain, contracts, and the client SDK only — never application, adapters, or lambda directly.",
      },
      NODE,
      AWS,
    ],
    ["ts", "tsx"],
  ),
  {
    // eslint-plugin-react-hooks@7's own `configs.recommended-latest`/`configs.recommended`
    // ship a legacy `plugins: ["react-hooks"]` array — flat config rejects that outright
    // (ESLint: "plugins" must be an object) — so it can't be spread in directly. Wiring the
    // plugin object plus just the two classic "essentials" rules (not the newer, stricter
    // React Compiler rule bundle v7 also ships, e.g. purity/immutability/gating — untried
    // against this codebase and not what "essentials" means here) is what actually drops in
    // trivially.
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // "error", not "warn": root lint has no --max-warnings, so a "warn" here can never fail
      // CI — a missing/stale dependency would lint clean forever. Zero warnings exist today
      // (verified before promoting), so this is a no-op for the current tree.
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    // scripts/webEnv.mjs is a plain Node script (run via `node scripts/webEnv.mjs`, never
    // bundled) — it's the one place in the repo that's actually plain JS instead of TS, so
    // it needs the Node globals TS's own lib/types normally supply implicitly elsewhere.
    files: ["apps/web/scripts/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly" },
    },
  },
];
