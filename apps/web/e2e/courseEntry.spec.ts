import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fixtureLinks18 } from "@swng/domain";
import { roundLabel } from "../src/roundLabel.js";
import {
  addSinglesGame,
  chip,
  ensureCourse,
  enterScore,
  getMyRecordDirect,
  injectAuthTokens,
  joinRoundDirect,
  loadWebEnv,
  mintAccountGolfer,
  openGamePanel,
  pollUntil,
  readJoinCode,
  setStrokesInBrowser,
  waitForParticipant,
} from "./support.js";
import type { AccountGolfer } from "./support.js";

// The M6 gate (docs/implementation-plan.md M6; docs/superpowers/plans/2026-07-09-m6-courses.md
// Task 6), rewritten for the Courses arc's landed surface (course-cards spec): a golfer enters
// a REAL course from its paper scorecard — search comes up empty, "Add a course" takes over,
// the full 18-hole grid is filled keyboard-only (the friction-proxy stand-in for the product's
// 10-minute paper-card bar), submitting lands on the course's own hub page (CoursePage, not a
// hand-off back into /create), a second tee is added there via "Add a tee", a round is created
// on the card from that hub, and a singles match's dot allocation is checked hole-by-hole
// against hand-verified arithmetic (the plan's own Task 6 brief — never adjusted to match
// whatever the engines happen to compute; a disagreement is BLOCKED, not fudged). One
// Playwright context (unlike fieldTest.spec.ts's two) — the second player, Quinn, joins over a
// direct HTTP fetch exactly like fieldTest.spec.ts's Cal/Dee, so there's nothing here that needs
// a second browser. Accounts-only (the wall): Pat and Quinn are both signed-in accounts, minted
// and named by the harness — round creation and course entry are both sign-in-gated now, there
// is no free-text name field anywhere in this flow (attribution on a course card, like a
// round's own roster, is auth-derived), and Pat's page runs signed in from its very first
// navigation.

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

// A datetime-local input's value is a LOCAL wall-clock string with no zone, e.g.
// "2026-07-29T14:05" — the same algorithm CreateRoundPage.tsx's own (unexported)
// toDatetimeLocalValue uses to seed the field, duplicated here rather than imported (that file
// pulls in react-router and can't be loaded outside a Vite build, the same reason every other
// *Direct helper in support.ts hand-rolls its own fetch instead of reusing api.ts). Round-trips
// through `new Date(value).getTime()` — the exact parse CreateRoundPage.tsx's submit handler
// applies — to get the instant this test expects to see stored and rendered.
const pad = (n: number): string => String(n).padStart(2, "0");
const toDatetimeLocalValue = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

// The strokes the group agreed for Pat, typed onto the roster in test 5 (spec 2026-07-30 §2).
// Quinn stays on the default 0. 19 on an 18-hole card is deliberately just over a full lap, so
// test 7's per-hole table exercises the wrap.
const PAT_STROKES = 19;

// AddCoursePage's own par default: a golfer typing straight down the card only touches a par
// cell where the paper card differs from 4 (the "modal case" its own doc comment names). 8 of
// Casa Verde's 18 holes have par !== 4 — the other 10 are never touched at all below.
const isModalPar = (par: number): boolean => par === 4;

// Zero pointer events: one script-driven focus() call lands on Hole 1's par field (not a click
// — locator.focus() never dispatches a mouse/pointer event), and every field-to-field move from
// there is a Tab key press, riding the same native DOM tab order AddCoursePage.test.tsx's own
// unit test pins (par, yardage, stroke index per row, top to bottom, purely from render order —
// no explicit tabIndex). HoleGrid.tsx is the ONE grid component both AddCoursePage and
// EditCoursePage's add-a-tee mode render, with identical `Hole {n} par/yardage/stroke index`
// aria-labels and the same tab order either way — so this one function is exactly what the
// brief means by "reuse the same fill helper" for the new tee, not a second hand-copy.
const fillHoleGridKeyboardOnly = async (page: Page): Promise<void> => {
  await page.getByLabel("Hole 1 par", { exact: true }).focus();

  for (const [index, hole] of CASA_VERDE_HOLES.entries()) {
    const holeNumber = index + 1;
    if (!isModalPar(hole.par)) {
      // Replace the default "4" — one Backspace (never a pointer-driven select-all) clears the
      // single default digit before typing the paper card's real one.
      await page.keyboard.press("Backspace");
      await page.keyboard.type(String(hole.par));
    }
    await page.keyboard.press("Tab");
    await page.keyboard.type(String(hole.yardage));
    await page.keyboard.press("Tab");
    await page.keyboard.type(String(hole.strokeIndex));
    if (holeNumber < CASA_VERDE_HOLES.length) await page.keyboard.press("Tab"); // -> next hole's par
  }
};

test.describe.serial("M6 course-entry gate — paper card to correct dots, against beta", () => {
  let page: Page;
  const courseName = `Casa Verde GC ${Date.now()}`; // per-run unique — a throwaway course on beta
  let courseId = "";
  let joinCode = "";
  let quinn: AccountGolfer;

  test.beforeAll(async ({ browser }) => {
    // Pat's tokens are injected before the page's first navigation (CreateRoundPage and
    // AddCoursePage are both sign-in-gated); Quinn's account exists purely for his own
    // out-of-browser self-join in test 5. Both named via PUT /me — the record, not free text, is
    // what lands on the card and the round.
    const pat = await mintAccountGolfer("course-pat", "Pat");
    quinn = await mintAccountGolfer("course-quinn", "Quinn");
    const context = await browser.newContext();
    page = await context.newPage();
    await injectAuthTokens(page, pat.tokens);
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

  test("2: the full 18-hole card is entered keyboard-only — no 'Your name' field, par cells touched only where par !== 4", async () => {
    // enteredBy derives from the signed-in account server-side now (course-cards spec §4) — the
    // wall against wire-supplied attribution is that this field doesn't exist to fill.
    await expect(page.getByLabel("Your name", { exact: true })).toHaveCount(0);

    await page.getByLabel("Course name", { exact: true }).fill(courseName);
    await page.getByLabel("Tee name", { exact: true }).fill("white");
    await page.getByLabel("Rating", { exact: true }).fill("71.1");
    await page.getByLabel("Slope", { exact: true }).fill("129");
    // 18 holes is the default toggle state (brief) — left untouched.

    await fillHoleGridKeyboardOnly(page);

    // The grid-fill loop above never called .click() on a single grid input — that absence IS
    // the friction-proxy assertion. Pinning a few representative cells' final values (an
    // untouched default, a touched par, a touched SI, the last hole's yardage) catches a
    // tab-order regression the loop itself wouldn't otherwise surface.
    await expect(page.getByLabel("Hole 1 par", { exact: true })).toHaveValue("4"); // untouched default
    await expect(page.getByLabel("Hole 2 par", { exact: true })).toHaveValue("5"); // touched (par !== 4)
    await expect(page.getByLabel("Hole 3 stroke index", { exact: true })).toHaveValue("1");
    await expect(page.getByLabel("Hole 18 yardage", { exact: true })).toHaveValue("377");
    await expect(page.getByText("SI remaining: none")).toBeVisible(); // all 18 indexes placed, a real permutation

    await page.getByRole("button", { name: /^add course$/i }).click();

    // Success lands on the course's own hub now (course-cards spec §7), not back on /create.
    // The (?!new$) lookahead is load-bearing: the PRE-click URL is /courses/new, which a bare
    // /\/courses\/[^/]+$/ already matches (the submit handler awaits the API before navigate()),
    // so without it this wait resolves immediately and courseId captures as the literal "new".
    await expect(page).toHaveURL(/\/courses\/(?!new$)[^/]+$/);
    courseId = new URL(page.url()).pathname.split("/").pop() ?? "";
    expect(courseId).not.toBe("");
  });

  test("3: the course hub shows the heading, attribution, and hole 1's own par/SI in the read-only table", async () => {
    await expect(page.getByRole("heading", { name: courseName, exact: true })).toBeVisible();
    await expect(page.getByText(/entered by Pat/)).toBeVisible();

    // The hole table's rows carry no aria-label of their own (CoursePage.tsx renders a plain
    // <table>), so a native ARIA `row`/`cell` lookup is the reliable way in — index 0 is the
    // header row (Hole/Par/Yards/SI), index 1 is hole 1 (holes render in card order).
    const holeOneRow = page.getByRole("row").nth(1);
    const holeOneCells = holeOneRow.getByRole("cell");
    await expect(holeOneCells.nth(1)).toHaveText(String(CASA_VERDE_HOLES[0]!.par));
    await expect(holeOneCells.nth(3)).toHaveText(String(CASA_VERDE_HOLES[0]!.strokeIndex));
  });

  test("4: 'Add a tee' adds blue (73.0/133) — both tees show on the hub afterward", async () => {
    await page.getByRole("link", { name: "Add a tee", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Add a tee", exact: true })).toBeVisible();
    await expect(page.getByLabel("Tee name", { exact: true })).toBeVisible();

    // No "Course name"/"Tee to edit" interaction needed: add-tee mode pre-fills the course name
    // from the loaded card and hides the tee-to-edit picker entirely (EditCoursePage.tsx) — this
    // form only ever names the NEW tee.
    await page.getByLabel("Tee name", { exact: true }).fill("blue");
    await page.getByLabel("Rating", { exact: true }).fill("73.0");
    await page.getByLabel("Slope", { exact: true }).fill("133");

    // Same fill helper as white's own grid — par values may repeat white's (dots are asserted
    // on white only, never on blue), so there's nothing here that needs a second hand-typed table.
    await fillHoleGridKeyboardOnly(page);
    await expect(page.getByText("SI remaining: none")).toBeVisible();

    await page.getByRole("button", { name: /^save changes$/i }).click();

    await expect(page).toHaveURL(/\/courses\/[^/]+$/);
    expect(page.url()).toContain(`/courses/${courseId}`);

    // Both tees now on the card, white first (untouched, passed through verbatim) then blue
    // (appended) — EditCoursePage's own add-tee assembly order.
    const teeSelect = page.getByRole("combobox", { name: "Tee", exact: true });
    await expect(teeSelect.locator("option")).toHaveCount(2);
    await expect(teeSelect.locator("option").nth(0)).toHaveText(/^white — /);
    await expect(teeSelect.locator("option").nth(1)).toHaveText(/^blue — /);
  });

  test("5: 'Start a round here' preselects the course; Pat creates the round on white stating +21; Quinn joins as himself over a direct HTTP fetch stating +2", async () => {
    await page.getByRole("link", { name: /^start a round here$/i }).click();
    await expect(page).toHaveURL(/\/create/);

    // The preselect (CoursePage's own router-state hand-off) lands with the card's FIRST tee
    // selected — white, since it was entered before blue.
    await expect(page.getByText(courseName, { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Tee", exact: true })).toHaveValue("white");

    // No name entry here: CreateRoundPage renders "Playing as Pat" from the signed-in account's
    // own record — the create form has no name field to fill anymore.
    await expect(page.getByText("Playing as", { exact: true })).toBeVisible();
    // The form asks nothing about anyone's game (spec 2026-07-30 §9) — a course and a tee is the
    // whole thing.
    await page.getByRole("button", { name: /^create round$/i }).click();

    await expect(page).toHaveURL(/\/round\//);
    joinCode = await readJoinCode(page);

    // Quinn joins over the wire, not a second browser — score-for-anyone (and this spec never
    // scores for Quinn) makes a second tab unnecessary, same precedent as fieldTest.spec.ts's
    // Cal/Dee — but as HIMSELF, with his own Bearer (self-join is the only way onto a card).
    const { httpUrl } = loadWebEnv();
    await joinRoundDirect(httpUrl, quinn, { code: joinCode, tee: "white" });
    await waitForParticipant(page, "Quinn");

    // The number the group agreed, typed onto the roster through the real editor (spec §2/§8).
    // Quinn stays on the default 0 — the better player, giving strokes, never receiving any.
    await setStrokesInBrowser(page, "Pat", PAT_STROKES);
  });

  test("6: the singles match (Pat vs Quinn) is added via SetupPanel", async () => {
    // No allowance to set: the percentage table is deleted (spec 2026-07-30 §3) — a match is
    // played off the difference between the two roster numbers, full stop, so AddGameForm's
    // match-play arm offers only the two player pickers addSinglesGame drives.
    await addSinglesGame(page, "Pat", "Quinn");

    await expect(chip(page, "Match play")).toBeVisible();
  });

  test("7: the STANDARD CARD's dots match the hand-verified expectations exactly — each player's own roster strokes (Pat 19, Quinn 0), no game", async () => {
    // spec 2026-07-19 §2a: the card never changes — ScorecardGrid always renders
    // roundStrokeAllocation (packages/domain/src/scoring/allocation.ts), each player's own
    // roster strokes allocated by stroke index, no game (chip taps don't touch the grid).
    //
    // DERIVED BY HAND from the numbers typed in test 5 — Pat 19, Quinn 0 — on an 18-hole card.
    // allocateStrokes(19, 18 holes): base = floor(19/18) = 1, extra = 19 % 18 = 1 → EVERY hole
    // gets 1 dot and the single hardest hole (stroke index 1 = hole 3 on this card) gets a 2nd.
    // allocateStrokes(0, 18 holes) is all zeros.
    // If this ever disagrees with what the grid actually renders, that's the plan's own BLOCKED
    // condition — not something this test may quietly re-derive or relax.
    const dotsOn = async (golfer: string, hole: number): Promise<number> => {
      const cell = page.getByRole("button", { name: `${golfer} hole ${hole}`, exact: true });
      const text = await cell.innerText();
      return (text.match(new RegExp(DOT, "g")) ?? []).length;
    };

    const PAT_TWO_DOT_HOLES = new Set([3]); // stroke index 1 — the one "extra" hole of Pat's 19
    const QUINN_ONE_DOT_HOLES = new Set<number>(); // Quinn is on 0 strokes: no dot anywhere

    for (let hole = 1; hole <= 18; hole += 1) {
      const expectedPatDots = PAT_TWO_DOT_HOLES.has(hole) ? 2 : 1;
      const expectedQuinnDots = QUINN_ONE_DOT_HOLES.has(hole) ? 1 : 0;
      expect(await dotsOn("Pat", hole), `Pat hole ${hole}`).toBe(expectedPatDots);
      expect(await dotsOn("Quinn", hole), `Quinn hole ${hole}`).toBe(expectedQuinnDots);
    }
  });

  test("8: the Match play PANEL states the match's own strokes — resolved off the GAME's field — opened with ONE chip tap", async () => {
    // A singles match is played off the DIFFERENCE (spec 2026-07-30 §3), and Quinn is already on
    // 0, so the match's own allocation coincides with the card's here: Pat 19 − 0 = 19, Quinn 0.
    // (The two diverge whenever the lower member is above 0 — the domain's own allocation.test.ts
    // pins that case, including the holes the dots land on.) There is no allowance percentage.
    // strokesSummary (apps/web/src/round/dots.ts) omits Quinn entirely — a member with zero
    // strokes is left off the line rather than printed as "Quinn 0 dots".
    const panel = await openGamePanel(page, "Match play");
    await expect(panel).toContainText("Pat 19 dots");
  });

  test("9: scoring hole 1 two-tap renders net = gross - dots (Pat 5 on a 1-dot hole nets 4)", async () => {
    const cell = page.getByRole("button", { name: "Pat hole 1", exact: true });
    await cell.click(); // tap 1
    const dialog = page.getByRole("dialog", { name: "Score for Pat, hole 1", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "5", exact: true }).click(); // tap 2
    await expect(dialog).toBeHidden(); // pad closes on the posting tap — no confirm step

    await expect(cell).toHaveText(`${DOT}54`); // 1 dot, gross 5, net 5 - 1 = 4, concatenated with no separators
  });
});

// --- The round-played-date beat (spec 2026-08-01, plan Task 9 Step 2) -----------------------
// A round dated through the real "When did you play?" field on CreateRoundPage reads as that
// day everywhere the played date surfaces: the projection line served to GET /me/record and the
// canonical roundLabel rendered on the round's own permanent address. THREE DAYS BACK,
// deliberately, not a few seconds — this arc's own spec (§9) names by number the mistake of
// shipping a beat whose played instant and creation instant render identically on a
// day-granular label, which can never fail. This is a fresh, small describe block (own account,
// own throwaway round, its own fixtureLinks18 round rather than a hand-typed card) instead of a
// tenth test folded into the M6 gate above: that block's own Pat/Quinn round is mid-narrative
// (a singles match, one hole scored) this beat has no business touching or depending on — it
// shares only this file's "drives CreateRoundPage's real form" home, the same precedent
// fieldTest.spec.ts already sets with its own second, independent describe block below the M5
// field test.
test.describe.serial("round-played-date gate — a round entered three days late reads as three days late", () => {
  let page: Page;
  let account: AccountGolfer;

  test.beforeAll(async ({ browser }) => {
    account = await mintAccountGolfer("playedat-golfer", "Retro");
    // fixtureLinks18 (shared across specs, idempotently re-seeded by ensureCourse) — this beat
    // is about the played date, not course entry, so there's no reason to type an 18-hole card
    // by hand a second time in this file.
    await ensureCourse(fixtureLinks18.courseName, fixtureLinks18, account);
    const context = await browser.newContext();
    page = await context.newPage();
    await injectAuthTokens(page, account.tokens);
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test("10: created three days back through the real form; the history row's playedAt and the round's own roundLabel both name that day", async () => {
    test.setTimeout(90_000);
    const { httpUrl } = loadWebEnv();

    // A calendar day, not a few seconds (binding constraint, spec §9): three days back
    // guarantees a different weekday under roundLabel's "Sat, Jul 12" day-granular rendering no
    // matter what time of day this suite happens to run.
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const playedAtInput = toDatetimeLocalValue(threeDaysAgo);
    // Parsed back through the SAME "no zone -> local time" rule CreateRoundPage.tsx's own submit
    // handler applies (`new Date(playedAt).getTime()`) — not threeDaysAgo.getTime() directly,
    // since a datetime-local field carries no seconds and would silently truncate them.
    const expectedPlayedAtMs = new Date(playedAtInput).getTime();

    await page.goto("/create");
    await page.getByLabel("Course", { exact: true }).fill(fixtureLinks18.courseName);
    // Full "name · N holes" accessible name (CourseSearch.tsx) — the precedent every other spec
    // searching this exact fixture already uses (fieldTest.spec.ts, its own M7 describe block).
    const result = page
      .getByRole("button", { name: `${fixtureLinks18.courseName} · ${fixtureLinks18.teeSets[0]!.holes.length} holes`, exact: true })
      .first();
    await expect(result).toBeVisible();
    await result.click();

    // "When did you play?" (round-played-date spec §5) — always visible, defaulting to now;
    // overwritten with the exact instant this test expects to see stored and rendered.
    await page.getByLabel("When did you play?", { exact: true }).fill(playedAtInput);

    await page.getByRole("button", { name: "Create round" }).click();
    await expect(page).toHaveURL(/\/round\//);
    const roundId = new URL(page.url()).pathname.split("/").pop() ?? "";
    expect(roundId).not.toBe("");

    // No games on this round, so finalize is unblocked the moment scoring stops
    // (unresolvedGames returns nothing for a gameless round) — two holes is enough to prove the
    // form -> sealed-snapshot path without re-typing an 18-hole card (same precedent as
    // strokesCorrection.spec.ts's two-of-nine, unratedCourse.spec.ts's two-of-nine).
    await enterScore(page, "Retro", 1, 4);
    await enterScore(page, "Retro", 2, 5);

    await page.getByRole("button", { name: "Finalize round" }).click();
    await page
      .getByRole("dialog", { name: "Confirm finalize" })
      .getByRole("button", { name: /^finalize$/i })
      .click();
    await expect(page.getByRole("heading", { name: "Final results" })).toBeVisible({ timeout: 60_000 });

    // The projection: GET /me/record's history line carries the exact instant typed into the
    // form (round-played-date spec §4), not the moment the record was actually created a few
    // seconds before this line runs — the DynamoDB Streams projector is asynchronous relative to
    // finalize's own HTTP response, so this polls the same way every other record-after-finalize
    // beat in this suite does (unratedCourse.spec.ts, identityRecord.spec.ts).
    const record = await pollUntil(
      () => getMyRecordDirect(httpUrl, account.tokens.idToken),
      (r) => r.history.some((line) => line.roundId === roundId),
      60_000,
      "GET /me/record carries the new round",
    );
    const line = record.history.find((entry) => entry.roundId === roundId);
    expect(line?.playedAt).toBe(expectedPlayedAtMs);

    // The screen: the round's own permanent address (RoundRecordPage, navigation spec §7) reads
    // the archive directly (no projector lag) and renders roundLabel over the SAME played
    // instant — course + the day three days back, never today. Scoped to the ONE `font-serif`
    // paragraph this page renders (RoundRecordPage.tsx's own heading line — verified against no
    // other element on this render tree carrying that class) because the course-name half wears
    // a link here (ensureCourse's card carries a real source, navigation spec's link sweep) —
    // `toHaveText` reads the whole element's text content, link included, so the split doesn't
    // matter the way a bare `getByText(exact)` lookup would.
    await page.goto(`/rounds/${roundId}`);
    await expect(page.getByRole("heading", { name: "Final results" })).toBeVisible();
    const expectedLabel = roundLabel({ courseName: fixtureLinks18.courseName, playedAt: expectedPlayedAtMs });
    await expect(page.locator("p.font-serif")).toHaveText(expectedLabel);
    // usePageTitle's own " · swng" suffix (apps/web/src/ui/usePageTitle.ts) — the SAME roundLabel
    // string, doubly pinned via the browser tab title.
    await expect(page).toHaveTitle(`${expectedLabel} · swng`);
  });
});
