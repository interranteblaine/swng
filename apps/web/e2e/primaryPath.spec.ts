import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { CourseCard } from "@swng/domain";
import type { AuthTokens } from "../src/auth/tokenStore.js";
import { enterScore, ensureCourse, injectAuthTokens, mintAccountGolfer, mintThrowawayUser, screenshotPath } from "./support.js";

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
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    // The prompt resolves into the join form on the same visit (no navigation hop) — proof the
    // PUT landed and the account now renders by its real name, straight from the record.
    await expect(page.getByText("Playing as", { exact: true })).toBeVisible();
    await expect(page.getByRole("main").getByText(GOLFER_NAME, { exact: true })).toBeVisible();

    await page.screenshot({ path: screenshotPath("primary-path-funnel-named.png"), fullPage: true });
  });

  test("2: signed-in home -> Start a round shows 'Playing as' — no name field anywhere", async () => {
    await page.goto("/");
    await page.getByRole("link", { name: "Start a round", exact: true }).click();
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

    await page.getByRole("button", { name: "Create round", exact: true }).click();
    await expect(page).toHaveURL(/\/round\//);
  });

  test("3: 18 holes are scored on the real grid", async () => {
    for (let hole = 1; hole <= 18; hole += 1) {
      await enterScore(page, GOLFER_NAME, hole, 4);
    }
  });

  test("4: finalize through the real confirm dialog", async () => {
    await page.getByRole("button", { name: "Finalize round" }).click();
    await page.getByRole("dialog", { name: "Confirm finalize" }).getByRole("button", { name: "Finalize", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Final results" })).toBeVisible();
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
});
