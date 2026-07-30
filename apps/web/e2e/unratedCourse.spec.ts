import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  addSinglesGame,
  chip,
  createScoreOps,
  enterScore,
  finalizeRoundDirect,
  getCourseDirect,
  getMyRecordDirect,
  injectAuthTokens,
  joinRoundDirect,
  loadWebEnv,
  mintAccountGolfer,
  normallyShootsField,
  openGamePanel,
  pollUntil,
  readJoinCode,
  recordScoreDirect,
  startRoundDirect,
  waitForParticipant,
} from "./support.js";
import type { AccountGolfer } from "./support.js";

// The unrated-courses arc gate (docs/superpowers/specs/2026-07-14/15 unrated-courses; Task 6),
// RE-AIMED by spec 2026-07-29: a REAL 9-hole course with NO course rating enters, plays and
// finalizes end-to-end, and its rounds land on the golfer's record like any other.
//
// **The premise this file was built on is gone, and that is the point.** Rating and slope are
// still recorded on the card (they are printed on the real scorecard) and read by NOTHING (spec
// §7): the adjusted gross score, the score differential, the Rule 5.2a small-sample table, the
// published 2020 nine-hole differential pairing, and both indexes are deleted whole. So "unrated"
// is no longer a distinct code path to gate — there is nothing left for a missing rating to
// disable. What survives is the honest half of the original gate: a blank-rating card must not be
// REJECTED anywhere, and its rounds must feed the average exactly like a rated card's do. The old
// PAIRING TRAP paragraph — six rounds needed before an index materialized — is deleted with the
// machinery it described; ONE scored round is already an average.
//
// Every expected number below (the pars/SIs, the singles-match dots, the gross per round, and the
// average/spread) is hand-pinned and derived BEFORE any live call, and asserted verbatim: a live
// disagreement is a BLOCKED finding to escalate, never a pin quietly adjusted to match observed
// output (the run's-the-oracle inversion).
//
// Everything is browser-driven where the story needs a browser (course entry, whose "unrated"
// render IS under test; a live round, whose dots + two-tap scoring ARE under test) and
// out-of-browser via the *Direct helpers where it doesn't (the six record-building rounds —
// finalize and the average fold are not UI behavior; the same precedent as identityRecord.spec.ts).
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

const UMA_CH = 13;
const VIC_CH = 2;

// The STANDARD CARD's dots (spec 2026-07-19 §2a: the card never changes) — ScorecardGrid always
// renders roundStrokeAllocation (packages/domain/src/scoring/allocation.ts), EACH PLAYER'S
// OWN round strokes allocated by stroke index, no game. allocateStrokes(13, 9
// holes): base = floor(13/9) = 1, extra = 13 % 9 = 4 → every hole gets 1, and the four hardest
// holes (stroke index 1-4 — holes 2, 6, 4, 8 in this card) get a 2nd. allocateStrokes(2, 9
// holes): base = 0, extra = 2 → only stroke index 1 and 2 (holes 2 and 6) get a single dot,
// everywhere else 0. The missing rating changes NONE of this: dots are pure stroke-index + strokes
// arithmetic. Cross-checked against roundStrokeAllocation(participants, card) directly.
const EXPECTED_UMA_DOTS = [1, 2, 1, 2, 1, 2, 1, 2, 1] as const; // holes 1..9
const EXPECTED_VIC_DOTS = [0, 1, 0, 0, 0, 1, 0, 0, 0] as const; // holes 1..9

// The Match play PANEL'S own strokes line (relative, not each player's own CH) — moved here from
// the grid, which now renders the standard card's dots above instead. gameStrokeAllocation:
// singles-match is RELATIVE — only the higher-handicap player (Uma) receives any, the lower
// (Vic) is the field's anchor and receives nothing. Under the ONE stroke rule (spec §2b) the
// difference is |13 − 2| = 11 — exactly what strokesSummary (apps/web/src/round/dots.ts) states in
// the panel; Vic is omitted from that line because his allocation is 0.
const EXPECTED_MATCH_STROKES_LINE = "Uma 11 dots";

// The six record-building rounds' hole-by-hole gross scores, oldest-first. Every hole carries a
// stroke count (no pickup anywhere), which is what makes each card a SCORED card that feeds the
// average (spec §2d). No cap applies to any of them — the net-double-bogey cap now touches only a
// picked-up hole — so each round's `score` is simply its own sum. PAR per hole:
// [4,4,3,5,4,4,3,5,4].
const ROUND_SCORES: readonly (readonly number[])[] = [
  [5, 5, 4, 5, 4, 4, 3, 5, 4], // gross 39 — bogeys on holes 1,2,3
  [5, 5, 4, 6, 5, 4, 3, 5, 4], // gross 41 — bogeys on holes 1,2,3,4,5
  [5, 5, 4, 6, 4, 4, 3, 5, 4], // gross 40 — bogeys on holes 1,2,3,4
  [5, 5, 4, 6, 5, 5, 3, 5, 4], // gross 42 — bogeys on holes 1,2,3,4,5,6
  [5, 5, 3, 5, 4, 4, 3, 5, 4], // gross 38 — bogeys on holes 1,2
  [5, 5, 4, 6, 4, 4, 3, 5, 4], // gross 40 — bogeys on holes 1,2,3,4
];
// What Uma states at the tee (spec §2a's first constructor). She plays every round alone, so she is
// her own anchor and it derives ZERO strokes — the grosses below are untouched by it. Pinned as a
// non-zero value on purpose: it rides onto every line as `normallyShoots`, so a fold that confused
// the ASSERTION with the DERIVED strokes would show up.
const STATED_OVER_PAR = 8;

// Hand-pinned gross per round, oldest-first (== each row's own sum). Every hole carries a stroke
// count, so `hasCompleteScore` holds and each line's wire `score` IS this number (spec §2d/§8).
const PINNED_SCORES_OLDEST_FIRST = [39, 41, 40, 42, 38, 40] as const;

// THE GATE, re-derived for the average (spec 2026-07-29 §5/§7 — the adjusted gross score, the
// differentials, the 9-hole pairing and both indexes are deleted whole; nothing computes from
// rating or slope, so a blank-rating card is no longer a distinct code path at all). A NINE
// contributes its vs-par figure DOUBLED (spec §2d), so on this par-36 card:
//
//   gross     39   41   40   42   38   40
//   vs par    +3   +5   +4   +6   +2   +4
//   doubled   +6  +10   +8  +12   +4   +8
//
// after round 1: mean(6) = 6                      -> average 6; spread ABSENT (1 < 5 rounds)
// after round 6: sum 48, mean 48/6 = 8            -> average 8
//                population sd = sqrt(40/6) = 2.581989  -> spread 2.6
//   (deviations from 8: -2, +2, 0, +4, -4, 0; squares 4+4+0+16+16+0 = 40)
const PINNED_AVERAGE_AFTER_ONE = 6;
const PINNED_AVERAGE_AFTER_SIX = 8;
const PINNED_SPREAD_AFTER_SIX = 2.6;

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
// the round's own participant token, finalize. No game is added — a solo scored card is all the
// record needs, and finalize with an empty must-resolve set is exactly identityRecord's own idiom.
const playUnratedNine = async (
  httpUrl: string,
  account: AccountGolfer,
  course: Awaited<ReturnType<typeof getCourseDirect>>,
  label: string,
  scores: readonly number[],
): Promise<void> => {
  const started = await startRoundDirect(httpUrl, account, { course, tee: "white", basis: { kind: "normally-shoots", overPar: STATED_OVER_PAR } });
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

    await page.getByRole("button", { name: /^add course$/i }).click();

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

  test("2: a live round on the unrated tee — the standard card's dots come straight from stroke index + course handicap, the Match play panel states the relative strokes, and two-tap scoring nets against the card", async () => {
    // "Start a round here" preselects the course; Uma creates on the unrated white tee (ch 13).
    await page.getByRole("link", { name: /^start a round here$/i }).click();
    await expect(page).toHaveURL(/\/create/);
    await expect(page.getByText(courseName, { exact: true })).toBeVisible();
    await expect(page.getByText("Playing as", { exact: true })).toBeVisible(); // no name field — the account's own record
    await normallyShootsField(page).fill(String(UMA_CH));
    await page.getByRole("button", { name: /^create round$/i }).click();

    await expect(page).toHaveURL(/\/round\//);
    const joinCode = await readJoinCode(page);

    // Vic joins as HIMSELF over a direct HTTP self-join (score-for-anyone makes his own browser
    // unnecessary — the same precedent as courseEntry.spec.ts's Quinn), on the same unrated tee (ch 2).
    const { httpUrl } = loadWebEnv();
    await joinRoundDirect(httpUrl, vic, { code: joinCode, tee: "white", basis: { kind: "normally-shoots", overPar: VIC_CH } });
    await waitForParticipant(page, "Vic");

    // Add the singles match (Uma vs Vic) via SetupPanel — one stroke rule, the difference between
    // the two, exactly the pinned allocation above.
    await addSinglesGame(page, "Uma", "Vic");
    await expect(chip(page, "Match play")).toBeVisible();

    // The STANDARD CARD's dots, hole-by-hole against the hand-verified CH allocation — the CORE
    // assertion: an unrated tee allocates dots identically to a rated one (stroke index + course
    // handicap only), and the grid renders each player's OWN course handicap now, never the
    // game's relative one (spec 2026-07-19 §2a — chip taps don't touch the grid). If this ever
    // disagrees with EXPECTED_UMA_DOTS/EXPECTED_VIC_DOTS, that's the BLOCKED condition, not a
    // pin this test may quietly re-derive.
    const dotsOn = async (golfer: string, hole: number): Promise<number> => {
      const cell = page.getByRole("button", { name: `${golfer} hole ${hole}`, exact: true });
      const text = await cell.innerText();
      return (text.match(new RegExp(DOT, "g")) ?? []).length;
    };
    for (let hole = 1; hole <= 9; hole += 1) {
      expect(await dotsOn("Uma", hole), `Uma hole ${hole}`).toBe(EXPECTED_UMA_DOTS[hole - 1]);
      expect(await dotsOn("Vic", hole), `Vic hole ${hole}`).toBe(EXPECTED_VIC_DOTS[hole - 1]);
    }

    // The "singles-match dots" claim, re-anchored: the RELATIVE allocation (the arithmetic the
    // grid used to carry) now lives in the Match play panel's own strokes line, opened with ONE
    // chip tap — not the grid, which just proved it renders the standard card's dots above.
    const panel = await openGamePanel(page, "Match play");
    await expect(panel).toContainText(EXPECTED_MATCH_STROKES_LINE);

    // Two-tap scoring renders net = gross − dots, exactly as on a rated course. Hole 1 (1 dot):
    // gross 5 → net 4 → "●54". Hole 6 (2 dots): gross 6 → net 4 → "●●64". enterScore itself pins
    // the two-tap contract (two clicks, pad closes on the second); the explicit cell text pins the
    // net arithmetic.
    await enterScore(page, "Uma", 1, 5);
    await expect(page.getByRole("button", { name: "Uma hole 1", exact: true })).toHaveText(`${DOT}54`);
    await enterScore(page, "Uma", 6, 6);
    await expect(page.getByRole("button", { name: "Uma hole 6", exact: true })).toHaveText(`${DOT}${DOT}64`);
    // This live round is deliberately left unfinalized — it proves the live experience, and its
    // partial card carries no score at all, contributing nothing to Uma's record below.
  });

  test("3: one finalized unrated 9 posts its score and an average — nothing needs a rating", async () => {
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
    expect(line.score).toBe(PINNED_SCORES_OLDEST_FIRST[0]); // 39 — the round's own gross
    // The assertion beside its consequence (spec §2a/§2b): she stated +8, and playing alone she is
    // her own anchor, so the fold derived 0 strokes.
    expect(line.normallyShoots).toBe(STATED_OVER_PAR);
    expect(line.strokes).toBe(0);
    // Rating and slope are recorded on the card and read by NOTHING (spec §7): an unrated round is
    // an ordinary round, so ONE of them already produces an average — 39 on par 36 is +3, doubled
    // to +6 for the nine.
    expect(record.metrics.average).toBe(PINNED_AVERAGE_AFTER_ONE);
    expect(record.metrics.spread).toBeUndefined(); // one round is below the 5-round floor
    // The retired WHS/index members can never come back onto this wire.
    for (const retired of ["ags", "differential"]) expect(line).not.toHaveProperty(retired);
    for (const retired of ["whsIndex", "swngIndex", "indexHistory"]) expect(record.metrics).not.toHaveProperty(retired);
  });

  test("4: six finalized unrated 9s average to +8 with a real spread — every nine counted double", async () => {
    test.setTimeout(240_000); // five more sequential API rounds + the projector catch-up poll
    const { httpUrl } = loadWebEnv();

    // Strictly in order (each finalized before the next starts) — the averageHistory assertion below
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

    // Every unrated line: a real score on a 9-hole card of par 36, and nothing rating-derived.
    for (const [i, line] of record.history.entries()) {
      expect(line.holes, `history[${i}].holes`).toBe(9);
      expect(line.par, `history[${i}].par`).toBe(PAR_TOTAL);
      expect(line.score, `history[${i}].score`).toBeDefined();
    }

    // history is newest-first (getMyRecord's sortLines + reverse) and finalize ran r1..r6, so the
    // score column newest-first is the pinned oldest-first list reversed: [40, 38, 42, 40, 41, 39].
    expect(record.history.map((line) => line.score)).toEqual([...PINNED_SCORES_OLDEST_FIRST].reverse());

    // THE GATE: six unrated nines, each contributing its vs-par figure DOUBLED — [6,10,8,12,4,8] —
    // average to exactly +8, with a population spread of 2.6. Unrated play feeds the average like
    // any other round; there is no second number and no bootstrap to cross.
    expect(record.metrics.average).toBe(PINNED_AVERAGE_AFTER_SIX);
    expect(record.metrics.spread).toBe(PINNED_SPREAD_AFTER_SIX);
    // averageHistory is oldest -> newest, one point per round, and its last point IS the headline.
    expect(record.metrics.averageHistory).toHaveLength(6);
    expect(record.metrics.averageHistory.at(-1)?.average).toBe(PINNED_AVERAGE_AFTER_SIX);
  });
});
