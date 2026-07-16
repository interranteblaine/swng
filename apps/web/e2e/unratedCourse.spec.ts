import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  chip,
  createScoreOps,
  enterScore,
  finalizeRoundDirect,
  gameKindSelect,
  getCourseDirect,
  getMyRecordDirect,
  injectAuthTokens,
  joinRoundDirect,
  loadWebEnv,
  mintAccountGolfer,
  pollUntil,
  readJoinCode,
  recordScoreDirect,
  startRoundDirect,
  waitForParticipant,
} from "./support.js";
import type { AccountGolfer } from "./support.js";

// The unrated-courses arc gate (docs/superpowers/specs/2026-07-14/15 unrated-courses; Task 6):
// a REAL 9-hole course with NO course rating plays end-to-end — its scorecard, games, and dots
// work exactly as a rated course's do (dots come from stroke index + course handicap, which the
// missing rating never touches), a finalized round posts an AGS but NO handicap differential
// (unrated → not postable), the golfer's WHS index is never moved by it, and the round's
// difficulty-neutral (ags − par) pseudo-differential feeds the SWNG index — the declaration
// aid an unrated golfer reasonably puts in their declared field.
//
// THE PAIRING TRAP (spec's own headline risk — and a correction to the task brief's own
// arithmetic): the swng index reuses domain's published 2020 nine-hole pairing
// (combineNineHoleDifferentials) and the Rule 5.2a small-sample table (computeIndexDetail).
// computeIndexDetail is UNDEFINED below THREE differentials (packages/domain/src/handicap/
// whs.test.ts: "is undefined under three scores"; "swngIndex is undefined below the
// 3-differential bootstrap"). Two 9-hole rounds pair into exactly ONE combined pseudo-
// differential → still below the bootstrap → swngIndex ABSENT. A 9-hole course therefore
// needs SIX finalized rounds (three oldest-first pairs → three combined pseudo-differentials)
// before the swng index materializes — NOT two. Every expected number below (the pars/SIs,
// the singles-match dots, the AGS per round, and the swng index itself) was hand-pinned and
// cross-checked against the real domain engines BEFORE any live call, and is asserted verbatim:
// a live disagreement is a BLOCKED finding to escalate, never a pin quietly adjusted to match
// observed output (the run's-the-oracle inversion).
//
// Everything is browser-driven where the story needs a browser (course entry, whose "unrated"
// render IS under test; a live round, whose dots + two-tap scoring ARE under test) and
// out-of-browser via the *Direct helpers where it doesn't (the six record-building rounds —
// finalize/AGS/index math is not a UI behavior; the same precedent as identityRecord.spec.ts).
// Accounts-only (the wall): Uma and Vic are both signed-in accounts, minted + named by the
// harness; Uma runs signed in from her first navigation (course entry and round creation are
// both sign-in-gated), Vic joins the live round as HIMSELF over a direct HTTP self-join.

// A 9-hole card with NO rating/slope — the whole point of the arc. Pars sum to 36 (five par-4s,
// two par-3s, two par-5s); stroke indexes are a permutation of 1..9. This table IS the gate — a
// copy for the human to check against the (imaginary) paper card, never derived from the engine.
const HOLES: readonly { readonly par: number; readonly yardage: number; readonly strokeIndex: number }[] = [
  { par: 4, yardage: 372, strokeIndex: 5 },
  { par: 4, yardage: 401, strokeIndex: 1 },
  { par: 3, yardage: 168, strokeIndex: 9 },
  { par: 5, yardage: 521, strokeIndex: 3 },
  { par: 4, yardage: 388, strokeIndex: 7 },
  { par: 4, yardage: 415, strokeIndex: 2 },
  { par: 3, yardage: 182, strokeIndex: 8 },
  { par: 5, yardage: 540, strokeIndex: 4 },
  { par: 4, yardage: 356, strokeIndex: 6 },
];
const PAR_TOTAL = 36; // = sum of HOLES[*].par — the frozen tee's par, carried on every GolferRoundLine (spec §5)

const DOT = "●"; // ScorecardGrid.tsx's own dot glyph (Cell's aria-hidden "●".repeat(dots) span)

// The live round's singles-match dots (Uma ch 13 vs Vic ch 2). gameStrokeAllocation
// (packages/domain/src/scoring/allocation.ts): singles-match is RELATIVE — the higher-handicap
// player (Uma) gets dotsByHole(diff), the lower (Vic) plays scratch. diff = playingHandicap(
// |13 − 2| = 11, allowance 1.0 = 100%) = 11. allocateStrokes(11, 9 holes): base = floor(11/9) =
// 1, extra = 11 % 9 = 2 → every hole gets 1, and the two hardest holes (stroke index 1 and 2 —
// holes 2 and 6 in this card) get a 2nd. The missing rating changes NONE of this: dots are pure
// stroke-index + course-handicap arithmetic. Cross-checked against dotsByHole(11, tee) directly.
const UMA_CH = 13;
const VIC_CH = 2;
const EXPECTED_UMA_DOTS = [1, 2, 1, 1, 1, 2, 1, 1, 1] as const; // holes 1..9

// The six record-building rounds' hole-by-hole gross scores, oldest-first. Every score is at or
// below bogey (par + 1) and the AGS course handicap (8) puts every net-double-bogey cap (par + 2
// + dots) strictly above it, so NO hole is ever capped and AGS == gross exactly, independent of
// which specific holes take a stroke — the same "keep every score under its cap" trick
// identityRecord.spec.ts uses so the composition arithmetic is hand-verifiable. PAR per hole:
// [4,4,3,5,4,4,3,5,4].
const ROUND_SCORES: readonly (readonly number[])[] = [
  [5, 5, 4, 5, 4, 4, 3, 5, 4], // gross 39 — bogeys on holes 1,2,3
  [5, 5, 4, 6, 5, 4, 3, 5, 4], // gross 41 — bogeys on holes 1,2,3,4,5
  [5, 5, 4, 6, 4, 4, 3, 5, 4], // gross 40 — bogeys on holes 1,2,3,4
  [5, 5, 4, 6, 5, 5, 3, 5, 4], // gross 42 — bogeys on holes 1,2,3,4,5,6
  [5, 5, 3, 5, 4, 4, 3, 5, 4], // gross 38 — bogeys on holes 1,2
  [5, 5, 4, 6, 4, 4, 3, 5, 4], // gross 40 — bogeys on holes 1,2,3,4
];
const AGS_HTTP_CH = 8; // AGS's own course handicap — irrelevant to the totals (no hole is ever capped), pinned so the gate is explicit

// Hand-pinned AGS per round, oldest-first (== each row's gross sum, since nothing caps).
// Verified against adjustedGrossScore(unratedTee, 8, card) round-by-round.
const PINNED_AGS_OLDEST_FIRST = [39, 41, 40, 42, 38, 40] as const;

// THE GATE. The (ags − par) pseudo-differentials, oldest-first: [3, 5, 4, 6, 2, 4]. The 2020
// nine-hole pairing folds them oldest-first — (3,5)→8, (4,6)→10, (2,4)→6 — into the three
// combined pseudo-differentials [8, 10, 6]. computeIndexDetail over three values uses the lowest
// 1 with a −2.0 adjustment (Rule 5.2a small-sample table): 6 − 2.0 = 4.0, differentialsUsed 1.
// Verified against swngIndex(lines) directly. A single 9 (round 1 alone) and five 9s
// (rounds 1–5 → only two combined pairs) both stay BELOW the three-differential bootstrap, so the
// swng index is absent until the sixth round completes the third pair.
const PINNED_SWNG = { value: 4, differentialsUsed: 1 } as const;

// AddCoursePage/HoleGrid own the keyboard-first grid (par default 4; yardage/SI blank). One
// script-driven focus() lands on Hole 1's par, and every field-to-field move from there is a Tab
// riding the native DOM tab order (par, yardage, stroke index per row, top to bottom) — zero
// pointer events on any grid input, the friction-proxy for the product's paper-card bar. Same
// helper shape as courseEntry.spec.ts's own fillHoleGridKeyboardOnly, over this 9-hole table.
const fillNineHoleGridKeyboardOnly = async (page: Page): Promise<void> => {
  await page.getByLabel("Hole 1 par", { exact: true }).focus();
  for (const [index, hole] of HOLES.entries()) {
    const holeNumber = index + 1;
    if (hole.par !== 4) {
      // Replace HoleGrid's default "4" — one Backspace (never a pointer-driven select-all) clears
      // the single default digit before typing the paper card's real par.
      await page.keyboard.press("Backspace");
      await page.keyboard.type(String(hole.par));
    }
    await page.keyboard.press("Tab");
    await page.keyboard.type(String(hole.yardage));
    await page.keyboard.press("Tab");
    await page.keyboard.type(String(hole.strokeIndex));
    if (holeNumber < HOLES.length) await page.keyboard.press("Tab"); // -> next hole's par
  }
};

// One record-building round, played entirely out-of-browser: start as-self (Bearer + the
// account's own golferId, both sourced from the record by startRoundDirect), score nine holes via
// the round's own participant token, finalize. No game is added — a solo card with an AGS is all
// the record needs, and finalize with an empty must-resolve set is exactly identityRecord's own
// idiom.
const playUnratedNine = async (
  httpUrl: string,
  account: AccountGolfer,
  course: Awaited<ReturnType<typeof getCourseDirect>>,
  label: string,
  scores: readonly number[],
): Promise<void> => {
  const started = await startRoundDirect(httpUrl, account, { course, tee: "white", courseHandicap: AGS_HTTP_CH });
  const ops = createScoreOps(`unrated-${label}`);
  for (const [i, strokes] of scores.entries()) {
    await recordScoreDirect(httpUrl, started.roundId, started.token, { golferId: account.golfer.golferId, hole: i + 1, strokes }, ops);
  }
  await finalizeRoundDirect(httpUrl, started.roundId, started.token);
};

test.describe.serial("unrated-course gate — a 9-hole course with no rating plays end to end, against beta", () => {
  let page: Page;
  const courseName = `Sandy Hollow Nine ${Date.now()}`; // per-run unique — a throwaway course on beta
  let course: Awaited<ReturnType<typeof getCourseDirect>>;
  let uma: AccountGolfer;
  let vic: AccountGolfer;

  test.beforeAll(async ({ browser }) => {
    // Uma's tokens are injected before the page's first navigation (AddCoursePage and
    // CreateRoundPage are both sign-in-gated). Vic's account exists only for his own
    // out-of-browser self-join into the live round. Both named via PUT /me (mintAccountGolfer).
    uma = await mintAccountGolfer("unrated-uma", "Uma");
    vic = await mintAccountGolfer("unrated-vic", "Vic");
    const context = await browser.newContext();
    page = await context.newPage();
    await injectAuthTokens(page, uma.tokens);
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test("1: a 9-hole card entered keyboard-only with rating/slope left BLANK lands on a hub whose tee reads 'unrated'", async () => {
    await page.goto("/courses/new");

    // enteredBy derives from the signed-in account server-side (the wall) — there is no name field.
    await expect(page.getByLabel("Your name", { exact: true })).toHaveCount(0);

    await page.getByLabel("Course name", { exact: true }).fill(courseName);
    await page.getByLabel("Tee name", { exact: true }).fill("white");
    // Rating + slope left untouched (blank) — the whole point of the unrated path. AddCoursePage
    // omits a blank pair from the wire entirely, so the tee submits as a bare unrated `{name, holes}`.

    // Switch the hole-count toggle to 9 (default is 18) and confirm the grid actually re-rendered
    // to nine rows before filling it — a 10th row surviving would silently corrupt the tab walk.
    await page.getByRole("radio", { name: "9", exact: true }).check();
    await expect(page.getByLabel("Hole 9 par", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Hole 10 par", { exact: true })).toHaveCount(0);

    await fillNineHoleGridKeyboardOnly(page);

    // A few representative cells (an untouched par-4 default, two touched non-4 pars, a stroke
    // index, the last hole's yardage) — a tab-order regression the fill loop wouldn't itself surface.
    await expect(page.getByLabel("Hole 1 par", { exact: true })).toHaveValue("4"); // untouched default
    await expect(page.getByLabel("Hole 3 par", { exact: true })).toHaveValue("3"); // touched (par !== 4)
    await expect(page.getByLabel("Hole 4 par", { exact: true })).toHaveValue("5"); // touched
    await expect(page.getByLabel("Hole 2 stroke index", { exact: true })).toHaveValue("1");
    await expect(page.getByLabel("Hole 9 yardage", { exact: true })).toHaveValue("356");
    await expect(page.getByText("SI remaining: none")).toBeVisible(); // all 9 indexes placed, a real permutation

    await page.getByRole("button", { name: "Add course", exact: true }).click();

    // Success lands on the course's own hub. The (?!new$) lookahead is load-bearing: the pre-click
    // URL is /courses/new, which a bare /courses/[^/]+$ already matches, so without it this wait
    // resolves immediately and the id captures as the literal "new".
    await expect(page).toHaveURL(/\/courses\/(?!new$)[^/]+$/);
    const courseIdParam = new URL(page.url()).pathname.split("/").pop() ?? "";
    expect(courseIdParam).not.toBe("");

    await expect(page.getByRole("heading", { name: courseName, exact: true })).toBeVisible();

    // The tee reads "unrated", not a half-blank "rating , slope " — teeNumbers.ts renders the
    // whole summary as the single word "unrated" when rating/slope are absent. CoursePage's tee
    // <select> option is "white — unrated"; assert the robust substrings (dodging em-dash fragility).
    const teeSelect = page.getByRole("combobox", { name: "Tee", exact: true });
    await expect(teeSelect).toContainText("white");
    await expect(teeSelect).toContainText("unrated");

    // The cardId for the record-building rounds' reference commands (StartRound is a reference,
    // and the browser never surfaces the cardId) — read once out-of-browser off the public course API.
    const { httpUrl } = loadWebEnv();
    course = await getCourseDirect(httpUrl, courseIdParam);
  });

  test("2: a live round on the unrated tee — its singles-match dots come straight from stroke index + course handicap, and two-tap scoring nets against them", async () => {
    // "Start a round here" preselects the course; Uma creates on the unrated white tee (ch 13).
    await page.getByRole("link", { name: "Start a round here", exact: true }).click();
    await expect(page).toHaveURL(/\/create/);
    await expect(page.getByText(courseName, { exact: true })).toBeVisible();
    await expect(page.getByText("Playing as", { exact: true })).toBeVisible(); // no name field — the account's own record
    await page.getByLabel("Strokes you get here", { exact: true }).fill(String(UMA_CH));
    await page.getByRole("button", { name: "Create round", exact: true }).click();

    await expect(page).toHaveURL(/\/round\//);
    const joinCode = await readJoinCode(page);

    // Vic joins as HIMSELF over a direct HTTP self-join (score-for-anyone makes his own browser
    // unnecessary — the same precedent as courseEntry.spec.ts's Quinn), on the same unrated tee (ch 2).
    const { httpUrl } = loadWebEnv();
    await joinRoundDirect(httpUrl, vic, { code: joinCode, tee: "white", courseHandicap: VIC_CH });
    await waitForParticipant(page, "Vic");

    // Add the singles match (Uma vs Vic) via SetupPanel — default 100% allowance, exactly the
    // pinned allocation above.
    await gameKindSelect(page).selectOption({ value: "singles-match" });
    await page.getByRole("combobox", { name: "Player A", exact: true }).selectOption({ label: "Uma" });
    await page.getByRole("combobox", { name: "Player B", exact: true }).selectOption({ label: "Vic" });
    await page.getByRole("button", { name: "Add game", exact: true }).click();
    await expect(chip(page, "Singles match")).toBeVisible();

    // Dots hole-by-hole against the hand-verified relative allocation — the CORE assertion: an
    // unrated tee allocates dots identically to a rated one (stroke index + course handicap only).
    // If the grid ever disagrees with EXPECTED_UMA_DOTS, that's the BLOCKED condition, not a
    // pin this test may quietly re-derive.
    const dotsOn = async (golfer: string, hole: number): Promise<number> => {
      const cell = page.getByRole("button", { name: `${golfer} hole ${hole}`, exact: true });
      const text = await cell.innerText();
      return (text.match(new RegExp(DOT, "g")) ?? []).length;
    };
    for (let hole = 1; hole <= 9; hole += 1) {
      expect(await dotsOn("Uma", hole), `Uma hole ${hole}`).toBe(EXPECTED_UMA_DOTS[hole - 1]);
      expect(await dotsOn("Vic", hole), `Vic hole ${hole}`).toBe(0); // the lower handicap plays scratch
    }

    // Two-tap scoring renders net = gross − dots, exactly as on a rated course. Hole 1 (1 dot):
    // gross 5 → net 4 → "●54". Hole 6 (2 dots): gross 6 → net 4 → "●●64". enterScore itself pins
    // the two-tap contract (two clicks, pad closes on the second); the explicit cell text pins the
    // net arithmetic.
    await enterScore(page, "Uma", 1, 5);
    await expect(page.getByRole("button", { name: "Uma hole 1", exact: true })).toHaveText(`${DOT}54`);
    await enterScore(page, "Uma", 6, 6);
    await expect(page.getByRole("button", { name: "Uma hole 6", exact: true })).toHaveText(`${DOT}${DOT}64`);
    // This live round is deliberately left unfinalized — it proves the live experience, and its
    // partial card would settle "incomplete" (no AGS), contributing nothing to Uma's record below.
  });

  test("3: one finalized unrated 9 posts an AGS but NO differential — and a lone 9 yields no swng index yet", async () => {
    test.setTimeout(90_000);
    const { httpUrl } = loadWebEnv();

    await playUnratedNine(httpUrl, uma, course, "r1", ROUND_SCORES[0]!);

    // The projector is async relative to finalize's HTTP response — poll the same GET /me/record
    // finalize's own contract treats as authoritative, not a fixed sleep. Only round 1 is
    // finalized (test 2's live round is unfinalized → no line), so history is exactly [round 1].
    const record = await pollUntil(
      () => getMyRecordDirect(httpUrl, uma.tokens.idToken),
      (r) => r.history.length >= 1,
      60_000,
      "record-after-r1",
    );
    expect(record.history).toHaveLength(1);

    const line = record.history[0]!;
    expect(line.holes).toBe(9);
    expect(line.par).toBe(PAR_TOTAL);
    expect(line.ags).toBe(PINNED_AGS_OLDEST_FIRST[0]); // 39 — an AGS is posted
    expect(line.differential).toBeUndefined(); // …but never a differential: unrated, not postable

    // An unrated round cannot move the WHS index — it carries no differential, so it never reaches
    // Rule 5.2a. A fresh account with only this round has no WHS index at all.
    expect(record.metrics.whsIndex).toBeUndefined();
    // A single 9 has no partner: combineNineHoleDifferentials leaves it pending → no combined
    // pseudo-differential → below the three-differential bootstrap → no swng index yet.
    expect(record.metrics.swngIndex).toBeUndefined();
  });

  test("4: six finalized 9s pair oldest-first into the swng index; the WHS index stays untouched", async () => {
    test.setTimeout(240_000); // five more sequential API rounds + the projector catch-up poll
    const { httpUrl } = loadWebEnv();

    // Strictly in order (each finalized before the next starts) — the oldest-first pairing below
    // depends on exactly this finalize sequence, the same discipline identityRecord.spec.ts relies on.
    for (let i = 1; i < ROUND_SCORES.length; i += 1) {
      await playUnratedNine(httpUrl, uma, course, `r${i + 1}`, ROUND_SCORES[i]!);
    }

    const record = await pollUntil(
      () => getMyRecordDirect(httpUrl, uma.tokens.idToken),
      (r) => r.history.length >= 6,
      90_000,
      "record-after-6",
    );
    expect(record.history).toHaveLength(6);

    // Every unrated line: an AGS, never a differential — on a 9-hole card of par 36.
    for (const [i, line] of record.history.entries()) {
      expect(line.holes, `history[${i}].holes`).toBe(9);
      expect(line.par, `history[${i}].par`).toBe(PAR_TOTAL);
      expect(line.ags, `history[${i}].ags`).toBeDefined();
      expect(line.differential, `history[${i}].differential`).toBeUndefined();
    }

    // history is newest-first (getMyRecord's sortLines + reverse) and finalize ran r1..r6, so the
    // AGS column newest-first is the pinned oldest-first list reversed: [40, 38, 42, 40, 41, 39].
    const expectedAgsNewestFirst = [...PINNED_AGS_OLDEST_FIRST].reverse();
    for (const [i, line] of record.history.entries()) {
      expect(line.ags, `history[${i}].ags`).toBe(expectedAgsNewestFirst[i]);
    }

    // A wholly-unrated season still cannot produce a WHS index — no differentials exist to average.
    expect(record.metrics.whsIndex).toBeUndefined();

    // THE GATE: the six (ags − par) pseudo-differentials [3,5,4,6,2,4] pair oldest-first into
    // [8,10,6], and computeIndexDetail takes the lowest 1 of three with a −2.0 adjustment →
    // 6 − 2.0 = 4.0, differentialsUsed 1. The swng index now reflects the unrated play.
    expect(record.metrics.swngIndex).toEqual(PINNED_SWNG);
  });
});
