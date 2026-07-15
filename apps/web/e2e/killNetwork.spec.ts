import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { fixtureLinks } from "@swng/domain";
import { ensureCourse, enterScore, expectOrRecover, injectAuthTokens, installWsProxy, mintAccountGolfer, waitForParticipant } from "./support.js";
import type { WsRouteHandle } from "./support.js";

// M9 Task 4 (task-4-brief.md, Step 2 — reconnect QA): three named arms —
//   1. WS dropped mid-scoring then restored: scores converge, no dupes.
//   2. Offline through a finalize ATTEMPT (queued, honest chrome), then online finalize.
//   3. Token expiring mid-round (401 -> one-shot refresh).
// Arms 1-2 are real two/one-context Playwright runs against the deployed swng-beta stack
// (fixtureLinks, the 9-hole fixture — deliberately leaner than fieldTest.spec.ts's own 18-hole
// fourball+skins deck: this file's whole point is the reconnect SEAM, not a scoring oracle, so
// there's nothing to gain from more holes). Arm 3 is documented, not run, below — see its own
// describe block for why a real Cognito token's validity isn't forceable from an e2e spec
// without a CDK change this task's scope forbids, and where the refresh policy IS covered
// instead (component-level, already committed).
//
// Kept out of `pnpm validate`/`pnpm -r test` the same way fieldTest.spec.ts is: its own script
// (`pnpm e2e:field`, playwright.config.ts) and vitest.config.ts's own "e2e/**" exclude mean the
// default `vitest run` never sees this file.

test.describe.serial("M9 reconnect QA — arm 1: a socket-only WS drop mid-scoring (HTTP still up), then restored", () => {
  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let joinCode = "";
  // Same WS-proxy mechanism as fieldTest.spec.ts (support.ts's own doc comment) — but this arm
  // deliberately never calls context.setOffline: only B's SOCKET dies here, not its network.
  // That is the point of this arm, distinct from arm 2 below (a full network outage) and from
  // fieldTest.spec.ts's own drop (which combines setOffline + a WS close to simulate "no
  // network at all") — a flaky/dropped WS with HTTP still reachable is its own real-world case:
  // the client's own writes (always HTTP, never WS — architecture.md §3) keep succeeding
  // immediately, but live pushes from OTHER participants stop arriving until "Sync now."
  const aRoute: WsRouteHandle = { current: undefined };
  const bRoute: WsRouteHandle = { current: undefined };

  test.beforeAll(async ({ browser }) => {
    // Accounts-only (the wall): Ann and Bo are signed-in accounts, minted and named by the
    // harness (the funnel's own name prompt is fieldTest/primaryPath's coverage, not this
    // reconnect-seam file's), injected before either page's first navigation. Seeding a course
    // is a golfer-gated write now (course-cards spec §4), so it's minted with Ann's Bearer.
    const ann = await mintAccountGolfer("kn-ann", "Ann");
    await ensureCourse(fixtureLinks.courseName, fixtureLinks, ann);
    const bo = await mintAccountGolfer("kn-bo", "Bo");
    contextA = await browser.newContext();
    contextB = await browser.newContext();
    await installWsProxy(contextA, aRoute);
    await installWsProxy(contextB, bRoute);
    pageA = await contextA.newPage();
    pageB = await contextB.newPage();
    await injectAuthTokens(pageA, ann.tokens);
    await injectAuthTokens(pageB, bo.tokens);
  });

  test.afterAll(async () => {
    await contextA?.close();
    await contextB?.close();
  });

  test("1: A creates the round as Ann; B joins as Bo; both score hole 1 and see each other live over WS", async () => {
    await pageA.goto("/create");
    await pageA.getByLabel("Course", { exact: true }).fill(fixtureLinks.courseName);
    const result = pageA.getByRole("button", { name: `${fixtureLinks.courseName} · ${fixtureLinks.teeSets[0]!.holes.length} holes`, exact: true }).first(); // CourseSearch renders "name · N holes"
    await expect(result).toBeVisible();
    await result.click();
    // No name entry: the create form renders "Playing as Ann" from the account's own record.
    await pageA.getByLabel("Course handicap").fill("8");
    await pageA.getByRole("button", { name: "Create round" }).click();
    await expect(pageA).toHaveURL(/\/round\//);

    const joinCodeCell = pageA.locator("xpath=//p[normalize-space(text())='Join code']/following-sibling::p[1]");
    await expect(joinCodeCell).toBeVisible();
    joinCode = ((await joinCodeCell.textContent()) ?? "").trim();
    expect(joinCode).toMatch(/^[A-Z0-9]{6}$/);

    await pageB.goto("/join");
    await pageB.getByLabel("Code").fill(joinCode);
    // Signed in with a real name, so the funnel renders the join form directly — no name
    // prompt, no name field, "Playing as Bo" from the record.
    await expect(pageB.getByText(`Joining ${fixtureLinks.courseName}`)).toBeVisible();
    await pageB.getByLabel("Tee").selectOption("white");
    await pageB.getByLabel("Course handicap").fill("4");
    await pageB.getByRole("button", { name: "Join round" }).click();
    await expect(pageB).toHaveURL(/\/round\//);

    await waitForParticipant(pageA, "Bo");
    await waitForParticipant(pageB, "Ann");

    await enterScore(pageA, "Ann", 1, 4);
    await enterScore(pageB, "Bo", 1, 5);

    // Baseline cross-context convergence, both sockets still live — the pair this arm's own
    // drop/restore (steps 2-4 below) is compared against.
    await expectOrRecover(pageB, "B sees Ann's hole 1 (baseline)", () => expect(pageB.getByRole("button", { name: "Ann hole 1", exact: true })).toHaveText(/^\D*4/), bRoute);
    await expectOrRecover(pageA, "A sees Bo's hole 1 (baseline)", () => expect(pageA.getByRole("button", { name: "Bo hole 1", exact: true })).toHaveText(/^\D*5/), aRoute);
  });

  test("2: B's socket is force-closed (network otherwise fine) — StatusChrome flips Offline; B's OWN new score renders locally and QUEUES (no reconnect timer — nothing pushes it until Sync now)", async () => {
    await bRoute.current?.close().catch(() => {}); // sever ONLY the socket — contextB.setOffline is never called in this arm
    await expect(pageB.getByRole("status").filter({ hasText: "Offline" })).toBeVisible();

    // A scores hole 2 while B's socket is dead — B has no live delivery path for it right now
    // (no periodic poll; WS is the only "for free" delivery — architecture.md §3), so B's own
    // grid must NOT show it yet.
    await enterScore(pageA, "Ann", 2, 3);
    await expect(pageB.getByRole("button", { name: "Ann hole 2", exact: true })).not.toHaveText(/^\D*3/);

    // B's OWN write still renders instantly (the optimistic local fold — recordScore() always
    // appends to the outbox and folds it in synchronously, session.ts) but the PUSH itself does
    // NOT happen automatically here: recordScore() only opportunistically triggers a push
    // `if (connectedFlag)` (session.ts) — the socket is dead, so connectedFlag is false, and
    // there is no reconnect/retry timer in the SDK at all (session.ts's own doc comment: "a
    // caller that wants to reconnect calls connect() again"). So this queues in the outbox
    // exactly like arm 2's full offline case below, even though HTTP itself is perfectly
    // reachable — the gate is the socket flag, not the network.
    await enterScore(pageB, "Bo", 2, 6);
    await expect(pageB.getByText(/^1 score syncing/)).toBeVisible();
  });

  test("3: B reconnects via Sync now — pushes its own queued hole 2 and receives Ann's missed hole 2, exactly once each (no dupes); A receives Bo's hole 2 over its own live WS", async () => {
    await pageB.getByRole("button", { name: "Sync now" }).click();
    await expect(pageB.getByRole("status").filter({ hasText: "Offline" })).not.toBeVisible();
    await expect(pageB.getByText(/scores? syncing/)).not.toBeVisible(); // the queue drains: Bo's hole 2 is finally pushed

    // The missed push (Ann's hole 2) arrives via Sync now's own HTTP pull.
    await expect(pageB.getByRole("button", { name: "Ann hole 2", exact: true })).toHaveText(/^\D*3/);

    // The "no dupes" pin: B's OWN hole 2 (queued since step 2, never pushed while the socket
    // was dead) is pushed for the first time by Sync-now's own push phase, then immediately
    // pulled back by that SAME Sync-now HTTP fetch (push-then-pull, both inside one doSync()
    // pass — session.ts) — the client's confirmed-vs-outbox/opId reconciliation must fold the
    // pulled-back copy as the SAME event as the still-pending local one, not a second
    // application. A concatenated/duplicated cell (e.g. "66" instead of "6") is exactly what a
    // broken dedup would render here.
    await expect(pageB.getByRole("button", { name: "Bo hole 2", exact: true })).toHaveText(/^\D*6$/);
    await expect(pageB.getByRole("status", { name: /couldn.t be saved/i })).not.toBeVisible(); // no rejected-op toast either

    // A (never dropped) receives Bo's hole 2 purely over its own still-live WS — full
    // convergence, both directions.
    await expectOrRecover(pageA, "A sees Bo's hole 2 over WS (never dropped)", () => expect(pageA.getByRole("button", { name: "Bo hole 2", exact: true })).toHaveText(/^\D*6/), aRoute);
  });
});

test.describe.serial("M9 reconnect QA — arm 2: offline through a finalize ATTEMPT (queued, honest chrome), then online finalize", () => {
  let context: BrowserContext;
  let page: Page;
  const route: WsRouteHandle = { current: undefined };

  test.beforeAll(async ({ browser }) => {
    // Accounts-only: this arm's solo Ann is her own separate throwaway account (arm 1's Ann
    // belongs to a context that's already closed by the time this describe runs). Seeding a
    // course is a golfer-gated write now (course-cards spec §4), minted with Ann's Bearer.
    const ann = await mintAccountGolfer("kn-solo-ann", "Ann");
    await ensureCourse(fixtureLinks.courseName, fixtureLinks, ann);
    context = await browser.newContext();
    await installWsProxy(context, route);
    page = await context.newPage();
    await injectAuthTokens(page, ann.tokens);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("1: Ann creates a solo round and scores hole 1 online — a normal baseline", async () => {
    await page.goto("/create");
    await page.getByLabel("Course", { exact: true }).fill(fixtureLinks.courseName);
    const result = page.getByRole("button", { name: `${fixtureLinks.courseName} · ${fixtureLinks.teeSets[0]!.holes.length} holes`, exact: true }).first(); // CourseSearch renders "name · N holes"
    await expect(result).toBeVisible();
    await result.click();
    // No name entry: "Playing as Ann" comes from the account's own record.
    await page.getByLabel("Course handicap").fill("8");
    await page.getByRole("button", { name: "Create round" }).click();
    await expect(page).toHaveURL(/\/round\//);

    await enterScore(page, "Ann", 1, 4);

    // Wait for this baseline score to actually DRAIN (recordScore's own opportunistic
    // push+pull, session.ts) before test 2 forces the connection offline — enterScore only
    // waits for the optimistic local render, not for the server round-trip that prunes it out
    // of the outbox. Skipping this wait is a genuine test race, observed live: going offline
    // before hole 1's push+pull settles leaves it stuck in the outbox forever (a `network`-kind
    // push failure is transient, session.ts's own isTransientPushFailure — it just stays
    // queued), so test 2's "one queued score" premise would actually see TWO. This page never
    // had a chance to race a cross-context write (unlike fieldTest.spec.ts's pageB, which goes
    // offline having never written anything itself), so quiescing here is what fieldTest gets
    // for free from its own scenario shape.
    await expect(page.getByText(/scores? syncing/)).not.toBeVisible();
  });

  test("2: goes offline; a second score QUEUES honestly (pending count, not silently dropped or double-posted)", async () => {
    await context.setOffline(true);
    await route.current?.close().catch(() => {});
    await expect(page.getByRole("status").filter({ hasText: "Offline" })).toBeVisible();

    // Entering while offline still renders instantly (the optimistic local fold — the same
    // property arm 1's B relied on) but the PUSH itself can't reach the server: the queue IS
    // the feature (StatusChrome's own doc comment), not an error.
    const cell = page.getByRole("button", { name: "Ann hole 2", exact: true });
    await cell.click();
    const dialog = page.getByRole("dialog", { name: "Score for Ann, hole 2", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "5", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(cell).toHaveText(/^\D*5/); // shown locally at once, queued for the server

    await expect(page.getByText(/^1 score syncing/)).toBeVisible();
  });

  test("3: a finalize ATTEMPT while still offline fails with the honest fallback line — never a raw network error, dialog stays open, the queue survives", async () => {
    await page.getByRole("button", { name: "Finalize round" }).click();
    await expect(page.getByRole("dialog", { name: "Confirm finalize" })).toBeVisible();
    await page.getByRole("button", { name: "Finalize", exact: true }).click();

    // Same honest, never-raw-text fallback RoundPage.test.tsx's own component-level pin already
    // asserts for a REJECTED finalize — this is the same code path hit by a REAL failed fetch
    // (offline) instead of a mocked 409, proving it holds end to end, not just against a
    // hand-built response.
    const alert = page.getByRole("alert");
    await expect(alert).toHaveText("Could not finalize the round — try again.");
    await expect(page.getByRole("dialog", { name: "Confirm finalize" })).toBeVisible(); // stays open — retry is one tap away
    await expect(page.getByRole("heading", { name: "Final results" })).not.toBeVisible(); // never a silent/false finalize

    // The queued hole-2 score from step 2 is untouched by the failed finalize attempt — still
    // honestly pending, not lost and not double-counted.
    await expect(page.getByText(/^1 score syncing/)).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
  });

  test("4: back online — Sync now drains the queue, then Finalize succeeds for real", async () => {
    await context.setOffline(false);
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByText(/scores? syncing/)).not.toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Offline" })).not.toBeVisible();

    await page.getByRole("button", { name: "Finalize round" }).click();
    await expect(page.getByRole("dialog", { name: "Confirm finalize" })).toBeVisible();
    await page.getByRole("button", { name: "Finalize", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Final results" })).toBeVisible({ timeout: 45_000 });
  });
});

// Arm 3 (token expiring mid-round -> 401 -> one-shot refresh): NOT run here. A real Cognito ID
// token's validity is the User Pool CLIENT's own configured setting (apps/infra-cdk's
// UserPoolClient construct, currently AWS's default — 60 minutes; support.ts's own
// mintThrowawayUser mints via InitiateAuthCommand, which has no per-call override for it) — an
// e2e spec has no way to force a SHORT-LIVED token without either (a) a CDK change to the
// deployed UserPoolClient (a stack change + redeploy, forbidden by this task's own scope: no
// deploy, no new stack) or (b) waiting out a real hour inside a test run, which no CI budget
// tolerates. Forging an already-expired token client-side (e.g. hand-editing the JWT payload
// before injectAuthTokens) would not exercise anything: the SERVER verifies the signature
// (adapters-cognito's createCognitoVerifier), so a tampered token 401s for "bad signature," not
// "expired" — a different code path than the real expiry this arm is meant to probe, and the
// CLIENT'S OWN refresh logic (useAuth.ts's withAuth) reacts identically to any 401 regardless of
// why the server issued it, so nothing about the tampered-vs-real distinction is even visible to
// the code under test.
//
// The refresh policy itself — "a 401 from ANY golfer-tier call triggers exactly one silent
// refresh-token retry; success continues transparently, failure signs out" — is fully covered at
// the component level instead, driven with a MOCKED 401 (the same shape a real expiry produces
// on the wire) rather than an unreachable real one: apps/web/src/auth/useAuth.test.tsx's own
// describe("AuthProvider / useAuth — 401 anywhere: one silent refresh retry, then signed out")
// (pre-existing, not added by this task) asserts both arms end to end — a 401 that refreshes and
// retries successfully, and a 401 whose refresh itself fails, signing the golfer out — via the
// SAME withAuth() seam every real golfer-tier call (getMe/updateMe/getMyRecord/every crew call)
// goes through, so this is not a narrower guarantee than a live token-expiry run would give —
// only a faster, deterministic one.
test.describe("M9 reconnect QA — arm 3: token expiring mid-round (documented, not run)", () => {
  test.skip(
    true,
    "Not reachable from e2e without a CDK change to the UserPoolClient's token validity (forbidden by this task's scope) or waiting out a real ~60min token TTL. " +
      "The 401 -> one-shot-refresh policy is covered at the component level instead: apps/web/src/auth/useAuth.test.tsx's " +
      '"401 anywhere: one silent refresh retry, then signed out" describe block (pre-existing) — see this file\'s own comment above for the full reasoning.',
  );
  test("documented above — see the skip reason and this block's own leading comment", () => {});
});
