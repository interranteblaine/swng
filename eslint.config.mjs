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
