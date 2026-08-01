import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { fixtureLinks } from "@swng/domain";
import { ensureCourse, enterScore, expectOrRecover, injectAuthTokens, installWsProxy, mintAccountGolfer, setStrokesInBrowser, waitForParticipant } from "./support.js";
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
  // immediately, but live pushes from OTHER participants stop arriving until the socket comes
  // back — which now happens on its own, via the outbox's own backoff loop (2026-08-01, "the
  // outbox drains itself"), not a "Sync now" tap.
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
    // No name entry: the create form renders "Playing as Ann" from the account's own record, and
    // the form asks nothing about anyone's game (spec 2026-07-30 §9). Ann stays on the default 0;
    // Bo's own number is typed onto the roster below.
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
    await pageB.getByRole("button", { name: "Join round" }).click();
    await expect(pageB).toHaveURL(/\/round\//);

    await waitForParticipant(pageA, "Bo");
    await waitForParticipant(pageB, "Ann");

    // Bo's own number, typed onto the roster from his own page (spec 2026-07-30 §2/§8). A HARNESS
    // INPUT, not a frozen deck — nothing in this file is a scoring oracle (its whole point is the
    // reconnect seam) — but Bo receiving SOMETHING is load-bearing for test 3's exact-string dedup
    // pin: 2 strokes on this nine puts a dot on SI<=2, which includes hole 2, so his cell there
    // carries dots + gross + net and the "●65" pin covers all three spans of a Cell's render. Ann
    // stays on 0, so her cells stay single-span.
    await setStrokesInBrowser(pageB, "Bo", 2);

    await enterScore(pageA, "Ann", 1, 4);
    await enterScore(pageB, "Bo", 1, 5);

    // Baseline cross-context convergence, both sockets still live — the pair this arm's own
    // drop/restore (steps 2-4 below) is compared against.
    await expectOrRecover(pageB, "B sees Ann's hole 1 (baseline)", () => expect(pageB.getByRole("button", { name: "Ann hole 1", exact: true })).toHaveText(/^\D*4/), bRoute);
    await expectOrRecover(pageA, "A sees Bo's hole 1 (baseline)", () => expect(pageA.getByRole("button", { name: "Bo hole 1", exact: true })).toHaveText(/^\D*5/), aRoute);
  });

  // Tests 2 and 3 used to be split at a "B's score stays queued" checkpoint — under the
  // pre-2026-08-01 SDK that state was stable forever (nothing pushed it until a tap), so it was
  // safe to assert as a persisted fact between two separate `test()` blocks. It no longer is: HTTP
  // is fully reachable in this arm (only the socket died), and the self-draining outbox attempts
  // every push regardless of the socket, so B's own write clears on its own almost immediately,
  // and the missed live push (Ann's hole 2) arrives on its own once the backoff loop's reconnect
  // lands (base 2s). Splitting at that midpoint would mean asserting a state that may already have
  // resolved by the time a second `test()` block starts running — so this stays ONE test, and the
  // honest claim is the whole arc: B's socket dies, B scores, and the queue drains on its own with
  // nobody tapping anything.
  test("2: B's socket is force-closed (network otherwise fine) — B's OWN new score renders locally, and the whole queue drains on its own with nobody tapping anything", async () => {
    await bRoute.current?.close().catch(() => {}); // sever ONLY the socket — contextB.setOffline is never called in this arm

    // A scores hole 2 while B's socket is dead — B has no live delivery path for it right now
    // (no periodic poll; WS is the only "for free" delivery — architecture.md §3), so B's own
    // grid must NOT show it yet. This window is bounded by the backoff loop's own base delay
    // (2s) before its first reconnect attempt, so it holds only if this assertion runs promptly
    // after the close — which it does, with nothing slower than two clicks in between.
    await enterScore(pageA, "Ann", 2, 3);
    await expect(pageB.getByRole("button", { name: "Ann hole 2", exact: true })).not.toHaveText(/^\D*3/);

    // B's OWN write still renders instantly (the optimistic local fold — recordScore() always
    // appends to the outbox and folds it in synchronously, session.ts) and it now ALWAYS attempts
    // a push: the old `if (connectedFlag)` gate that let a dead socket block the push outright
    // from ever being tried is gone (session.ts, 2026-08-01) — recordScore fires a sync attempt
    // regardless of the socket. The socket is the ONLY thing that died in this arm, so that push
    // reaches the server over plain HTTP same as always; what's actually delayed is B's LIVE
    // delivery path, which needs the socket itself back before anything more can arrive over it —
    // and reconnecting THAT rides the SDK's own backoff loop (base 2s, doubling to a 30s cap).
    // Nobody taps anything for either half of this.
    await enterScore(pageB, "Bo", 2, 6);

    // The drain, unattended: whatever briefly queued clears on its own, and B picks up the missed
    // push (Ann's hole 2) via the backoff-driven reconnect's own catch-up pull — give it room for
    // the base retry delay plus a real reconnect + pull round trip against deployed beta. The
    // count appears in the escalated banner too, so this negative can only mean drained.
    await expect(pageB.getByText(/saved on this phone/)).not.toBeVisible({ timeout: 20_000 });
    await expect(pageB.getByRole("button", { name: "Ann hole 2", exact: true })).toHaveText(/^\D*3/);

    // The "no dupes" pin: B's OWN hole 2 (queued the instant it was entered) is pushed once by the
    // SDK's own sync pass, then immediately pulled back by that SAME pass (push-then-pull, both
    // inside one doSync() call — session.ts) — the client's confirmed-vs-outbox/opId
    // reconciliation must fold the pulled-back copy as the SAME event as the still-pending local
    // one, not a second application. Exact full-text pin, derived from the number typed in test 1:
    // Bo is on 2 strokes. allocateStrokes(2, 9 holes) puts a single dot on the two lowest-SI holes
    // only — hole 2 is SI 1, so Bo's cell renders ● + gross 6 + net 6−1=5, and any concatenated/
    // duplicated fold (e.g. "●665") corrupts this exact string. Unaffected by HOW the sync was
    // triggered — this pin is about the fold, not the recovery mechanism.
    await expect(pageB.getByRole("button", { name: "Bo hole 2", exact: true })).toHaveText("●65");
    // Was role="status" — StatusChrome's rejected-op toast is actually role="alert"
    // (StatusChrome.tsx:72), so the old query matched nothing and this assertion passed
    // vacuously. Fixed to the real role; `.filter({ hasText })` replaces the `name` option
    // deliberately, not just cosmetically — role="alert" is not one of the roles whose
    // accessible name is computed from its own text content (ARIA's "name from content" list is
    // things like button/link/heading, not alert/status), so `{ name: /.../ }` would still not
    // have matched even with the role corrected. `.filter({ hasText })` is this codebase's own
    // established idiom for matching a live-region role by its text (see e.g. this file's own
    // former "Offline" banner locator, and support.ts's roster-row filters). This is now a REAL
    // check, not a vacuous one: if a rejected-op toast genuinely renders at this point in a live
    // run, this assertion will fail — that would be a true finding about Task 1's rejected-op
    // durability, not a reconciliation defect, so read it as a watch item on the first live run.
    await expect(pageB.getByRole("alert").filter({ hasText: /couldn.t be saved/i })).not.toBeVisible(); // no rejected-op toast either

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
    // No name entry: "Playing as Ann" comes from the account's own record, and nothing is asked
    // about her game — she plays alone on the default 0 strokes.
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
    await expect(page.getByText(/saved on this phone/)).not.toBeVisible();
  });

  test("2: goes offline; a second score QUEUES honestly (pending count, not silently dropped or double-posted)", async () => {
    await context.setOffline(true);
    await route.current?.close().catch(() => {});
    // Nothing renders yet at this exact instant — pending is still 0 (nothing queued), so there is
    // no chrome to assert here regardless of what the loop is doing. Straight to the write. (The
    // escalated wording arrives once the backoff reaches its cap on the fourth consecutive failed
    // pass — 2s+4s+8s, so t≈14s, not the 30s the cap's own value suggests — which is why the
    // assertions below pin the COUNT, which both states state identically, and not the suffix.)

    // Entering while offline still renders instantly (the optimistic local fold — the same
    // property arm 1's B relied on) but the PUSH itself can't reach the server: the queue IS
    // the feature (StatusChrome's own doc comment), not an error. Unlike arm 1, HTTP itself is
    // genuinely blocked here (context.setOffline), so — unlike arm 1's B — this queue is stable:
    // no backoff pass can succeed until the context comes back online in test 4 below.
    const cell = page.getByRole("button", { name: "Ann hole 2", exact: true });
    await cell.click();
    const dialog = page.getByRole("dialog", { name: "Score for Ann, hole 2", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "5", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(cell).toHaveText(/^\D*5/); // shown locally at once, queued for the server

    await expect(page.getByText(/^1 score saved on this phone/)).toBeVisible();
  });

  test("3: a finalize ATTEMPT while still offline is REFUSED, in words — the round is never sealed over the queued score", async () => {
    await page.getByRole("button", { name: "Finalize round" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm finalize" });
    await expect(dialog).toBeVisible();
    // Stated before the tap, not discovered after it (2026-07-30): the dialog's own
    // "locks in every score" promise is only true because the attempt sends what's queued first.
    await expect(dialog).toContainText("1 score hasn't sent yet — finalizing sends it first.");
    await page.getByRole("button", { name: /^finalize$/i }).click();

    // The finalize boundary drains the outbox and REFUSES rather than sealing over it —
    // `round-finalized` is terminal, so a score that hasn't landed by then is refused by the
    // server and dropped for good. Offline, the drain can't finish, so nothing at all is
    // attempted: this is deliberately NOT the generic "could not finalize" line any more (that
    // line belongs to an attempt the server actually rejected — RoundPage.test.tsx's own 409 pin
    // still covers it), because nothing was attempted here and nothing is at risk.
    const alert = page.getByRole("alert");
    await expect(alert).toHaveText("Nothing was finalized — 1 score hasn't sent yet. No score is lost; check your signal, then finalize again.");
    await expect(dialog).toBeVisible(); // stays open — retry is one tap away
    await expect(page.getByRole("heading", { name: "Final results" })).not.toBeVisible(); // never a silent/false finalize

    // The queued hole-2 score from step 2 is untouched by the refused finalize attempt — still
    // honestly pending, not lost and not double-counted. (This page has been offline since test
    // 2, so by now the chrome has almost certainly escalated — the count reads the same either
    // way, which is exactly what makes it the right thing to assert.)
    await expect(page.getByText(/^1 score saved on this phone/)).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
  });

  test("4: back online — the queue drains on its own via the browser's own online event, then Finalize succeeds for real", async () => {
    await context.setOffline(false);
    // No tap: coming back online fires the browser's own `online` event, and useRoundSession's
    // wake listener (apps/web, 2026-08-01) turns that straight into an immediate sync() call. Even
    // without that listener the SDK's own backoff loop — already retrying on its own the whole
    // time this context was offline — would pick this up unattended, but by then the loop is
    // stalled at its 30s cap, so the unattended path needs a ceiling past 30s to be the claim it
    // reads as. Hence 35s, not the file's 10s default: the wake collapses this to a round trip in
    // practice, and Playwright resolves as soon as the condition holds, so the taller ceiling
    // costs nothing on the passing path and removes a coin flip if the wake ever doesn't fire.
    // This negative means DRAINED, unambiguously: the count now appears in the escalated banner
    // too, so it can no longer disappear because the news got worse rather than because the queue
    // emptied — which is exactly what it would have done here, having been offline since test 2.
    await expect(page.getByText(/saved on this phone/)).not.toBeVisible({ timeout: 35_000 });

    await page.getByRole("button", { name: "Finalize round" }).click();
    await expect(page.getByRole("dialog", { name: "Confirm finalize" })).toBeVisible();
    await page.getByRole("button", { name: /^finalize$/i }).click();

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
