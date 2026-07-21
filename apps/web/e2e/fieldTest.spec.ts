import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { finalizeRoundResponseSchema, parse } from "@swng/contracts";
import { fixtureLinks18 } from "@swng/domain";
import {
  addFourballGame,
  addSkinsGame,
  addStablefordGame,
  chip,
  clearScore,
  correctedScore,
  describeFourballAt,
  describeSkinsAt,
  ensureCourse,
  enterScore,
  expectOrRecover,
  gameChips,
  injectAuthTokens,
  installWsProxy,
  joinRoundDirect,
  loadWebEnv,
  mintAccountGolfer,
  mintThrowawayUser,
  PLAYER_NAMES,
  readJoinCode,
  screenshotPath,
  scoreFor,
  waitForFinalOrRecover,
  waitForParticipant,
} from "./support.js";
import type { AccountGolfer, WsRouteHandle } from "./support.js";
import type { AuthTokens } from "../src/auth/tokenStore.js";

// The M5 gate (docs/implementation-plan.md M5 Task 7): a full 18-hole round of fourball match
// + skins, played through the REAL UI in two Chromium contexts against the deployed swng-beta
// stack, with a dark stretch for context B mid-round. `@swng/domain`'s fieldDeck18 is the
// oracle for every score entered AND every expected UI string (via describeFourballAt/
// describeSkinsAt in ./support.ts, which run the deck through the app's own describeGame) —
// nothing here is a hand-copied number. One spec, two contexts, ten numbered steps mirroring
// the brief's own scenario. Kept out of `pnpm validate`/`pnpm -r test` entirely: it has its
// own script (`pnpm e2e:field`, playwright.config.ts) and vitest.config.ts's own "e2e/**"
// exclude means the default `vitest run` never even sees this file.
//
// Accounts-only (the wall): all four golfers are signed-in accounts. Ann/Cal/Dee are minted
// AND named by the harness (their naming isn't what this deck gates); Bo is minted with his
// placeholder name left in place, because step 2 drives the REAL funnel — sign-in CTA, the
// one required "What should the card call you?" prompt, then the join form — the join link's
// whole sign-up story, in the browser (only Cognito's stock hosted form itself is skipped;
// that's the controller's live spot-walk).
test.describe.serial("M5 field test — two browsers, offline mid-round, the full 18 of fourball + skins", () => {
  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let joinCode = "";
  let seededCourseId = ""; // the fixtureLinks18 lineage id, captured at seed time for the course-record beat (test 11)
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

  let boTokens: AuthTokens; // deliberately NOT named at mint — step 2's funnel prompt is where "Bo" gets typed
  let calAccount: AccountGolfer;
  let deeAccount: AccountGolfer;

  test.beforeAll(async ({ browser }) => {
    // M6: the web app's create flow dropped bundled fixtures entirely (search is the only
    // picker now) — this deck needs a REAL course record to search for and pick in step 1
    // below. Search-first, create-if-absent, via the public course API directly (support.ts's
    // own doc comment) — idempotent across the gate's three consecutive runs. Seeding a course is
    // a golfer-gated write now (course-cards spec §4), so it's minted with Ann's account Bearer.
    //
    // Four accounts, one per deck golfer (see this file's header). Ann's tokens are injected
    // before pageA's first navigation (CreateRoundPage is sign-in-gated); Bo's are injected
    // mid-step-2, AFTER his signed-out funnel landing has been asserted.
    const annAccount = await mintAccountGolfer("field-ann", "Ann");
    seededCourseId = (await ensureCourse(fixtureLinks18.courseName, fixtureLinks18, annAccount)).courseId;
    boTokens = await mintThrowawayUser("field-bo");
    calAccount = await mintAccountGolfer("field-cal", "Cal");
    deeAccount = await mintAccountGolfer("field-dee", "Dee");

    contextA = await browser.newContext();
    contextB = await browser.newContext();
    await installWsProxy(contextA, aRoute);
    await installWsProxy(contextB, bRoute);
    pageA = await contextA.newPage();
    pageB = await contextB.newPage();
    await injectAuthTokens(pageA, annAccount.tokens);
  });

  test.afterAll(async () => {
    // beforeAll can fail before either context is assigned (e.g. browsers not installed) —
    // guarded so that failure reports as itself, not a secondary TypeError here.
    await contextA?.close();
    await contextB?.close();
  });

  test("1: context A, signed in as Ann, creates the round on fixtureLinks18 (white, ch 8); reads the join code from SetupPanel", async () => {
    await pageA.goto("/create");
    // M6: CourseSearch replaced the old fixture <select> — search by name (ensureCourse above
    // guarantees exactly one real course record answers to it) and tap the one result.
    await pageA.getByLabel("Course", { exact: true }).fill(fixtureLinks18.courseName);
    // Course-cards arc: CourseSearch renders "name · N holes" — match the FULL accessible name
    // (exact) with the count derived from the fixture card itself, so a shorter course name
    // that prefixes another (e.g. "Fixture Links" vs "Fixture Links 18") can never cross-match.
    const result = pageA
      .getByRole("button", { name: `${fixtureLinks18.courseName} · ${fixtureLinks18.teeSets[0]!.holes.length} holes`, exact: true })
      .first();
    await expect(result).toBeVisible();
    await result.click();
    // No name entry: the create form renders "Playing as Ann" from the account's own record —
    // there is no name field to fill anymore.
    await expect(pageA.getByText("Playing as", { exact: true })).toBeVisible();
    await pageA.getByLabel("Strokes you get here").fill("8");
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

  test("2: context B joins as Bo through the REAL funnel — sign-in CTA, the name prompt, then the join form; Cal and Dee join as themselves over HTTP", async () => {
    // The join link's signed-out landing IS the sign-up funnel's front door (accounts-only
    // identity spec §3): the code rides the URL, and the page offers exactly one way forward —
    // the sign-in CTA (scoped to <main>; the header chrome carries its own compact Sign in).
    await pageB.goto(`/join?code=${joinCode}`);
    await expect(pageB.getByRole("main").getByRole("button", { name: /^sign in$/i })).toBeVisible();

    // The Hosted-UI round trip itself is Cognito's stock form — the controller's live
    // spot-walk covers it, not this automated gate — so the harness injects Bo's minted
    // tokens and re-lands on the SAME funnel URL, exactly where AuthCallbackPage's returnTo
    // would drop a real golfer after sign-up.
    await injectAuthTokens(pageB, boTokens);
    await pageB.goto(`/join?code=${joinCode}`);

    // Bo's account was minted WITHOUT a name: his first GET /me minted a placeholder-named
    // golfer, so the funnel asks its one required question before any join form renders —
    // this is where "Bo" gets typed, the only name entry in his whole story.
    await pageB.getByLabel("What should the card call you?").fill("Bo");
    await pageB.getByRole("button", { name: /^continue$/i }).click();

    // The prompt resolves into the join form on the same visit — "Playing as Bo" from the
    // record, the code preserved through the whole trip.
    await expect(pageB.getByText("Playing as", { exact: true })).toBeVisible();
    await expect(pageB.getByRole("main").getByText("Bo", { exact: true })).toBeVisible();

    // M6 (M-a fix): JoinRoundPage fires a debounced (250ms) peek once the 6-char code is
    // complete and, on success, swaps the free-text Tee <input> for a <select> pre-populated
    // from the round's frozen card, alongside a "Joining <courseName>" line. Waiting for that
    // line (rather than racing the debounce with a free-text fill()) makes this deterministic
    // AND actually exercises the M6 peek tee picker end-to-end. The free-text fallback path
    // (peek failure) stays covered at the component level, not here.
    await expect(pageB.getByText(`Joining ${fixtureLinks18.courseName}`)).toBeVisible();
    await pageB.getByLabel("Tee").selectOption("white");

    await pageB.getByLabel("Strokes you get here").fill("2");
    await pageB.getByRole("button", { name: "Join round" }).click();
    await expect(pageB).toHaveURL(/\/round\//);

    // Cal and Dee join via a direct fetch, not a browser — score-for-anyone makes their own
    // browsers unnecessary, and joining them through context A would overwrite Ann's
    // localStorage credential for this round (one `swng:credential:<roundId>` key per round
    // per browser, not per golfer) — but as THEMSELVES, each with their own Bearer (self-join
    // is the only way onto a card now; the old roster-seeding path a host could use to add
    // others is deleted, and this harness never had support for it).
    const { httpUrl } = loadWebEnv();
    await joinRoundDirect(httpUrl, calAccount, { code: joinCode, tee: "white", courseHandicap: 15 });
    await joinRoundDirect(httpUrl, deeAccount, { code: joinCode, tee: "white", courseHandicap: 5 });

    // Both already-live contexts must observe the full 4-person roster (via WS/pull) before
    // Step 3 drives AddGameForm's participant-derived <select>s.
    for (const page of [pageA, pageB]) {
      await waitForParticipant(page, "Cal");
      await waitForParticipant(page, "Dee");
    }
  });

  test("3: A adds fourball (Ann+Bo vs Cal+Dee) and skins (all four) via SetupPanel; both contexts render both chips", async () => {
    await addFourballGame(pageA, { a1: "Ann", a2: "Bo", b1: "Cal", b2: "Dee" });
    await expect(chip(pageA, "Four-ball")).toBeVisible();

    // Same trailing form-reset race the M7 termination describe's own singles→stableford hop
    // guards against (see its note): AddGameForm.submit does `await onAddGame(config)` THEN
    // `changeKind(kind)`, but the chip above appears from the OPTIMISTIC fold, before that POST
    // resolves — so on a slow beta POST the fourball reset can fire mid-addSkinsGame, reverting
    // Kind→fourball-match (the Who's in? checkbox group vanishes) and hanging addSkinsGame's own
    // `.check()`. Team 1's "First player" returning to "Select…" (value "") is the form-local
    // signal the reset has already fired; deterministic, no WS. Then the skins setup is race-free.
    const team1First = pageA.getByRole("group", { name: "Team 1" }).getByRole("combobox", { name: "First player", exact: true });
    await expect(team1First).toHaveValue("", { timeout: 15_000 });

    await addSkinsGame(pageA, PLAYER_NAMES);
    await expect(chip(pageA, "Skins")).toBeVisible();

    // pageA's own chip count is same-context (A added both games itself — its own optimistic
    // fold), so it stays bare. pageB only learns of A's game-adds via WS broadcast —
    // cross-context, WS-dependent, the exact seam expectOrRecover exists for (see support.ts's
    // own doc comment) — so it gets the announced force-close + Sync-now recovery instead of a
    // bare wait that can hang to the suite's 120s test timeout on a silently-lost push.
    // gameChips (not a bare getByRole("button")) — chips are plain buttons now (Task 3: no more
    // tablist), so a bare button role would also match Add game/Sync now/Finalize round etc.
    await expect(gameChips(pageA)).toHaveCount(2);
    await expectOrRecover(pageB, "B sees both game chips (test 3)", () => expect(gameChips(pageB)).toHaveCount(2), bRoute);
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

  test("5: A clears Cal's mis-tapped h9 (both browsers see the refold), re-enters it correctly; B goes offline; B scores holes 10-12 for all four while dark", async () => {
    test.setTimeout(120_000);

    // The clear-score beat, live: Cal's h9 was mis-tapped as 4 (test 4's "as entered" value) —
    // A clears it via the pad's own "Clear score" button (ScorePad.tsx: rendered only when the
    // tapped cell already holds a result), and BOTH contexts refold the skins chip back to the
    // pre-score line (skins.ts's own "stop at the first gap": with Cal's h9 cell gone, hole 9 is
    // undecided again, so the standing reads exactly as it did after hole 8 — describeSkinsAt(8,
    // …) — regardless of what Ann/Bo/Dee's own already-scored h9 cells hold, since the chain
    // never even looks past the first undecided hole). This must happen BEFORE B goes offline
    // below — the whole point is that B observes the refold live, over the same WS broadcast a
    // real golfer would.
    await clearScore(pageA, "Cal", 9);
    const preScoreSkins = describeSkinsAt(8, false); // hole 9 no longer decided for anyone — carries from hole 8
    await expect(chip(pageA, "Skins")).toContainText(preScoreSkins); // A's own optimistic fold, same-page, stays bare
    await expectOrRecover(pageB, "B sees the cleared-cell skins refold (step 5)", () => expect(chip(pageB, "Skins")).toContainText(preScoreSkins), bRoute);

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

    // Offline is not an error — and B's stale state is the POST-CLEAR one: it saw the clear
    // live (asserted above) but went dark before A's re-entry, so its fold still has Cal's h9
    // as a gap. The skins chain stops at the first undecided hole (skins.ts — a cleared cell
    // is a gap), so B's own queued holes 10-12 can't move the skins standing until the h9
    // correction lands: the chip must still read exactly the post-clear line, not a walk of
    // B's local holes. (A cleared-blind fold that counted h9's surviving cells WOULD move it —
    // this assertion pins the accessor on the offline path too.)
    const staleSkins = describeSkinsAt(8, false);
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

  test("7: A scores holes 13-16 (two-tap proven structurally on one entry); both contexts' chips read the deck's thru-16 lines", async () => {
    test.setTimeout(120_000);

    // The two-tap contract, made explicit: exactly two click() calls take the grid from an
    // idle cell to a posted score, and the pad closes on the very same tap that posts it — no
    // separate confirm step. Every other entry in this spec goes through enterScore() (the
    // same two clicks), so this one entry stands in for all of them, per the brief.
    const cell = pageA.getByRole("button", { name: "Ann hole 13", exact: true });
    await expect(cell).toContainText("–"); // idle placeholder (dots may already show — the standard card's own course-handicap dots, not a game: Ann's CH 8 gets a dot on hole 13, SI 4)
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
    // pin, via the app's own describeGame. The between-holes digest is DELETED (accounts-only
    // identity spec §6: standings are pullable via the chips, never a push-interruption), so
    // the same cross-context thru-16 convergence this step used to read off the digest is
    // asserted on the chips themselves — the very surface a real golfer now checks between
    // holes. A's own entries are same-page local state (its optimistic fold) and stay bare;
    // B only learns holes 13-16 via WS broadcast from A — cross-context, WS-dependent — so
    // B's pair gets the announced force-close + Sync-now recovery, same as steps 4/6/8.
    const expectedFourball = describeFourballAt(16, true);
    const expectedSkins = describeSkinsAt(16, true);

    await expect(chip(pageA, "Four-ball")).toContainText(expectedFourball);
    await expect(chip(pageA, "Skins")).toContainText(expectedSkins);
    await expectOrRecover(pageB, "B's Fourball thru 16 (step 7)", () => expect(chip(pageB, "Four-ball")).toContainText(expectedFourball), bRoute);
    await expectOrRecover(pageB, "B's Skins thru 16 (step 7)", () => expect(chip(pageB, "Skins")).toContainText(expectedSkins), bRoute);
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
    await expect(chip(pageA, "Four-ball")).toContainText(expectedFourballFinal);
    await expect(chip(pageA, "Skins")).toContainText(expectedSkinsFinal);

    // B only ever learns holes 17-18 via WS broadcast from A — cross-context, WS-dependent.
    // Skins (unlike fourball) only settles once hole 18 itself is decided — asserting it here
    // proves B actually received every one of hole 18's four scores, not just enough of them
    // for fourball's already-closed 2&1 to read correctly.
    await expectOrRecover(pageB, "B's Fourball final (step 8)", () => expect(chip(pageB, "Four-ball")).toContainText(expectedFourballFinal), bRoute);
    await expectOrRecover(pageB, "B's Skins final (step 8)", () => expect(chip(pageB, "Skins")).toContainText(expectedSkinsFinal), bRoute);
  });

  test("9: A finalizes; both contexts render matching ResultsView with the deck-correct final numbers", async () => {
    test.setTimeout(60_000);
    await pageA.getByRole("button", { name: "Finalize round" }).click();
    await pageA.getByRole("dialog", { name: "Confirm finalize" }).getByRole("button", { name: /^finalize$/i }).click();

    await expect(pageA.getByRole("heading", { name: "Final results" })).toBeVisible();
    // finalize's WS broadcast fires after settleRound + the archive write (finalizeRound.ts) —
    // strictly more backend work, and more elapsed real time, than a plain score's broadcast.
    // waitForFinalOrRecover force-closes B's own proxied socket on a timeout (deterministic, not
    // banner-gated) and taps B's own "Sync now" affordance — the same recovery a real golfer has,
    // not a hidden retry of the assertion itself.
    await waitForFinalOrRecover(pageB, bRoute);

    const expectedFourballFinal = describeFourballAt(18, true); // "Ann & Bo win 2&1"
    const expectedSkinsFinal = describeSkinsAt(18, true); // "Bo 7 · Dee 8 · 3 carried out"

    // ResultsView.tsx renders the archived card through the SAME StandingsHeader a live round
    // uses ("the archive gets the same card as a live round"). spec 2026-07-19 §2a/§2b dropped
    // tablist semantics from StandingsHeader entirely — chips are plain disclosure buttons now,
    // no wrapping "Games" tablist landmark exists to query — so this reads the SAME `chip()`
    // helper every earlier step in this file already reads on the live round (support.ts). The
    // expected VALUES are untouched, still derived from the deck via
    // describeFourballAt/describeSkinsAt.
    for (const page of [pageA, pageB]) {
      await expect(chip(page, "Four-ball")).toContainText(expectedFourballFinal);
      await expect(chip(page, "Skins")).toContainText(expectedSkinsFinal);
    }

    // Deep match: B's ResultsView (rendered from a WS-pushed finalize, per Task 6's own
    // contract) reads byte-identical to A's (rendered from its own finalize response) on each
    // game's own chip text.
    const [fourballTextA, fourballTextB] = await Promise.all([chip(pageA, "Four-ball").innerText(), chip(pageB, "Four-ball").innerText()]);
    expect(fourballTextB).toBe(fourballTextA);
    const [skinsTextA, skinsTextB] = await Promise.all([chip(pageA, "Skins").innerText(), chip(pageB, "Skins").innerText()]);
    expect(skinsTextB).toBe(skinsTextA);

    // The archived card: entry locked, no pad ever opens.
    await expect(pageA.getByRole("button", { name: "Ann hole 1", exact: true })).toBeDisabled();
  });

  test("10: B opens Ann's golfer page from the results Roster; her record renders under her own name", async () => {
    // GolferLink (navigation spec §4a): ResultsView's Roster list (aria-label="Roster", distinct
    // from the "Posted to handicaps" list below it, which links the SAME four names a second
    // time) links every name to /golfers/{golferId}. B is signed in as Bo — any signed-in
    // golfer's Bearer is enough for GET /golfers/{golferId} (auth tier "golfer").
    await pageB.getByRole("list", { name: "Roster" }).getByRole("link", { name: "Ann", exact: true }).click();

    await expect(pageB).toHaveURL(/\/golfers\/[^/]+$/);
    await expect(pageB.getByRole("heading", { name: "Ann", exact: true })).toBeVisible();

    // RecordSections (GolferPage.tsx) — the SAME extraction ProfilePage renders for yourself,
    // rendered here with person="their" (whole-branch-review finding: the copy itself must read
    // third-person, not just the index line above it), no controls. Both section headings render
    // regardless of how much history Ann has accrued (the chart's own <8-rounds gate changes its
    // body text, never its heading).
    await expect(pageB.getByRole("heading", { name: "Their index over time" })).toBeVisible();
    await expect(pageB.getByRole("heading", { name: "History" })).toBeVisible();
  });

  test("11: Ann's course page shows 'Your record here' with the just-finalized round counted", async () => {
    test.setTimeout(120_000);
    // CourseRecordSection (analytics read-folds spec 2026-07-21 §4; apps/web/src/courses/
    // CourseRecordSection.tsx) fetches GET /me/courses/{courseId}/record ONCE on mount and renders
    // NOTHING until the caller has ≥1 round at the course (returns null at rounds === 0). The
    // projector is async relative to finalize, and the section does not re-fetch on its own — so
    // reload the course page until Ann's freshly-finalized fourball round lands in her own rows.
    // Ann is a fresh account each run (mintAccountGolfer), and she plays exactly this one round on
    // fixtureLinks18 in the whole suite, so her OWN record here is precisely "Rounds played — 1"
    // (rounds counts lines at the course in ANY state — courseRecord.ts — so her hole-17 pickup
    // still counts). pageA is signed in as Ann, so the section is her own record.
    const recordHeading = pageA.getByRole("heading", { name: "Your record here", exact: true });
    await expect(async () => {
      await pageA.goto(`/courses/${seededCourseId}`);
      await expect(recordHeading).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 90_000 });

    // The "Rounds played — N" list item is the first <li> under the heading (CourseRecordSection's
    // own JSX) — exactly 1 for Ann's fresh account.
    await expect(pageA.getByText("Rounds played — 1", { exact: true })).toBeVisible();
  });
});

// M7 Task 8 (docs/superpowers/plans/2026-07-10-m7-identity.md Task 8; docs/papercuts.md's
// "Decided direction" section): termination coverage — a round with two games, one driven to
// a real result, one left barely scored, finalized via "End unfinished games & finalize". The
// plan's own brief names this file as the natural home ("a termination step fits naturally
// after fieldTest step 7") but as its OWN describe.serial block with a fresh context, not a
// tenth numbered step inside the M5 deck above — a termination bug here must never perturb
// (or be perturbed by) the fourball+skins deck's own assertions, and a fresh context is the
// cheapest way to guarantee that (fixtureLinks18 is idempotently re-seeded either way).
test.describe.serial("M7 termination coverage — end an unresolved game, finalize the rest", () => {
  let page: Page;
  let quinnAccount: AccountGolfer;
  // Single context (Pat) — Quinn joins over a direct HTTP fetch (score-for-anyone, same
  // precedent as Cal/Dee in the M5 describe above), so Pat's OWN page only ever learns of
  // Quinn's join via WS broadcast/pull — the same cross-context WS-liveness seam the M5 describe
  // guards with expectOrRecover. This route handle wires the identical recovery machinery
  // (support.ts's installWsProxy/expectOrRecover) into this describe too.
  const route: WsRouteHandle = { current: undefined };

  test.beforeAll(async ({ browser }) => {
    // Accounts-only: Pat drives the browser signed in; Quinn's account exists purely for his
    // own out-of-browser self-join in test 1. Seeding a course is a golfer-gated write now
    // (course-cards spec §4), so it's minted with Pat's account Bearer (idempotent — already
    // seeded by the M5 block above when both run in the same pnpm e2e:field invocation).
    const patAccount = await mintAccountGolfer("field-pat", "Pat");
    await ensureCourse(fixtureLinks18.courseName, fixtureLinks18, patAccount);
    quinnAccount = await mintAccountGolfer("field-quinn", "Quinn");
    const context = await browser.newContext();
    await installWsProxy(context, route);
    page = await context.newPage();
    await injectAuthTokens(page, patAccount.tokens);
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test("1: Pat creates a throwaway round on fixtureLinks18; Quinn joins as himself over a direct HTTP fetch", async () => {
    await page.goto("/create");
    await page.getByLabel("Course", { exact: true }).fill(fixtureLinks18.courseName);
    // Full "name · N holes" accessible name — see the M5 block's own comment above.
    const result = page
      .getByRole("button", { name: `${fixtureLinks18.courseName} · ${fixtureLinks18.teeSets[0]!.holes.length} holes`, exact: true })
      .first();
    await expect(result).toBeVisible();
    await result.click();
    // No name entry: "Playing as Pat" renders from the account's own record.
    await page.getByLabel("Strokes you get here").fill("0");
    await page.getByRole("button", { name: "Create round" }).click();

    await expect(page).toHaveURL(/\/round\//);
    const joinCode = await readJoinCode(page);

    // Score-for-anyone precedent (Cal/Dee, Quinn elsewhere in this file) — Quinn's own tab
    // adds nothing this scenario needs; his join carries his own Bearer (self-join only).
    const { httpUrl } = loadWebEnv();
    await joinRoundDirect(httpUrl, quinnAccount, { code: joinCode, tee: "white", courseHandicap: 0 });
    // Quinn's join is a direct HTTP fetch, not a browser — Pat's page only ever learns of it via
    // WS broadcast/pull, cross-context and WS-dependent (same seam as the M5 describe's own
    // waitForParticipant loop), so it gets the announced force-close + Sync-now recovery instead
    // of a bare wait that can hang to the suite's 120s test timeout on a silently-lost push.
    await expectOrRecover(page, "Pat sees Quinn's join (test 1)", () => waitForParticipant(page, "Quinn"), route);
  });

  test("2: a singles match (Pat vs Quinn) and a stableford (Pat, Quinn) are both added", async () => {
    await page.getByRole("radio", { name: "Match play", exact: true }).check();
    await page.getByRole("combobox", { name: "Player 1", exact: true }).selectOption({ label: "Pat" }); // Pat is this page's own optimistic participant — same-context, stays bare

    // Player 2's <option>s render from the SAME state.participants Quinn's own roster/checkbox
    // text renders from (SetupPanel.tsx), so test 1's recovery-guarded wait above should already
    // guarantee this — but a bare selectOption({ label }) has NO configured timeout of its own
    // (playwright.config.ts sets no use.actionTimeout), so on any residual staleness it would
    // silently retry for the FULL 120s test timeout rather than failing fast — exactly the "2-min
    // hang, then 'Target page, context or browser has been closed'" symptom a real beta run hit
    // here. Guard the <option>'s actual presence with the SAME bounded, recoverable
    // expectOrRecover wait first, THEN do the (now cheap, already-satisfied) select.
    const player2 = page.getByRole("combobox", { name: "Player 2", exact: true });
    const quinnOption = player2.locator("option", { hasText: /^Quinn$/ });
    await expectOrRecover(page, "Quinn appears in the Player 2 options (test 2)", () => expect(quinnOption).toHaveCount(1), route);
    await player2.selectOption({ label: "Quinn" });
    await page.getByRole("button", { name: "Add game" }).click();
    await expect(chip(page, "Match play")).toBeVisible();

    // Settle the match-play submit's OWN trailing form-reset before starting the stableford.
    // AddGameForm.submit does `await onAddGame(config)` (a network POST) THEN `changeKind(kind)`
    // — but the "Match play" chip above appears from the session's OPTIMISTIC fold, which can
    // land well BEFORE that POST resolves. On a slow beta POST the reset therefore fires while
    // addStablefordGame is mid-setup, reverting Kind→singles-match and wiping the checked Pat/
    // Quinn, leaving "Add game" disabled forever (observed: run 5's 120s hang at this exact
    // seam). Player 1 returning to "Select…" (value "") is the form-local signal that the reset
    // has already fired — deterministic, no WS involved — so nothing can reset the form out from
    // under the stableford setup that follows.
    await expect(page.getByRole("combobox", { name: "Player 1", exact: true })).toHaveValue("", { timeout: 15_000 });

    await addStablefordGame(page, ["Pat", "Quinn"]);
    await expect(chip(page, "Stableford")).toBeVisible();
  });

  test("3: 10 holes scored (Pat strokes, Quinn picked up every hole) closes the match 10&8 and leaves stableford barely started", async () => {
    test.setTimeout(90_000);
    for (let hole = 1; hole <= 10; hole += 1) {
      await enterScore(page, "Pat", hole, 4);
      await enterScore(page, "Quinn", hole, "picked-up");
    }

    // Quinn's net is undefined (picked-up) on every one of holes 1-10, so Pat wins every hole
    // outright regardless of his own score (singlesMatch.ts: "picked-up/conceded (net
    // undefined) loses the hole outright") — 10 up thru 10, remaining 8, and 10 > 8 closes the
    // match "10&8" (matchLadder.ts's own closeout rule). Hand-derived from the engine's own
    // documented rules for this fresh throwaway scenario (not fieldDeck18-sourced) — a
    // disagreement here is this test failing honestly, never something to relax.
    await expect(chip(page, "Match play")).toContainText("Pat wins 10&8");

    // Stableford needs EVERY configured player's EVERY hole decided to resolve
    // (allPlayersComplete, scoring/stableford.ts) — holes 11-18 are untouched for both Pat and
    // Quinn, so it stays unresolved on purpose (the "barely scored" half of this test's name).
  });

  test("4: the finalize dialog lists the unresolved stableford; 'End unfinished games & finalize' resolves it", async () => {
    await page.getByRole("button", { name: "Finalize round" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm finalize" });
    await expect(dialog).toContainText("Some games aren't finished:");
    // describeMissing (finalizeReadiness.ts) groups both players under ONE clause since
    // they're missing the identical hole range — Pat and Quinn are both unscored 11-18.
    await expect(dialog).toContainText("Stableford — holes 11–18 unscored for Pat, Quinn");

    // Legibility walk (papercuts.md §4): the finalize dialog's own unresolved-games list.
    await page.screenshot({ path: screenshotPath("finalize-dialog-unresolved.png"), fullPage: true });

    const finalizeResponsePromise = page.waitForResponse((r) => r.url().includes("/finalize") && r.request().method() === "POST");
    await dialog.getByRole("button", { name: /^end unfinished games & finalize$/i }).click();
    const finalizeResponse = await finalizeResponsePromise;
    const body = parse(finalizeRoundResponseSchema, await finalizeResponse.json());

    // The archive's own settle: exactly the singles match resolved — stableford is excluded
    // from settleRound's must-resolve set once terminated (domain/round/archive.ts), so it
    // never appears in `results` at all. This server-computed settle is the ground truth
    // test 5's ResultsView assertions are checked against.
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.kind).toBe("singles-match");

    await expect(page.getByRole("heading", { name: "Final results" })).toBeVisible();
  });

  test("5: ResultsView shows the singles-match result and the stableford's Ended badge", async () => {
    await expect(chip(page, "Match play")).toContainText("Pat wins 10&8");
    await expect(chip(page, "Stableford")).toContainText("Ended");
  });
});
