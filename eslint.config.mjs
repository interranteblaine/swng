import js from "@eslint/js";
import tseslint from "typescript-eslint";

// The layer direction (domain → application → adapters → entry points) is enforced here as
// allow-lists: each layer block bans every import that would point the dependency arrow
// outward. Naming rules are NOT lint-enforced — whether a name tells the truth is a review
// judgment, not a string property.
const layer = (dirGlob, patterns) => ({
  files: [`packages/${dirGlob}/src/**/*.ts`],
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
  layer("domain", [
    { group: ["@swng/*"], message: "domain imports nothing." },
    NODE,
    AWS,
  ]),
  layer("contracts", [
    { group: ["@swng/*", "!@swng/domain"], message: "contracts may import only @swng/domain." },
    NODE,
    AWS,
  ]),
  layer("application", [
    {
      group: ["@swng/adapters-*", "@swng/lambda", "@swng/client"],
      message: "application depends on the ports it defines, never on adapters, entries, or the client.",
    },
    AWS,
  ]),
  layer("client", [
    {
      group: ["@swng/*", "!@swng/domain", "!@swng/contracts"],
      message: "client depends on domain + contracts only.",
    },
    NODE,
    AWS,
  ]),
  layer("adapters-*", [
    {
      group: ["@swng/*", "!@swng/domain", "!@swng/contracts", "!@swng/application"],
      message: "adapters implement application's ports; they import only domain, contracts, and application.",
    },
  ]),
  layer("lambda", [
    { group: ["@swng/client"], message: "server entries never import the client SDK." },
    AWS,
  ]),
];
