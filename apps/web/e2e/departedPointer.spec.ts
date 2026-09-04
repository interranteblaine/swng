import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fixtureLinks } from "@swng/domain";
import { enterScore, ensureCourse, injectAuthTokens, joinRoundDirect, loadWebEnv, mintAccountGolfer, startRoundDirect } from "./support.js";
import type { AccountGolfer } from "./support.js";

// The 2026-09-04 ticket, in a real browser against the deployed stack.
//
// A golfer joined a live round, left without scoring, and the round kept waiting on them:
// `currentHoleNumber` (ScorecardGrid.tsx) returned the first hole where ANY participant lacked a
// cell, so their blank column pinned the gold "where are we" highlight to hole 1 for the rest of
// the round, on every phone — the marker that tells a group which hole to score, stuck on a hole
// they had already finished, because of someone who was not there.
//
// This file exists because NOTHING covered leaving a round: no other spec under apps/web/e2e
// appends a `participant-left` at all, which is how this reached a real user's round. The unit
// test in ScorecardGrid.test.tsx pins the predicate; this pins the DEPLOYED bundle, with the leave
// arriving over a real WebSocket rather than a hand-built fold.
//
// The complementary half is asserted in the same run, deliberately: the departed golfer KEEPS
// their column and their cells stay enterable. Hiding that column was designed, reviewed and
// rejected — it is the only surface that can mark a departed golfer's remaining holes picked-up,
// which is how a game resolves around an absence (accounts-only identity spec §4). A test that
// only proved the highlight moved would pass just as happily if the column had been deleted.
//
// Structure follows strokesCorrection.spec.ts: serial describe, two minted accounts, the round and
// the second seat created through the API before the browser opens, ONE page (score-for-anyone
// means the leaver's own browser is never needed), and the round entered through its permanent
// /rounds/:roundId address so the real re-mint path supplies the scoring credential.
test.describe.configure({ mode: "serial" });

const TEE = fixtureLinks.teeSets[0]!.name;

// The gold highlight is `aria-current="true"` on the hole's own <tr> (ScorecardGrid.tsx) — located
// by that attribute and read through the row's own aria-label, never a class, so a restyle cannot
// quietly turn this test green.
const currentHoleRow = (page: Page) => page.locator('tr[aria-current="true"]');

test.describe("a golfer who leaves stops holding the card at hole 1 (2026-09-04 ticket)", () => {
  let httpUrl: string;
  let page: Page;
  let hana: AccountGolfer;
  let wes: AccountGolfer;
  let roundId: string;
  let wesToken: string;

  test.beforeAll(async ({ browser }) => {
    hana = await mintAccountGolfer("departed-hana", "Hana");
    wes = await mintAccountGolfer("departed-wes", "Wes");
    ({ httpUrl } = loadWebEnv());
    const course = await ensureCourse(fixtureLinks.courseName, fixtureLinks, hana);

    const started = await startRoundDirect(httpUrl, hana, { course, tee: TEE });
    roundId = started.roundId;
    const joined = await joinRoundDirect(httpUrl, wes, { code: started.joinCode, tee: TEE });
    wesToken = joined.token;

    const context = await browser.newContext();
    page = await context.newPage();
    await injectAuthTokens(page, hana.tokens);
    await page.goto(`/rounds/${roundId}`);
    await expect(page.getByRole("heading", { name: "Roster" })).toBeVisible();
  });

  test("1: while Wes is still seated, his blank hole 1 correctly holds the pointer", async () => {
    await enterScore(page, "Hana", 1, 4);
    await enterScore(page, "Hana", 2, 5);

    // This is the assertion that proves the fix does not simply ignore anyone with a blank cell:
    // Wes is seated and playing, so the round genuinely IS still waiting on his hole 1.
    await expect(currentHoleRow(page)).toHaveAttribute("aria-label", /^Hole 1/);
  });

  test("2: Wes walks off — the pointer moves to where Hana actually is, live, no reload", async () => {
    // The real route: POST /rounds/{roundId}/leave with Wes's OWN participant token. Self-only by
    // construction — there is no body, so the leaver is whoever the token belongs to.
    const response = await fetch(`${httpUrl}/rounds/${roundId}/leave`, { method: "POST", headers: { authorization: `Bearer ${wesToken}` } });
    expect(response.ok, `POST /rounds/${roundId}/leave -> ${response.status}`).toBe(true);

    // Hana's page converges on its own: the leave arrives over the socket, the fold marks Wes
    // departed, and the pointer follows the golfer still playing. Holes 1-2 are Hana's, so 3.
    await expect(currentHoleRow(page)).toHaveAttribute("aria-label", /^Hole 3/, { timeout: 20_000 });
  });

  test("3: Wes keeps his column, his badge and his enterable cells — only the pointer ignores him", async () => {
    // The roster's "left" marker (spec-pinned) — proof this is a genuinely departed seat and not
    // one the leave never reached, rather than inferring departure from the pointer alone.
    await expect(page.getByText("left", { exact: true }).first()).toBeVisible();

    // The load-bearing half. §4 resolves a game around an absence by marking the departed
    // golfer's remaining holes picked-up, and these cells are the only place that can be done.
    const wesHole7 = page.getByRole("button", { name: "Wes hole 7" });
    await expect(wesHole7).toBeVisible();
    await expect(wesHole7).toBeEnabled();

    // Scoring for him still works — and still does not drag the pointer back onto his blanks.
    await enterScore(page, "Wes", 7, 6);
    await expect(currentHoleRow(page)).toHaveAttribute("aria-label", /^Hole 3/);
  });
});
