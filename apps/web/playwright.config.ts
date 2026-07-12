import { defineConfig } from "@playwright/test";

// The M5 gate (docs/implementation-plan.md M5 Task 7): one Playwright run, two Chromium
// contexts, against the REAL deployed swng-beta stack — no mocks, no local API. `pnpm
// e2e:field` is kept separate from `test`/`validate` (vitest.config.ts's own "e2e/**"
// exclude is the other half of that) so this suite, which touches AWS and takes real
// wall-clock minutes, never gates a hermetic `pnpm validate` run.
//
// webServer.command runs three steps in the SAME shell invocation, in order: (1)
// `node scripts/webEnv.mjs` regenerates .env.local from apps/infra-cdk/cdk-outputs.json —
// every run, so a stale beta redeploy never silently serves an old endpoint; (2) `vite build`
// bakes VITE_HTTP_URL/VITE_WS_URL into the bundle (Vite inlines import.meta.env.VITE_* at
// build time, not at serve time — `vite preview` alone would just re-serve whatever the LAST
// build captured); (3) `vite preview` serves the fresh build as static files, the closest
// stand-in for the real production hosting model this app will ship behind.
export default defineConfig({
  testDir: "./e2e",
  // M9 Task 5 fix: cross-worker, run-scoped Cognito-user cleanup. globalSetup clears the
  // run-scoped tracking file support.ts's mintThrowawayUser appends to; globalTeardown reads it
  // ONCE after every worker finishes and best-effort deletes every user this run minted. Not a
  // per-spec-file `test.afterAll` — see support.ts's own comment above trackMintedUser for why
  // that doesn't reliably fire across multiple spec files sharing one worker process.
  globalSetup: "./e2e/globalSetup.ts",
  globalTeardown: "./e2e/globalTeardown.ts",
  // The whole scenario is one long, inherently-sequential story (test.describe.serial's
  // numbered steps in fieldTest.spec.ts) — one worker keeps it that way and avoids two runs
  // racing the same webServer port.
  workers: 1,
  fullyParallel: false,
  // A flake here is a finding to report, not a retry to hide (M5 Task 7 brief) — 0 retries
  // makes a failing run fail once, visibly, instead of quietly passing on attempt 2.
  retries: 0,
  reporter: [["list"]],
  timeout: 120_000,
  expect: { timeout: 10_000 }, // WS-arrival assertions on context B need real round-trip headroom, not the 5s default
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/webEnv.mjs && vite build && vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    timeout: 120_000,
    reuseExistingServer: false, // always a fresh build+server per run — never serve a stale bundle across the 3-consecutive-run gate
  },
});
