// Vitest globalSetup (wired in vitest.e2e.config.ts): the run-scoped Cognito-user cleanup
// pair, mirroring apps/web/e2e's globalSetup/globalTeardown. `setup` runs ONCE before any
// test file and clears MINTED_USERS_FILE so a prior run killed mid-flight can never leave a
// stale list for THIS run's teardown to (mis)act on; `teardown` runs ONCE after every test
// file has finished and best-effort deletes every user this run's mintAccountGolfer calls
// tracked — see support/client.ts's own comments for why the record is a file on disk, not
// an in-memory array.
import { rmSync } from "node:fs";
import { deleteMintedUsers, MINTED_USERS_FILE } from "./client.js";

export const setup = (): void => {
  rmSync(MINTED_USERS_FILE, { force: true });
};

export const teardown = async (): Promise<void> => {
  await deleteMintedUsers();
};
