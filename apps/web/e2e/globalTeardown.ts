// Playwright globalTeardown (wired in playwright.config.ts): runs ONCE, in its own process,
// after EVERY worker has finished — regardless of how many spec files ran or which worker ran
// them. This is deliberately NOT a `test.afterAll` inside support.ts: see that file's own
// comment above trackMintedUser for why a hook registered at a shared module's top level does
// NOT reliably fire once per run (it fires once per PROCESS, attributed to whichever spec file
// happens to import the module first — which silently dropped every later file's minted users).
//
// Best-effort and NON-FATAL throughout, same contract the old afterAll had: a delete failure
// here (throttling, a user already gone, a transient Cognito error) must never fail the run —
// by the time this runs, every test has already reported its own pass/fail. Each user is
// individually try/caught; a failure is logged and teardown moves on to the next line.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { AdminDeleteUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { AWS_REGION, MINTED_USERS_FILE } from "./support.js";

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(MINTED_USERS_FILE)) return; // nothing was ever minted this run

  const lines = readFileSync(MINTED_USERS_FILE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    rmSync(MINTED_USERS_FILE, { force: true });
    return;
  }

  const cognito = new CognitoIdentityProviderClient({ region: AWS_REGION });
  for (const line of lines) {
    let userPoolId: string | undefined;
    let username: string | undefined;
    try {
      ({ userPoolId, username } = JSON.parse(line) as { userPoolId: string; username: string });
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
    } catch (err) {
      // Never let cleanup fail the run — genuinely best-effort (task-5-brief.md's own words):
      // log and move on to the next line.
      console.warn(`[e2e cleanup] AdminDeleteUser failed for ${username ?? line} (best-effort, not fatal): ${String(err)}`);
    }
  }

  // Clear the file so a NEXT run's globalSetup finds nothing stale to worry about even if it
  // somehow ran before this teardown got a chance to (belt-and-suspenders — globalSetup already
  // clears unconditionally at the top of every run).
  rmSync(MINTED_USERS_FILE, { force: true });
}
