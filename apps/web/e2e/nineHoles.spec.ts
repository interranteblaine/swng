import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { dotsByHole, fixtureLinks18, intendedHoles } from "@swng/domain";
import {
  addSkinsGame,
  chip,
  enterScore,
  ensureCourse,
  getMyRecordDirect,
  injectAuthTokens,
  joinRoundDirect,
  loadWebEnv,
  mintAccountGolfer,
  pollUntil,
  readJoinCode,
  setStrokesInBrowser,
  waitForParticipant,
} from "./support.js";
import type { AccountGolfer } from "./support.js";

// The field gate for "round plays a nine" (spec 2026-08-02): a round can now declare it set out
// to play the front nine, the back nine, or the whole card (HoleSelection). The defect this arc
// exists to fix is stroke allocation: a player's strokes must spread over the NINE HOLES ACTUALLY
// PLAYED, ranked by their OWN relative difficulty among themselves — not the raw, whole-card
// stroke index, which would strand most of a played nine's dots on the unplayed half of the card
// (packages/domain/src/scoring/strokes.ts's allocateStrokes: "a nine drawn out of an eighteen
// carries stroke indexes 2, 4 … 18, so reading strokeIndex raw would hand out a fraction of the
// typed strokes").
//
// fixtureLinks18 (the SAME 18-hole fixture fieldTest.spec.ts/courseEntry.spec.ts already
// idempotently seed — ensureCourse below is a no-op if a prior run already created it) is the
// right course for this: its back nine (holes 10-18) carries a genuinely SCRAMBLED stroke index
// (packages/domain/src/scoring/golden/fixtureCourse.ts's fixtureWhite18 — 2, 16, 8, 4, 12, 10, 18,
// 6, 14), so a regression that allocated off the raw 18-hole index rather than this nine's own
// relative ranking would visibly strand dots on the wrong holes of this exact list. Which holes
// actually get a dot is DERIVED below from the seeded course's own stroke indexes via the SAME
// domain function the card renders through (dotsByHole) — never hard-coded.
//
// One browser page, one host (Nia) who drives it, one out-of-browser companion (Robin) who joins
// as herself via joinRoundDirect — score-for-anyone (product.md §9) means Nia's own page can enter
// both players' scores, the same one-page structure strokesCorrection.spec.ts already uses.
test.describe.serial("a round declares Back 9 — strokes allocate onto the nine actually played, the game resolves on its own, and the record counts a nine", () => {
  let page: Page;
  let httpUrl: string;
  let nia: AccountGolfer;
  let robin: AccountGolfer;
  let roundId: string;

  const NIA_STROKES = 5;
  // Both players score par on every hole of the nine — the "gross" this test cares about (36, the
  // back nine's own par sum) never depends on Nia's dots, which only ever affect NET figures (the
  // net skins pot below). Simple, deterministic, and irrelevant to whether the skins game itself
  // resolves — allPlayersComplete only checks that every intended hole carries a cell.
  const HOLE_SCORE = 4;

  test.beforeAll(async ({ browser }) => {
    nia = await mintAccountGolfer("nine-nia", "Nia");
    robin = await mintAccountGolfer("nine-robin", "Robin");
    ({ httpUrl } = loadWebEnv());
    await ensureCourse(fixtureLinks18.courseName, fixtureLinks18, nia);

    const context = await browser.newContext();
    page = await context.newPage();
    await injectAuthTokens(page, nia.tokens);
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test("1: Nia creates a round on fixtureLinks18, choosing Back 9; Robin joins herself; the card renders nine rows (10-18) and one TOT row, no OUT/IN", async () => {
    await page.goto("/create");
    await page.getByLabel("Course", { exact: true }).fill(fixtureLinks18.courseName);
    // CourseSearch.tsx's own "name · N holes" accessible name — the precedent every other spec
    // searching this exact fixture already uses (fieldTest.spec.ts, courseEntry.spec.ts).
    const result = page.getByRole("button", { name: `${fixtureLinks18.courseName} · ${fixtureLinks18.teeSets[0]!.holes.length} holes`, exact: true }).first();
    await expect(result).toBeVisible();
    await result.click();
    await expect(page.getByText("Playing as", { exact: true })).toBeVisible();

    // The three-way choice (CreateRoundPage.tsx, spec 2026-08-02 §3) is offered only because this
    // card has 18 holes; the label text is domain presentation truth (holeSelectionLabel("back")
    // === "Back 9", pinned by packages/domain/src/scoring/present.test.ts).
    await page.getByRole("radio", { name: "Back 9", exact: true }).check();
    await page.getByRole("button", { name: "Create round" }).click();

    await expect(page).toHaveURL(/\/round\//);
    roundId = new URL(page.url()).pathname.replace("/round/", "");

    const joinCode = await readJoinCode(page);
    await joinRoundDirect(httpUrl, robin, { code: joinCode, tee: fixtureLinks18.teeSets[0]!.name });
    await waitForParticipant(page, "Robin");

    // The round's own held selection, on screen (SetupPanel.tsx's "Holes" region — a bare
    // <section aria-label="Holes"> exposes ARIA role "region" once it has an accessible name; the
    // SAME idiom SetupPanel.test.tsx already asserts through) — the choice stuck past creation,
    // not just the create-time radio.
    await expect(page.getByRole("region", { name: "Holes" })).toContainText("Back 9");

    // The card itself (ScorecardGrid.tsx): nine rows numbered 10-18 (never renumbered 1-9), and a
    // single TOT row with no OUT/IN split — the split is by COUNT of holes played, not by hole
    // number, so a round that set out to play ONE nine gets exactly the row shape a genuine 9-hole
    // card already gets. Pinned at the unit level for this SAME fixture+selection by
    // ScorecardGrid.test.tsx's own "ScorecardGrid — the round's own hole selection" describe block.
    await expect(page.locator("tbody tr")).toHaveCount(9);
    await expect(page.getByRole("row", { name: "Hole 10", exact: true })).toBeVisible();
    await expect(page.getByRole("row", { name: "Hole 18", exact: true })).toBeVisible();
    await expect(page.getByRole("row", { name: "Hole 1", exact: true })).toHaveCount(0);
    await expect(page.getByRole("row", { name: "Hole 9", exact: true })).toHaveCount(0);
    await expect(page.getByRole("row", { name: "OUT", exact: true })).toHaveCount(0);
    await expect(page.getByRole("row", { name: "IN", exact: true })).toHaveCount(0);
    await expect(page.getByRole("row", { name: "TOT", exact: true })).toBeVisible();
  });

  test("2: Nia's 5 strokes allocate onto the nine actually played, ranked by ITS OWN difficulty — derived from the seeded card's real stroke indexes, not hard-coded", async () => {
    await setStrokesInBrowser(page, "Nia", NIA_STROKES);
    await expect(page.getByRole("list", { name: "Roster" }).locator("li").filter({ hasText: "Nia" })).toContainText(`white · ${NIA_STROKES} strokes`);

    // The oracle: the SAME domain function the card itself renders through
    // (roundStrokeAllocation -> dotsByHole, packages/domain/src/scoring/allocation.ts), fed the
    // real back-nine holes off the real seeded card (intendedHoles(teeSet, "back")) — never a
    // hand-typed hole list. This is exactly the defect this arc fixes: a regression that allocated
    // off the raw 18-hole stroke index (holes 1-18) rather than ranking these nine holes among
    // THEMSELVES would strand dots on a different subset of this same back nine.
    const backNine = intendedHoles(fixtureLinks18.teeSets[0]!, "back");
    const dots = dotsByHole(NIA_STROKES, backNine);
    const dotHoles = backNine.filter((h) => (dots.get(h.number) ?? 0) > 0).map((h) => h.number);
    const noDotHoles = backNine.filter((h) => (dots.get(h.number) ?? 0) === 0).map((h) => h.number);

    // 5 strokes over 9 holes (base 0, extra 5): exactly five holes get exactly one dot each — a
    // derived fact about this course's own numbers, not an assumption baked into this test.
    expect(dotHoles).toHaveLength(5);
    expect(noDotHoles).toHaveLength(4);

    for (const holeNumber of dotHoles) {
      await expect(page.getByRole("button", { name: `Nia hole ${holeNumber}`, exact: true })).toContainText("●");
    }
    for (const holeNumber of noDotHoles) {
      await expect(page.getByRole("button", { name: `Nia hole ${holeNumber}`, exact: true })).not.toContainText("●");
    }
  });

  test("3: a net skins game, scored for both players over the nine, resolves on its own — finalize never needs 'End unfinished games'", async () => {
    test.setTimeout(150_000); // 18 real score posts to beta plus a finalize round-trip — courseEntry.spec.ts's played-date gate gives itself the same headroom for a lighter version of this exact story

    await addSkinsGame(page, ["Nia", "Robin"]);
    await expect(chip(page, "Skins (net)")).toBeVisible();

    const backNine = intendedHoles(fixtureLinks18.teeSets[0]!, "back");
    for (const hole of backNine) {
      await enterScore(page, "Nia", hole.number, HOLE_SCORE);
      await enterScore(page, "Robin", hole.number, HOLE_SCORE);
    }

    // allPlayersComplete (packages/domain/src/scoring/players.ts) is now true for both players
    // over every hole THIS ROUND set out to play — the skins game resolves without either player
    // touching a hole outside the nine they were actually dealt.
    await page.getByRole("button", { name: "Finalize round" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm finalize" });
    // The game resolved on its own: the dialog takes the "nothing unresolved" branch, and the
    // affordance this arc must NOT need — "End unfinished games & finalize" — is absent entirely,
    // not merely unused.
    await expect(dialog).toContainText("This locks in every score");
    await expect(dialog.getByRole("button", { name: /^end unfinished games & finalize$/i })).toHaveCount(0);
    await dialog.getByRole("button", { name: /^finalize$/i }).click();

    // Real headroom for the drain-then-finalize round trip against beta — the same 60s
    // courseEntry.spec.ts's own played-date gate gives an equivalent (much lighter) finalize.
    await expect(page.getByRole("heading", { name: "Final results" })).toBeVisible({ timeout: 60_000 });
  });

  test("4: the golfer's record counts a nine — the history row reads nine holes with its gross, and Best 9 names this round", async () => {
    const record = await pollUntil(
      () => getMyRecordDirect(httpUrl, nia.tokens.idToken),
      (r) => r.history.some((line) => line.roundId === roundId),
      60_000,
      "GET /me/record settling the new nine-hole round",
    );
    const line = record.history.find((entry) => entry.roundId === roundId);
    expect(line?.holes).toBe(9);
    expect(line?.score).toBe(HOLE_SCORE * 9); // every hole scored HOLE_SCORE, gross is the raw sum — never net
    expect(record.metrics.bests.best9?.roundId).toBe(roundId);

    await page.goto("/profile");

    // "History" h3's own following <ul> — the same structural lookup identityRecord.spec.ts's own
    // ProfilePage beat already uses (neither element carries an aria-label/testid of its own).
    const historyList = page.locator("xpath=//h3[normalize-space(text())='History']/following-sibling::ul[1]");
    await expect(historyList.getByRole("listitem")).toHaveCount(1); // a fresh throwaway account: this is Nia's only round
    const historyRow = historyList.getByRole("listitem").first();
    await expect(historyRow).toContainText(fixtureLinks18.courseName);
    await expect(historyRow).toContainText("9 holes");
    await expect(historyRow).toContainText(String(line?.score));

    // "Best rounds" — Best 9 names THIS round (RecordSections.tsx's bestLine: a plain-text score
    // segment plus a Link to /rounds/{roundId} reading the course's own name).
    const bestList = page.locator("xpath=//h3[normalize-space(text())='Best rounds']/following-sibling::ul[1]");
    const best9Row = bestList.getByRole("listitem").filter({ hasText: "Best 9" });
    await expect(best9Row).toBeVisible();
    await expect(best9Row.getByRole("link", { name: fixtureLinks18.courseName, exact: true })).toHaveAttribute("href", `/rounds/${roundId}`);
  });

  // Teardown: the round is finalized (nothing to scrap); Nia/Robin's throwaway Cognito users were
  // tracked at mint time (mintAccountGolfer -> support.ts's trackMintedUser) and are deleted by
  // the standard ndjson-driven globalTeardown, same as every other spec in this suite.
});
