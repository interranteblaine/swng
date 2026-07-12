// Playwright globalSetup (wired in playwright.config.ts): runs ONCE, in its own process, before
// any worker starts. Its only job is to clear MINTED_USERS_FILE (support.ts) — a run-scoped
// on-disk record of every Cognito user THIS run's mintThrowawayUser calls create — so a prior
// run that was killed mid-flight (Ctrl-C, a CI timeout) can never leave a stale leftover list
// for THIS run's globalTeardown to (mis)act on. See support.ts's own comment above
// trackMintedUser for the full root-cause writeup of why this file-based, cross-worker
// mechanism replaced the old in-memory-array + top-level-afterAll approach.
import { rmSync } from "node:fs";
import { MINTED_USERS_FILE } from "./support.js";

export default function globalSetup(): void {
  rmSync(MINTED_USERS_FILE, { force: true });
}
