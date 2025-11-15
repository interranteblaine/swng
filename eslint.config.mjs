import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["**/dist", "**/build", "**/node_modules", "**/.aws-sam"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
];
