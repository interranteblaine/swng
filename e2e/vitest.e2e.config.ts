import { defineConfig } from "vitest/config";

// This suite talks to the deployed beta stack over the network (HTTP + WS round trips,
// concurrent scoring, poll-with-deadline waits for eventual WS delivery) — vitest's default
// 5s testTimeout is routinely too tight for that, hence the bump. It's invoked only via
// `pnpm e2e:beta` (root package.json), which runs the "test:e2e" script — deliberately not
// named "test", so `pnpm -r test` (part of `pnpm validate`) never touches the network.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    // Steps are sequential and dependent (start a round, join it, score it, finalize it —
    // each later step needs the earlier one's state) — stop at the first failure instead of
    // running the rest against a round that never got where it needed to be.
    bail: 1,
    // Run-scoped Cognito-user cleanup (accounts-only identity): clears the minted-user
    // tracking file before any test file runs, best-effort AdminDeleteUsers every tracked
    // user after all of them finish — the same pattern apps/web/e2e's own
    // globalSetup/globalTeardown pair establishes.
    globalSetup: ["./support/globalSetup.ts"],
  },
});
