import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { CourseCard } from "@swng/domain";
import type { AuthTokens } from "../src/auth/tokenStore.js";
import { enterScore, ensureCourse, injectAuthTokens, mintAccountGolfer, mintThrowawayUser, normallyShootsField, screenshotPath } from "./support.js";

// The primary path, accounts-only (the original M8 headline, rewritten for the wall): a fresh
// golfer signs in, names themselves ONCE at the funnel's own prompt, and plays a round as
// themselves — end to end through the REAL UI. Process law from M7's close (papercuts.md §4):
// every step after sign-in goes through rendered UI, no *Direct API substitutions anywhere in
// this file — the two allowed non-UI shortcuts are minting the JWT itself
// (USER_PASSWORD_AUTH; Cognito's stock Hosted-UI sign-up form is the controller's own live
// spot-walk, not something this automated gate re-drives) and seeding the course via the
// public API (ensureCourse, below) — test-fixture setup, the same precedent every other
// spec's step 1 already follows, not a step a golfer takes.
//
// "One name typed once" now lives at the funnel prompt (accounts-only identity spec §2): a
// brand-new account's first GET /me MINTS a placeholder-named golfer ("Golfer NNNN"), and the
// join funnel — most people's first landing — asks its one required question, "What should
// the card call you?", a PUT of the name at the highest-motivation moment. Step 1 drives
// exactly that: the fresh golfer lands on /join, is asked, answers once. Every later step
// renders the name from the record — CreateRoundPage has no name field at all (step 2's
// structural pin), so no other step COULD type one.
const buildPrimaryPathCourseCard = (courseName: string): CourseCard => ({
  courseName,
  teeSets: [
    {
      name: "member",
      rating: 71.6,
      slope: 128,
      holes: Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4, yardage: 380, strokeIndex: i + 1 })),
    },
  ],
});

const GOLFER_NAME = "Primary Path Golfer";

test.describe.serial("primary path — sign in, one name at the funnel prompt, a round as yourself, all-browser", () => {
  let page: Page;
  const courseName = `Primary Path GC ${Date.now()}`;
  const card = buildPrimaryPathCourseCard(courseName);

  test.beforeAll(async ({ browser }) => {
    // Minted BEFORE the context exists so injectAuthTokens' addInitScript registers before
    // this page's very first navigation — every goto() below, from / through /profile, runs
    // signed in (identityRecord.spec.ts's own beforeAll precedent).
    const tokens: AuthTokens = await mintThrowawayUser("primary-path");
    // Course seeding is a golfer-gated write now (course-cards spec §4) but still pure
    // test-fixture setup, not a user-facing step — so it uses a SEPARATE, already-named seed
    // account (a real golfer with a name is required to author a course), leaving the funnel's
    // own `tokens` un-named so the in-browser name prompt this spec exists to cover still fires.
    const seedAccount = await mintAccountGolfer("primary-path-seed", "Seed");
    await ensureCourse(courseName, card, seedAccount);
    const context = await browser.newContext();
    page = await context.newPage();
    await injectAuthTokens(page, tokens);
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test("1: the fresh golfer names themselves once, at the funnel's own name prompt", async () => {
    // The funnel is the first landing (spec §2: "for most people the join-link funnel") — the
    // account's very first GET /me mints a placeholder golfer, so /join renders the one
    // required question before any join form. Answering it is the ONE name entry in this file.
    await page.goto("/join");
    await page.getByLabel("What should the card call you?").fill(GOLFER_NAME);
    await page.getByRole("button", { name: /^continue$/i }).click();

    // The prompt resolves into the join form on the same visit (no navigation hop) — proof the
    // PUT landed and the account now renders by its real name, straight from the record.
    await expect(page.getByText("Playing as", { exact: true })).toBeVisible();
    await expect(page.getByRole("main").getByText(GOLFER_NAME, { exact: true })).toBeVisible();

    await page.screenshot({ path: screenshotPath("primary-path-funnel-named.png"), fullPage: true });
  });

  test("2: signed-in home -> Start a round shows 'Playing as' — no name field anywhere", async () => {
    await page.goto("/");
    await page.getByRole("link", { name: /^start a round$/i }).click();
    await expect(page).toHaveURL(/\/create/);

    await page.getByLabel("Course", { exact: true }).fill(courseName);
    const result = page.getByRole("button", { name: `${courseName} · ${card.teeSets[0]!.holes.length} holes`, exact: true }).first(); // CourseSearch renders "name · N holes"
    await expect(result).toBeVisible();
    await result.click();

    await expect(page.getByText("Playing as", { exact: true })).toBeVisible();
    // Scoped to <main> — the header chrome (App.tsx's AuthChrome) ALSO renders the golfer's
    // name as a "/profile" link, so an unscoped getByText resolves to two elements.
    await expect(page.getByRole("main").getByText(GOLFER_NAME, { exact: true })).toBeVisible();
    // CreateRoundPage.tsx: the free-text "Your name" field and the "Playing as" block are
    // mutually exclusive branches — its absence here IS the "no name typed anywhere" assertion.
    await expect(page.getByLabel("Your name", { exact: true })).toHaveCount(0);

    await page.screenshot({ path: screenshotPath("primary-path-playing-as.png"), fullPage: true });

    // Required, not optional (spec 2026-07-29 §2): the one number a player states about themselves
    // has no default, because "0" would assert "I shoot par" — a real claim — so CreateRoundPage
    // starts it BLANK and keeps Create round disabled until it parses. This step used to lean on
    // the old field's "0" default and never touch it; a primary path that submits nothing this
    // form requires is not the primary path.
    await normallyShootsField(page).fill("18");

    const create = page.getByRole("button", { name: /^create round$/i });
    await expect(create).toBeEnabled();
    await create.click();
    await expect(page).toHaveURL(/\/round\//);
  });

  test("3: 18 holes are scored on the real grid", async () => {
    for (let hole = 1; hole <= 18; hole += 1) {
      await enterScore(page, GOLFER_NAME, hole, 4);
    }
  });

  test("4: finalize through the real confirm dialog; the finished round states gross, strokes and net", async () => {
    await page.getByRole("button", { name: "Finalize round" }).click();
    await page.getByRole("dialog", { name: "Confirm finalize" }).getByRole("button", { name: /^finalize$/i }).click();
    await expect(page.getByRole("heading", { name: "Final results" })).toBeVisible();

    // ADDED BY TASK 8 (beyond the brief's own locator sweep): "the finished round stops speaking
    // WHS" (spec 2026-07-29 §4) replaced ResultsView's "Posted to handicaps" section with a
    // "Final totals" list of gross · strokes · net, and NOTHING in the live suites asserted the new
    // surface — the exact blind spot this task exists to close. The primary path is where it
    // belongs: this is the one all-browser gate that plays a whole round and finalizes it.
    //
    // DERIVED BY HAND from this file's own fixture: the card is 18 holes of par 4 (par 72) and
    // test 3 scored a flat 4 on every hole, so gross = 72. This golfer plays ALONE, so they are
    // their own anchor and the stated +18 derives 0 strokes (spec §2b) — net = 72 − 0 = 72.
    // ResultsView.tsx renders the row as `{name} — {gross} gross · {strokesLabel} · {net} net`,
    // with strokesLabel(0) === "0" (never "−0"). Scoped to the aria-labelled list because the
    // read-only card below it prints its own totals from the SAME grossForHoles.
    await expect(page.getByRole("list", { name: "Final totals" })).toContainText("72 gross · 0 · 72 net");
  });

  test("5: Profile shows the round's history line", async () => {
    await page.goto("/profile");

    // getMyRecord's history is populated by the DynamoDB Streams projector (packages/lambda/
    // src/entries/projector.ts) — asynchronous relative to finalize's own HTTP response
    // (identityRecord.spec.ts's own pollRecord doc comment). ProfilePage fetches once per
    // mount and never re-polls itself, so a real golfer's own recourse here is exactly what
    // this loop does: reload and look again — toPass keeps that entirely inside the UI, no
    // *Direct API call standing in for the wait.
    const historyList = page.locator("xpath=//h3[normalize-space(text())='History']/following-sibling::ul[1]");
    await expect(async () => {
      await page.reload();
      await expect(historyList.getByRole("listitem")).toHaveCount(1, { timeout: 3_000 });
    }).toPass({ timeout: 60_000 });

    await expect(historyList).toContainText(courseName);

    await page.screenshot({ path: screenshotPath("primary-path-profile-history.png"), fullPage: true });
  });

  test("6: the history row opens the round record; the round page's own heading course link opens the course page", async () => {
    // A history row is ONE whole-row link (RecordSections.tsx's HistoryList, owner-ruled
    // 2026-07-20 — a history row IS the round) — its href starts with /rounds/, which is what
    // makes it clickable without depending on the exact score/tee text the row renders.
    const historyList = page.locator("xpath=//h3[normalize-space(text())='History']/following-sibling::ul[1]");
    await historyList.locator('a[href^="/rounds/"]').first().click();

    // The round's ONE permanent address (navigation spec §7) — RoundRecordPage renders the same
    // ResultsView test 4's own finalize already proved out.
    await expect(page).toHaveURL(/\/rounds\/[^/]+$/);
    await expect(page.getByRole("heading", { name: "Final results" })).toBeVisible();

    // RoundRecordPage's own heading (spec §7/link sweep): the course name is linked (the frozen
    // card carries a courseId — ensureCourse seeded a real course above), the date stays plain
    // text right after it — click the course half.
    await page.getByRole("link", { name: courseName, exact: true }).click();

    await expect(page).toHaveURL(/\/courses\/[^/]+$/);
    await expect(page.getByRole("heading", { name: courseName, exact: true })).toBeVisible();

    await page.screenshot({ path: screenshotPath("primary-path-round-to-course.png"), fullPage: true });
  });
});
