import { defineConfig } from "@playwright/test";

// Placeholder: Task 7 (M5 plan) adds the field-test specs under e2e/ plus dev-server wiring.
// `pnpm e2e:field` resolves to a real Playwright run today, just against zero specs — kept
// separate from `test` so it never runs inside `pnpm -r test` / `pnpm validate` (no browsers
// are installed by this task; see `docs/implementation-plan.md` M5 Task 7).
export default defineConfig({
  testDir: "./e2e",
});
