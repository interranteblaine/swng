import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { CourseCard } from "@swng/domain";
import type { AuthTokens } from "../src/auth/tokenStore.js";
import { enterScore, ensureCourse, injectAuthTokens, mintThrowawayUser, screenshotPath } from "./support.js";

// The M8 gate's own headline (task-7-brief.md: "the user's manual smoke ... the flow that
// failed M7's smoke, now the headline"): a fresh golfer, signed in, plays a round AS THEMSELVES
// with no ghost, no ceremony, no typed name at round-creation — end to end through the REAL
// UI. Process law from M7's close (papercuts.md §4): every step after sign-in goes through
// rendered UI, no *Direct API substitutions anywhere in this file — the two allowed non-UI
// shortcuts are minting the JWT itself (USER_PASSWORD_AUTH, exactly like identityRecord.spec.ts's
// own precedent), since the Hosted UI form is the user's own separate manual smoke, not
// something this automated gate re-drives, and seeding the course via the public API
// (ensureCourse, below) — test-fixture setup, the same precedent every other spec's step 1
// already follows, not a step a golfer takes.
//
// "Playing as ... no name typed anywhere" (brief) is scoped to the round-creation step
// specifically: CreateRoundPage.tsx only shows the free-text "Your name" field for a
// signed-in golfer with NO account golfer yet (asSelf === false). A brand-new Cognito user
// has no golfer row at all (GET /me never creates — M7's own plan amendment), so this spec's
// own step 1 sets the golfer's name once, through ProfilePage's real form (PUT /me) — the one
// name entry in the whole file, and it happens before "Start a round" is ever visited, so
// THAT step genuinely never sees a name typed, matching the brief's own parenthetical exactly.
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

test.describe.serial("M8 primary path — the unmodified primary path, all-browser", () => {
  let page: Page;
  const courseName = `Primary Path GC ${Date.now()}`;
  const card = buildPrimaryPathCourseCard(courseName);

  test.beforeAll(async ({ browser }) => {
    // Minted BEFORE the context exists so injectAuthTokens' addInitScript registers before
    // this page's very first navigation — every goto() below, from / through /profile, runs
    // signed in (identityRecord.spec.ts's own beforeAll precedent).
    const tokens: AuthTokens = await mintThrowawayUser("primary-path");
    await ensureCourse(courseName, card); // course seeding via the public API is test-fixture setup, not a user-facing step — same precedent as every other spec's step 1
    const context = await browser.newContext();
    page = await context.newPage();
    await injectAuthTokens(page, tokens);
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test("1: the fresh golfer names themselves once, through the real Profile form", async () => {
    await page.goto("/profile");
    await page.getByLabel("Name", { exact: true }).fill(GOLFER_NAME);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Saved.");
  });

  test("2: signed-in home -> Start a round shows 'Playing as' — no name field anywhere", async () => {
    await page.goto("/");
    await page.getByRole("link", { name: "Start a round", exact: true }).click();
    await expect(page).toHaveURL(/\/create/);

    await page.getByLabel("Course", { exact: true }).fill(courseName);
    const result = page.getByRole("button", { name: courseName, exact: true }).first();
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
