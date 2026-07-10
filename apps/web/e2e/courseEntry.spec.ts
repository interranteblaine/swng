import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { chip, gameKindSelect, joinRoundDirect, loadWebEnv, readJoinCode, waitForParticipant } from "./support.js";

// The M6 gate (docs/implementation-plan.md M6; docs/superpowers/plans/2026-07-09-m6-courses.md
// Task 6): a golfer enters a REAL course from its paper scorecard — search comes up empty,
// "Add a course" takes over, the full 18-hole grid is filled keyboard-only (the friction-proxy
// stand-in for the product's 10-minute paper-card bar), the card is verified, a round is
// created on it, and a singles match's dot allocation is checked hole-by-hole against
// hand-verified arithmetic (the plan's own Task 6 brief — never adjusted to match whatever the
// engines happen to compute; a disagreement is BLOCKED, not fudged). One Playwright context
// (unlike fieldTest.spec.ts's two) — the second player, Quinn, joins over a direct HTTP fetch
// exactly like fieldTest.spec.ts's Cal/Dee, so there's nothing here that needs a second
// browser.

// "Casa Verde GC", white tees, rating 71.1, slope 129 — the gate card, hand-verified in the
// plan (checks recorded there: stroke index is a permutation of 1..18, odd 1..17 on the front
// and even 2..18 on the back; par sums 36/36 = 72). Copied verbatim from the plan — this table
// IS the spec, not a derived value.
const CASA_VERDE_HOLES: readonly { readonly par: number; readonly yardage: number; readonly strokeIndex: number }[] = [
  { par: 4, yardage: 376, strokeIndex: 7 },
  { par: 5, yardage: 528, strokeIndex: 3 },
  { par: 4, yardage: 401, strokeIndex: 1 },
  { par: 3, yardage: 188, strokeIndex: 15 },
  { par: 4, yardage: 355, strokeIndex: 11 },
  { par: 4, yardage: 412, strokeIndex: 5 },
  { par: 3, yardage: 156, strokeIndex: 17 },
  { par: 5, yardage: 495, strokeIndex: 9 },
  { par: 4, yardage: 384, strokeIndex: 13 },
  { par: 4, yardage: 408, strokeIndex: 2 },
  { par: 3, yardage: 171, strokeIndex: 16 },
  { par: 4, yardage: 366, strokeIndex: 12 },
  { par: 5, yardage: 540, strokeIndex: 4 },
  { par: 4, yardage: 391, strokeIndex: 8 },
  { par: 3, yardage: 199, strokeIndex: 14 },
  { par: 4, yardage: 420, strokeIndex: 6 },
  { par: 5, yardage: 510, strokeIndex: 10 },
  { par: 4, yardage: 377, strokeIndex: 18 },
];

const DOT = "●"; // "●" — ScorecardGrid.tsx's own dot glyph (Cell's aria-hidden span)

// AddCoursePage's own par default: a golfer typing straight down the card only touches a par
// cell where the paper card differs from 4 (the "modal case" its own doc comment names). 8 of
// Casa Verde's 18 holes have par !== 4 — the other 10 are never touched at all below.
const isModalPar = (par: number): boolean => par === 4;

test.describe.serial("M6 course-entry gate — paper card to correct dots, against beta", () => {
  let page: Page;
  const courseName = `Casa Verde GC ${Date.now()}`; // per-run unique — a throwaway course on beta
  let joinCode = "";

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test("1: search comes up empty for a brand-new course name; 'Add a course' hands off to entry", async () => {
    await page.goto("/create");
    await page.getByLabel("Course", { exact: true }).fill(courseName);

    await expect(page.getByText("No courses found.")).toBeVisible();
    const addCourseLink = page.getByRole("link", { name: "Add a course" });
    await expect(addCourseLink).toBeVisible();
    await addCourseLink.click();

    await expect(page).toHaveURL(/\/courses\/new/);
  });

  test("2: the full 18-hole card is entered keyboard-only — par cells touched only where par !== 4", async () => {
    await page.getByLabel("Course name", { exact: true }).fill(courseName);
    await page.getByLabel("Your name", { exact: true }).fill("Pat");
    await page.getByLabel("Tee name", { exact: true }).fill("white");
    await page.getByLabel("Rating", { exact: true }).fill("71.1");
    await page.getByLabel("Slope", { exact: true }).fill("129");
    // 18 holes is the default toggle state (brief) — left untouched.

    // Zero pointer events from here on: one script-driven focus() call lands on Hole 1's par
    // field (not a click — locator.focus() never dispatches a mouse/pointer event), and every
    // field-to-field move from there is a Tab key press, riding the same native DOM tab order
    // AddCoursePage.test.tsx's own unit test pins (par, yardage, stroke index per row, top to
    // bottom, purely from render order — no explicit tabIndex).
    await page.getByLabel("Hole 1 par", { exact: true }).focus();

    for (const [index, hole] of CASA_VERDE_HOLES.entries()) {
      const holeNumber = index + 1;
      if (!isModalPar(hole.par)) {
        // Replace the default "4" — one Backspace (never a pointer-driven select-all) clears
        // the single default digit before typing the paper card's real one.
        await page.keyboard.press("Backspace");
        await page.keyboard.type(String(hole.par));
      }
      await page.keyboard.press("Tab");
      await page.keyboard.type(String(hole.yardage));
      await page.keyboard.press("Tab");
      await page.keyboard.type(String(hole.strokeIndex));
      if (holeNumber < CASA_VERDE_HOLES.length) await page.keyboard.press("Tab"); // -> next hole's par
    }

    // The grid-fill loop above never called .click() on a single grid input — that absence IS
    // the friction-proxy assertion. Pinning a few representative cells' final values (an
    // untouched default, a touched par, a touched SI, the last hole's yardage) catches a
    // tab-order regression the loop itself wouldn't otherwise surface.
    await expect(page.getByLabel("Hole 1 par", { exact: true })).toHaveValue("4"); // untouched default
    await expect(page.getByLabel("Hole 2 par", { exact: true })).toHaveValue("5"); // touched (par !== 4)
    await expect(page.getByLabel("Hole 3 stroke index", { exact: true })).toHaveValue("1");
    await expect(page.getByLabel("Hole 18 yardage", { exact: true })).toHaveValue("377");
    await expect(page.getByText("SI remaining: none")).toBeVisible(); // all 18 indexes placed, a real permutation

    await page.getByRole("button", { name: "Add course", exact: true }).click();
    await expect(page).toHaveURL(/\/create/);
  });

  test("3: verifying the card as Sam shows the '✓ 1 verified' badge", async () => {
    await expect(page.getByText(courseName, { exact: true })).toBeVisible();
    await expect(page.getByText(/not yet verified/)).toBeVisible();

    page.once("dialog", (dialog) => {
      void dialog.accept("Sam");
    });
    await page.getByRole("button", { name: "Verify this card", exact: true }).click();

    await expect(page.getByText(/✓ 1 verified/)).toBeVisible();
  });

  test("4: Pat creates the round on the new course (white, ch 21); Quinn joins over a direct HTTP fetch (ch 2)", async () => {
    await page.getByLabel("Your name", { exact: true }).fill("Pat");
    await page.getByLabel("Course handicap", { exact: true }).fill("21");
    await page.getByRole("button", { name: "Create round", exact: true }).click();

    await expect(page).toHaveURL(/\/round\//);
    joinCode = await readJoinCode(page);

    // Quinn joins over the wire, not a second browser — score-for-anyone (and this spec never
    // scores for Quinn) makes a second tab unnecessary, same precedent as fieldTest.spec.ts's
    // Cal/Dee.
    const { httpUrl } = loadWebEnv();
    await joinRoundDirect(httpUrl, { code: joinCode, name: "Quinn", tee: "white", courseHandicap: 2 });
    await waitForParticipant(page, "Quinn");
  });

  test("5: the singles match (Pat vs Quinn) is added via SetupPanel", async () => {
    await gameKindSelect(page).selectOption({ value: "singles-match" });
    await page.getByRole("combobox", { name: "Player A", exact: true }).selectOption({ label: "Pat" });
    await page.getByRole("combobox", { name: "Player B", exact: true }).selectOption({ label: "Quinn" });
    // Singles match defaults to 100% allowance (AddGameForm's changeKind re-anchor) — exactly
    // the brief's own allowance, so nothing here overrides it.
    await page.getByRole("button", { name: "Add game", exact: true }).click();

    await expect(chip(page, "Singles match")).toBeVisible();
  });

  test("6: dots match the hand-verified expectations exactly — Pat ●● on hole 3 (SI 1), ● everywhere else, Quinn none", async () => {
    // gameStrokeAllocation (packages/domain/src/scoring/allocation.ts): singles-match dots are
    // relative — chA=21, chB=2, allowance 1 (100%) -> diff = playingHandicap(19, 1) = 19; the
    // higher-handicap player (Pat) gets dotsByHole(19, whiteTee), the lower (Quinn) gets zero
    // everywhere. allocateStrokes(19, 18 holes): base = floor(19/18) = 1, extra = 19 % 18 = 1,
    // so every hole gets 1 and stroke-index 1 (hole 3) gets the 19th, for 2. If this ever
    // disagrees with what the grid actually renders, that's the plan's own BLOCKED condition —
    // not something this test may quietly re-derive or relax.
    const dotsOn = async (golfer: string, hole: number): Promise<number> => {
      const cell = page.getByRole("button", { name: `${golfer} hole ${hole}`, exact: true });
      const text = await cell.innerText();
      return (text.match(new RegExp(DOT, "g")) ?? []).length;
    };

    for (let hole = 1; hole <= 18; hole += 1) {
      const expectedPatDots = hole === 3 ? 2 : 1;
      expect(await dotsOn("Pat", hole), `Pat hole ${hole}`).toBe(expectedPatDots);
      expect(await dotsOn("Quinn", hole), `Quinn hole ${hole}`).toBe(0);
    }
  });

  test("7: scoring hole 1 two-tap renders net = gross - dots (Pat 5 on a 1-dot hole nets 4)", async () => {
    const cell = page.getByRole("button", { name: "Pat hole 1", exact: true });
    await cell.click(); // tap 1
    const dialog = page.getByRole("dialog", { name: "Score for Pat, hole 1", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "5", exact: true }).click(); // tap 2
    await expect(dialog).toBeHidden(); // pad closes on the posting tap — no confirm step

    await expect(cell).toHaveText(`${DOT}54`); // 1 dot, gross 5, net 5 - 1 = 4, concatenated with no separators
  });
});
