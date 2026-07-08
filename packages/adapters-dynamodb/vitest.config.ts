import { configDefaults, defineConfig } from "vitest/config";

// `pnpm validate` must stay hermetic (M3 plan, Global Constraints): the contract suite talks
// to a real DynamoDB Local process and has no place in the default `vitest run`. It's
// excluded here by default and only let back in when `test:contract`
// (`DYNAMO_CONTRACT=1 vitest run src/contract`) sets the env var — the positional `src/contract`
// filter then narrows the run to exactly that directory.
export default defineConfig({
  test: {
    exclude: process.env.DYNAMO_CONTRACT === "1" ? configDefaults.exclude : [...configDefaults.exclude, "src/contract/**"],
  },
});
