import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { fixtureLinks18 } from "@swng/domain";
import {
  addFourballGame,
  addSkinsGame,
  chip,
  correctedScore,
  describeFourballAt,
  describeSkinsAt,
  ensureCourse,
  enterScore,
  expectOrRecover,
  installWsProxy,
  joinRoundDirect,
  loadWebEnv,
  PLAYER_NAMES,
  scoreFor,
  waitForDigestOrRecover,
  waitForFinalOrRecover,
  waitForParticipant,
} from "./support.js";
import type { WsRouteHandle } from "./support.js";

// The M5 gate (docs/implementation-plan.md M5 Task 7): a full 18-hole round of fourball match
// + skins, played through the REAL UI in two Chromium contexts against the deployed swng-beta
// stack, with a dark stretch for context B mid-round. `@swng/domain`'s fieldDeck18 is the
// oracle for every score entered AND every expected UI string (via describeFourballAt/
// describeSkinsAt in ./support.ts, which run the deck through the app's own describeGame) —
// nothing here is a hand-copied number. One spec, two contexts, ten numbered steps mirroring
// the brief's own scenario. Kept out of `pnpm validate`/`pnpm -r test` entirely: it has its
// own script (`pnpm e2e:field`, playwright.config.ts) and vitest.config.ts's own "e2e/**"
// exclude means the default `vitest run` never even sees this file.
test.describe.serial("M5 field test — two browsers, offline mid-round, the full 18 of fourball + skins", () => {
  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let joinCode = "";
  // Both contexts' WebSocket traffic is routed through support.ts's installWsProxy (see its own
  // doc comment for the full mechanism: CDP's offline emulation doesn't tear down an already-open
  // socket, so routeWebSocket + a force-close is what makes context.setOffline produce the
  // client-visible "disconnected" state a real network loss would). Each handle's `.current`
  // always points at that context's LATEST connection (mind reconnects) — step 5 uses `bRoute` to
  // force B's socket closed on demand to simulate a dropped connection; `expectOrRecover` (used
  // throughout steps 4/6/7/8/9 below) uses whichever handle matches the page it's asserting on to
  // force-close THAT socket deterministically on an assertion timeout, rather than inferring
  // death from receive silence (a watchdog design tried and removed — see support.ts's own note:
  // a receive-only socket has legitimate multi-second silence, including during a recovery wait
  // itself, so inactivity can't distinguish dead from quiet without an application heartbeat).
  const aRoute: WsRouteHandle = { current: undefined };
  const bRoute: WsRouteHandle = { current: undefined };

  test.beforeAll(async ({ browser }) => {
    // M6: the web app's create flow dropped bundled fixtures entirely (search is the only
    // picker now) — this deck needs a REAL course record to search for and pick in step 1
    // below. Search-first, create-if-absent, via the public course API directly (support.ts's
    // own doc comment) — idempotent across the gate's three consecutive runs.
    await ensureCourse(fixtureLinks18.courseName, fixtureLinks18);

    contextA = await browser.newContext();
    contextB = await browser.newContext();
    await installWsProxy(contextA, aRoute);
    await installWsProxy(contextB, bRoute);
    pageA = await contextA.newPage();
    pageB = await contextB.newPage();
  });

  test.afterAll(async () => {
    // beforeAll can fail before either context is assigned (e.g. browsers not installed) —
    // guarded so that failure reports as itself, not a secondary TypeError here.
    await contextA?.close();
    await contextB?.close();
  });

  test("1: context A creates the round on fixtureLinks18 as Ann (white, ch 8); reads the join code from SetupPanel", async () => {
    await pageA.goto("/create");
    // M6: CourseSearch replaced the old fixture <select> — search by name (ensureCourse above
    // guarantees exactly one real course record answers to it) and tap the one result.
    await pageA.getByLabel("Course", { exact: true }).fill(fixtureLinks18.courseName);
    const result = pageA.getByRole("button", { name: fixtureLinks18.courseName, exact: true }).first();
    await expect(result).toBeVisible();
    await result.click();
    await pageA.getByLabel("Your name").fill("Ann");
    await pageA.getByLabel("Course handicap").fill("8");
    await pageA.getByRole("button", { name: "Create round" }).click();

    await expect(pageA).toHaveURL(/\/round\//);
    const roundId = new URL(pageA.url()).pathname.replace("/round/", "");
    console.log(`[fieldTest] round ${roundId}`); // for the run report — a fresh round every invocation

    // SetupPanel's own layout: "Join code" label, then the code itself, as adjacent <p>s —
    // no ARIA name/testid on either, so a structural (following-sibling) lookup is the
    // reliable way to grab it, same convention as ../src/round/SetupPanel.tsx.
    const joinCodeCell = pageA.locator("xpath=//p[normalize-space(text())='Join code']/following-sibling::p[1]");
    await expect(joinCodeCell).toBeVisible();
    joinCode = ((await joinCodeCell.textContent()) ?? "").trim();
    expect(joinCode).toMatch(/^[A-Z0-9]{6}$/);
  });

  test("2: context B joins as Bo through the join UI (uppercased code); Cal and Dee join over HTTP directly", async () => {
    await pageB.goto("/join");
    await pageB.getByLabel("Code").fill(joinCode);
    await pageB.getByLabel("Your name").fill("Bo");
    await pageB.getByLabel("Tee").fill("white");
    await pageB.getByLabel("Course handicap").fill("2");
    await pageB.getByRole("button", { name: "Join round" }).click();
    await expect(pageB).toHaveURL(/\/round\//);

    // Cal and Dee join via a direct fetch, not a browser — score-for-anyone makes their own
    // browsers unnecessary, and joining them through context A would overwrite Ann's
    // localStorage credential for this round (one `swng:credential:<roundId>` key per round
    // per browser, not per golfer).
    const { httpUrl } = loadWebEnv();
    await joinRoundDirect(httpUrl, { code: joinCode, name: "Cal", tee: "white", courseHandicap: 15 });
    await joinRoundDirect(httpUrl, { code: joinCode, name: "Dee", tee: "white", courseHandicap: 5 });

    // Both already-live contexts must observe the full 4-person roster (via WS/pull) before
    // Step 3 drives AddGameForm's participant-derived <select>s.
    for (const page of [pageA, pageB]) {
      await waitForParticipant(page, "Cal");
      await waitForParticipant(page, "Dee");
    }
  });

  test("3: A adds fourball (Ann+Bo vs Cal+Dee) and skins (all four) via SetupPanel; both contexts render both chips", async () => {
    await addFourballGame(pageA, { a1: "Ann", a2: "Bo", b1: "Cal", b2: "Dee" });
    await expect(chip(pageA, "Fourball match")).toBeVisible();

    await addSkinsGame(pageA, PLAYER_NAMES);
    await expect(chip(pageA, "Skins")).toBeVisible();

    for (const page of [pageA, pageB]) {
      await expect(page.getByRole("tab")).toHaveCount(2);
    }
  });

  test("4: A scores holes 1-9 for all four (Cal h9 = 4 as entered); B sees the pre-correction skins snapshot live over WS", async () => {
    test.setTimeout(180_000);
    for (let hole = 1; hole <= 9; hole += 1) {
      for (const name of PLAYER_NAMES) {
        await enterScore(pageA, name, hole, scoreFor(name, hole));
      }
    }

    // The deck's pinned pre-correction snapshot: Cal 5 thru 9 (his as-entered h9 4 nets 3 on
    // his SI-4 dot, taking the pot h5-h9 carried). B only ever learns holes 1-9 via WS
    // broadcast from A — cross-context, WS-dependent — so this is wrapped for announced
    // recovery.
    const expectedThru9 = describeSkinsAt(9, false);
    await expectOrRecover(pageB, "B's pre-correction Skins snapshot (step 4)", () => expect(chip(pageB, "Skins")).toContainText(expectedThru9), bRoute);
  });

  test("5: B goes offline; A corrects Cal's h9 to 5; B scores holes 10-12 for all four while dark", async () => {
    test.setTimeout(120_000);
    await contextB.setOffline(true); // blocks B's future push/pull fetches
    await bRoute.current?.close().catch(() => {}); // actually severs B's socket — see beforeAll's own note
    await expect(pageB.getByRole("status").filter({ hasText: "Offline" })).toBeVisible();

    await enterScore(pageA, "Cal", 9, correctedScore("Cal", 9));

    for (let hole = 10; hole <= 12; hole += 1) {
      for (const name of PLAYER_NAMES) {
        await enterScore(pageB, name, hole, scoreFor(name, hole));
      }
    }

    // 12 queued scores: holes 10-12 × 4 players, none of them pushed yet.
    await expect(pageB.getByText(/^12 scores syncing/)).toBeVisible();

    // Offline is not an error: B's own fold still reads the stale (pre-correction) skins
    // standing it last confirmed — it never received Ann's h9 correction while dark.
    const staleSkins = describeSkinsAt(12, false);
    await expect(chip(pageB, "Skins")).toContainText(staleSkins);
  });

  test("6: B reconnects via the UI's Sync now affordance; drains to pending 0, refolds skins, and A sees B's holes 10-12", async () => {
    test.setTimeout(60_000);
    await contextB.setOffline(false);
    await pageB.getByRole("button", { name: "Sync now" }).click();

    await expect(pageB.getByText(/scores? syncing/)).not.toBeVisible();

    // The correction moved the pot: Cal's skins go to 0, Dee's h10 pot swells to 6 (2 -> 8). B's
    // own refold is from ITS OWN Sync-now pull just above (HTTP, not WS) — not cross-context
    // WS-dependent, so this one stays bare.
    const refoldedSkins = describeSkinsAt(12, true);
    await expect(chip(pageB, "Skins")).toContainText(refoldedSkins);

    // A (never offline) must receive B's drained holes 10-12 — and the h9 correction's
    // downstream refold — purely over its own WS push from the server. This is exactly the
    // cross-context WS-dependent pair m6-gate-field-2.log caught pageA's real socket silently
    // failing on, so both are wrapped for announced recovery.
    await expectOrRecover(pageA, "A's Skins refold after B's Sync now (step 6)", () => expect(chip(pageA, "Skins")).toContainText(refoldedSkins), aRoute);
    await expectOrRecover(
      pageA,
      "A sees Dee's hole 11 from B (step 6)",
      () => expect(pageA.getByRole("button", { name: "Dee hole 11", exact: true })).toHaveText(new RegExp(`^\\D*${scoreFor("Dee", 11)}`)),
      aRoute,
    );
  });

  test("7: A scores holes 13-16 (two-tap proven structurally on one entry); the h16 digest fires on both contexts", async () => {
    test.setTimeout(120_000);

    // The two-tap contract, made explicit: exactly two click() calls take the grid from an
    // idle cell to a posted score, and the pad closes on the very same tap that posts it — no
    // separate confirm step. Every other entry in this spec goes through enterScore() (the
    // same two clicks), so this one entry stands in for all of them, per the brief.
    const cell = pageA.getByRole("button", { name: "Ann hole 13", exact: true });
    await expect(cell).toContainText("–"); // idle placeholder (dots may already show — fourball allocates Ann a dot on hole 13's SI-4)
    await cell.click(); // click 1 of 2
    const dialog = pageA.getByRole("dialog", { name: "Score for Ann, hole 13", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: String(scoreFor("Ann", 13)), exact: true }).click(); // click 2 of 2
    await expect(dialog).toBeHidden(); // pad closed, no confirm step
    await expect(cell).toHaveText(new RegExp(`^\\D*${scoreFor("Ann", 13)}`)); // posted

    for (const name of PLAYER_NAMES) {
      if (name === "Ann") continue; // entered above
      await enterScore(pageA, name, 13, scoreFor(name, 13));
    }
    for (let hole = 14; hole <= 16; hole += 1) {
      for (const name of PLAYER_NAMES) {
        await enterScore(pageA, name, hole, scoreFor(name, hole));
      }
    }

    // Dormie at 16, fourball 2 up; the h16 skin still riding into 17 — the deck's own thru-16
    // pin, via the app's own describeGame.
    const expectedFourball = describeFourballAt(16, true);
    const expectedSkins = describeSkinsAt(16, true);

    for (const { page, route } of [
      { page: pageA, route: aRoute },
      { page: pageB, route: bRoute },
    ]) {
      // waitForDigestOrRecover force-closes THIS page's own proxied socket on an assertion
      // timeout (announced via console.log + a "ws-fallback" annotation) exactly like step 9's
      // waitForFinalOrRecover — deterministic, not inferred: a delivery hiccup on either page's
      // WS strands this digest wait with nothing to recover from otherwise.
      await waitForDigestOrRecover(page, "After hole 16", route);
      const digest = page.getByRole("status", { name: "After hole 16" });
      await expect(digest).toContainText(expectedFourball);
      await expect(digest).toContainText(expectedSkins);
      // Dismiss now (rather than relying solely on the next entry's auto-dismiss) — a digest
      // overlay sits above the grid and must never block the next tap (brief).
      await digest.getByRole("button", { name: "Dismiss" }).click();
    }
  });

  test("8: A scores hole 17 (Ann picked up; Bo/Cal/Dee strokes) and hole 18 for all four; fourball closes 2&1", async () => {
    test.setTimeout(60_000);
    for (const name of PLAYER_NAMES) {
      await enterScore(pageA, name, 17, scoreFor(name, 17));
    }
    for (const name of PLAYER_NAMES) {
      await enterScore(pageA, name, 18, scoreFor(name, 18));
    }

    const expectedFourballFinal = describeFourballAt(18, true); // "Ann & Bo win 2&1"
    const expectedSkinsFinal = describeSkinsAt(18, true); // "Bo 7 · Dee 8 · 3 carried out"

    // A scored holes 17-18 itself — same-page local state (its own optimistic fold), not
    // WS-dependent, so these stay bare.
    await expect(chip(pageA, "Fourball match")).toContainText(expectedFourballFinal);
    await expect(chip(pageA, "Skins")).toContainText(expectedSkinsFinal);

    // B only ever learns holes 17-18 via WS broadcast from A — cross-context, WS-dependent.
    // Skins (unlike fourball) only settles once hole 18 itself is decided — asserting it here
    // proves B actually received every one of hole 18's four scores, not just enough of them
    // for fourball's already-closed 2&1 to read correctly.
    await expectOrRecover(pageB, "B's Fourball final (step 8)", () => expect(chip(pageB, "Fourball match")).toContainText(expectedFourballFinal), bRoute);
    await expectOrRecover(pageB, "B's Skins final (step 8)", () => expect(chip(pageB, "Skins")).toContainText(expectedSkinsFinal), bRoute);
  });

  test("9: A finalizes; both contexts render matching ResultsView with the deck-correct final numbers", async () => {
    test.setTimeout(60_000);
    await pageA.getByRole("button", { name: "Finalize round" }).click();
    await pageA.getByRole("dialog", { name: "Confirm finalize" }).getByRole("button", { name: "Finalize", exact: true }).click();

    await expect(pageA.getByRole("heading", { name: "Final results" })).toBeVisible();
    // finalize's WS broadcast fires after settleRound + the archive write (finalizeRound.ts) —
    // strictly more backend work, and more elapsed real time, than a plain score's broadcast.
    // waitForFinalOrRecover force-closes B's own proxied socket on a timeout (deterministic, not
    // banner-gated) and taps B's own "Sync now" affordance — the same recovery a real golfer has,
    // not a hidden retry of the assertion itself.
    await waitForFinalOrRecover(pageB, bRoute);

    const expectedFourballFinal = describeFourballAt(18, true); // "Ann & Bo win 2&1"
    const expectedSkinsFinal = describeSkinsAt(18, true); // "Bo 7 · Dee 8 · 3 carried out"

    // M6 field-test upkeep finding: ResultsView.tsx (M6 Task 5, commit 8d8d1ba) replaced its
    // own standalone per-game <ul> (the direct sibling of the "Final results" <h1>) with the
    // SAME StandingsHeader tablist a live round renders — "the archive gets the same
    // chip-selected active game as a live round" per that commit's own message. There is no
    // longer any <ul> sibling of the heading at all (only the "Handicap differentials" one,
    // nested inside a <div>), so the xpath this used to use can never match again — a stale
    // locator from before that restructuring, not a product bug (the ARIA snapshot of a
    // failed run showed the tablist rendering the exact right text). Fixed here to read the
    // SAME tablist `chip()` already reads on a LIVE round (support.ts) — the expected VALUES
    // below are untouched, still derived from the deck via describeFourballAt/describeSkinsAt.
    const finalGames = (page: Page) => page.getByRole("tablist", { name: "Games" });

    for (const page of [pageA, pageB]) {
      await expect(finalGames(page)).toContainText(expectedFourballFinal);
      await expect(finalGames(page)).toContainText(expectedSkinsFinal);
    }

    // Deep match: B's ResultsView (rendered from a WS-pushed finalize, per Task 6's own
    // contract) reads byte-identical to A's (rendered from its own finalize response) on the
    // game-results text.
    const [textA, textB] = await Promise.all([finalGames(pageA).innerText(), finalGames(pageB).innerText()]);
    expect(textB).toBe(textA);

    // The archived card: entry locked, no pad ever opens.
    await expect(pageA.getByRole("button", { name: "Ann hole 1", exact: true })).toBeDisabled();
  });
});
