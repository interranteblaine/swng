import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { getRoundArchiveResponseSchema, parse } from "@swng/contracts";
import { fixtureLinks, reduceRound } from "@swng/domain";
import {
  addGameDirect,
  chip,
  enterScore,
  ensureCourse,
  injectAuthTokens,
  joinRoundDirect,
  loadWebEnv,
  mintAccountGolfer,
  openGamePanel,
  readJoinCode,
  setStrokesInBrowser,
  startRoundDirect,
  waitForParticipant,
} from "./support.js";
import type { AccountGolfer } from "./support.js";

// The roster-editor gate (spec 2026-07-30 §2/§8): a player's strokes are ONE integer someone typed,
// and a mis-typed one — the single most common real-world scoring mistake, per the owner's own
// field report — is fixed LIVE from the roster editor. The fix is retroactive by construction:
// dots on an ALREADY-SCORED hole and a live game's own standings both re-strike with no re-entry,
// because every downstream compute reads `state.participants[].strokes` off the freshly-folded
// log, never a cached value (packages/domain/src/round/state.ts's fold; packages/domain/src/
// scoring/allocation.ts's `roundStrokeAllocation`/`gameStrokeAllocation`).
//
// **The claim this file exists to prove, beyond retroactivity: NOBODY ELSE MOVES.** Under the
// derivation this arc deleted, correcting one seat could re-anchor the whole field and silently
// re-strike every other player's card. Test 3 pins the opposite — Rae's number changes, Gil's dots
// and his standing row are byte-identical before and after.
//
// Structure follows unratedCourse.spec.ts (serial describe, mintAccountGolfer x2, ensureCourse
// with a rated fixture card) but stays to ONE browser page: score-for-anyone (product.md §9)
// means Gil's single page can enter scores for BOTH Gil and Rae, and Rae's own join is a
// direct out-of-browser self-join (joinRoundDirect) exactly like unratedCourse's Vic — her own
// browser is never needed. The round, Rae's join and the net stroke-play game are all seeded via
// the *Direct API helpers BEFORE the browser ever opens; the ONE thing this spec drives through
// the real UI is the roster editor itself plus the ScorePad and the finalize dialog, which is what
// is actually under test.
//
// Round creation goes through the API (startRoundDirect), not CreateRoundPage — so Gil's own
// browser page has no naturally-populated scoring credential for this round the way every other
// browser-driven spec's host does. That is exactly the supported product scenario
// RoundRecordPage.tsx (the round's own permanent noun address, /rounds/:roundId, navigation spec
// §7) exists for: a signed-in golfer who already holds no local credential opens the round by
// id, the archive fetch 404s (still live), `GET /me/rounds/live` finds Gil's own presence
// (`writePresence` — packages/application/src/rounds/presence.ts — written synchronously inside
// `startRound` right after the journal append, so it is already committed by the time this
// browser ever opens, no eventual-consistency wait needed), and `openLiveRound`
// (apps/web/src/session/openLiveRound.ts) mints a device credential via `POST
// /rounds/{roundId}/token`, saves it via `credentialStore.save` — the exact shape a real
// join/CreateRoundPage would write — then client-navigates to /round/:roundId, the live scoring
// session's own address. Gil's browser therefore only needs the pre-existing account-token
// injection (`injectAuthTokens`) to authorize that re-mint; the round-scoped credential itself is
// acquired through the real re-mint path, never hand-written into storage.

const DOT = "●"; // ScorecardGrid.tsx's own dot glyph (Cell's aria-hidden "●".repeat(dots) span)

// The numbers the group agreed and typed. Gil's is set first (test 1); Rae joins on the default 0,
// is given 2 in test 2, and is bumped to 14 in test 4 — chosen so the bump is unmistakable on
// screen: 14 on a nine puts Rae two dots deep on both scored holes and FLIPS the net leader, which
// a smaller number would not (Rae's gross over holes 1-2 is 11 against Gil's 9).
const GIL_STROKES = 4;
const RAE_STROKES_CORRECTED = 2;
const RAE_STROKES_BUMPED = 14;

// fixtureLinks' one tee, "white" (packages/domain/src/scoring/golden/fixtureCourse.ts) — the
// SAME 9-hole rated card e2e/roundSlice.e2e.test.ts's own M2 deck plays. Only holes 1-2 are
// ever scored in this spec; their par/stroke-index (this table IS the gate — copied from the
// fixture file, never derived from the engine under test):
//   hole 1: par 4, SI 5
//   hole 2: par 4, SI 1
// Par over the first two holes is therefore 8 — the baseline every relativeToPar below subtracts.

test.describe.serial("a player's strokes are typed on the roster, fixed live, and moving one player never moves another", () => {
  let page: Page;
  let httpUrl: string;
  let gil: AccountGolfer;
  let rae: AccountGolfer;
  let roundId: string;
  // Held across tests so tests 3 and 4 re-read the SAME panel test 1 opened, rather than clicking
  // the chip again — StandingsHeader's chip is a plain expand/collapse TOGGLE (spec
  // 2026-07-19 §2a/§2b), so a second click would CLOSE it, not re-open it.
  let panel: Locator;

  test.beforeAll(async ({ browser }) => {
    gil = await mintAccountGolfer("strokes-gil", "Gil");
    rae = await mintAccountGolfer("strokes-rae", "Rae");
    ({ httpUrl } = loadWebEnv());
    const course = await ensureCourse(fixtureLinks.courseName, fixtureLinks, gil);

    const started = await startRoundDirect(httpUrl, gil, { course, tee: "white" });
    roundId = started.roundId;
    // Nothing is asked at join (spec §9) — both seats land on 0 strokes and stay there until
    // someone types a number onto the roster.
    await joinRoundDirect(httpUrl, rae, { code: started.joinCode, tee: "white" });
    await addGameDirect(httpUrl, started.roundId, started.token, { kind: "stroke-play", scoring: "net", players: [gil.golfer.golferId, rae.golfer.golferId] });

    const context = await browser.newContext();
    page = await context.newPage();
    await injectAuthTokens(page, gil.tokens);

    // See this file's own header comment: the round's own permanent address resolves — archive
    // 404 (still live) → GET /me/rounds/live hit (Gil's presence, already committed by
    // startRoundDirect above) → openLiveRound's re-mint → client navigation to /round/:roundId —
    // entirely through the real product path, no storage injection of the round credential.
    await page.goto(`/rounds/${started.roundId}`);
    // The landing proof: waits on the "Roster" <h2> (apps/web/src/round/SetupPanel.tsx), a
    // stable element of the resolved live SetupPanel that renders regardless of how the round
    // was entered. Not the URL (which never changes visibly here, since RoundRecordPage's
    // navigate() to /round/:roundId is a client-side route change) and not an arbitrary
    // timeout; Playwright's auto-retrying expect() carries this through the archive fetch +
    // live-rounds check + token re-mint + navigate chain above.
    await expect(page.getByRole("heading", { name: "Roster" })).toBeVisible();
    // The re-mint response now carries the code (spec 2026-07-20) — the panel renders it on
    // this entry path too, the live proof the former papercut-19 blank panel is dead.
    expect(await readJoinCode(page)).toBe(started.joinCode);
    await waitForParticipant(page, "Rae");
    await expect(chip(page, "Stroke play (net)")).toBeVisible();
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test("1: every seat starts on 0; Gil's 4 is typed onto the roster, and holes 1-2 scored through the real ScorePad draw his dots", async () => {
    // The default, on screen: joining asked nothing, so both rows read 0 strokes (spec §2).
    await expect(page.locator("li").filter({ hasText: "Gil" }).first()).toContainText("white · 0 strokes");
    await expect(page.locator("li").filter({ hasText: "Rae" }).first()).toContainText("white · 0 strokes");

    await setStrokesInBrowser(page, "Gil", GIL_STROKES);
    await expect(page.locator("li").filter({ hasText: "Gil" }).first()).toContainText(`white · ${GIL_STROKES} strokes`);

    await enterScore(page, "Gil", 1, 5);
    await enterScore(page, "Rae", 1, 6);
    await enterScore(page, "Gil", 2, 4);
    await enterScore(page, "Rae", 2, 5);

    // The STANDARD CARD's dots (spec 2026-07-19 §2a): roundStrokeAllocation(participants, card)
    // renders each player's OWN roster strokes, allocated by stroke index, no game
    // (packages/domain/src/scoring/allocation.ts -> strokes.ts's allocateStrokes).
    //
    // DERIVED BY HAND. allocateStrokes on a 9-hole tee: base = floor(strokes/9), extra =
    // strokes % 9; a hole whose strokeIndex <= extra gets base+1 dots, every other hole gets base.
    //   Gil 4:  base 0, extra 4 -> only SI<=4 holes get a dot. Hole 1 (SI 5) gets NONE; hole 2
    //     (SI 1) gets one.
    //   Rae 0:  no dot on any hole.
    // Cell text = dot-span + gross-span + (net-span iff dots !== 0), concatenated with no
    // separator (ScorecardGrid.tsx's Cell component); net = gross - dots (strokes.ts's
    // netStrokes).
    //   Gil hole 1: 0 dots -> "5"
    //   Gil hole 2: 1 dot, gross 4, net 4-1=3 -> "●43"
    //   Rae hole 1: 0 dots -> "6"
    //   Rae hole 2: 0 dots -> "5"
    await expect(page.getByRole("button", { name: "Gil hole 1", exact: true })).toHaveText("5");
    await expect(page.getByRole("button", { name: "Gil hole 2", exact: true })).toHaveText(`${DOT}43`);
    await expect(page.getByRole("button", { name: "Rae hole 1", exact: true })).toHaveText("6");
    await expect(page.getByRole("button", { name: "Rae hole 2", exact: true })).toHaveText("5");

    // A net stroke-play game is a MEDAL kind (spec 2026-07-30 §3), so it uses each player's own
    // roster number and therefore agrees with the card exactly. scoreStrokePlay's net total is a
    // running sum of (gross - dots) over scored holes (scoring/strokePlay.ts); par over the first
    // `thru` holes = par(h1)+par(h2) = 4+4 = 8; relativeToPar = netTotal - parThru.
    //   Gil: net = (5-0) + (4-1) = 5+3 = 8  -> relativeToPar = 8-8  =  0 -> vsPar "(E)"
    //   Rae: net = (6-0) + (5-0) = 6+5 = 11 -> relativeToPar = 11-8 = +3 -> vsPar "(+3)"
    // Gil leads on the net total (8 < 11) — the chip (leader-only, describeGame.ts's
    // describeStrokePlay) reads "Gil 8 thru 2 (E)"; the panel (GamePanel.tsx's StrokePlayBody)
    // lists EVERY player, one row per golfer: [name, total, thru, vsPar] cells.
    await expect(chip(page, "Stroke play (net)")).toContainText("Gil 8 thru 2 (E)");

    panel = await openGamePanel(page, "Stroke play (net)");
    const gilRow = panel.getByRole("row").filter({ hasText: "Gil" });
    const raeRow = panel.getByRole("row").filter({ hasText: "Rae" });
    await expect(gilRow.getByRole("cell")).toHaveText(["Gil", "8", "2", "(E)"]);
    await expect(raeRow.getByRole("cell")).toHaveText(["Rae", "11", "2", "(+3)"]);
  });

  test("2: the fix, through the real roster editor — Edit on Rae's row, the teaching line, 0 replaced with 2, Save", async () => {
    const rosterRow = page.locator("li").filter({ hasText: "Rae" }).first();
    // SetupPanel.tsx's two-line row (spec §8): the name and one Edit above, `tee · N strokes`
    // below. Nothing else — no stated number, no derivation, no second control.
    await expect(rosterRow).toContainText("white · 0 strokes");
    await expect(rosterRow.getByRole("button", { name: "Give strokes directly" })).toHaveCount(0);
    await rosterRow.getByRole("button", { name: "Edit" }).click();

    // While editing, the static facts line is REPLACED by the editor (not shown alongside it) —
    // the input's aria-label names the SUBJECT, and its starting value is that seat's current
    // number.
    const input = page.getByRole("spinbutton", { name: "Strokes for Rae" });
    await expect(input).toHaveValue("0");
    await expect(page.getByText("Strokes apply to the whole round — dots and games update everywhere.")).toBeVisible();

    await input.fill(String(RAE_STROKES_CORRECTED));
    await rosterRow.getByRole("button", { name: "Save" }).click();

    // save() awaits onSetStrokes (api.setStrokes's POST, then session.sync()) before closing the
    // editor on success (SetupPanel.tsx) — the static line reappearing, and the Save/Cancel pair
    // disappearing, both only happen once the change has already folded.
    await expect(rosterRow).toContainText(`white · ${RAE_STROKES_CORRECTED} strokes`);
    await expect(rosterRow.getByRole("button", { name: "Save" })).toHaveCount(0);
  });

  test("3: retroactivity, live, with NO re-entry — Rae's already-scored hole gains a dot, and GIL IS UNTOUCHED", async () => {
    // Grid dots recomputed off the freshly-folded roster — roundStrokeAllocation reads
    // state.participants live, nothing is cached at score-record time
    // (packages/domain/src/scoring/allocation.ts's own doc comment).
    //
    // DERIVED BY HAND. allocateStrokes(2, 9 holes): base 0, extra 2 -> only SI<=2 holes get a dot.
    //   Rae hole 1 (SI 5, NOT <= 2): still 0 dots -> "6"
    //   Rae hole 2 (SI 1, <= 2): now 1 dot -> gross 5, net 5-1=4 -> "●54"
    await expect(page.getByRole("button", { name: "Rae hole 1", exact: true })).toHaveText("6");
    await expect(page.getByRole("button", { name: "Rae hole 2", exact: true })).toHaveText(`${DOT}54`);

    // THE LOAD-BEARING ASSERTION OF THIS ARC (spec §2): Gil's cells are byte-identical to test 1's.
    // Under the derivation this arc deleted, Rae's number entering the field could re-anchor it and
    // strip Gil's SI-1 dot — a player who touched nothing having his card silently re-struck.
    await expect(page.getByRole("button", { name: "Gil hole 1", exact: true })).toHaveText("5");
    await expect(page.getByRole("button", { name: "Gil hole 2", exact: true })).toHaveText(`${DOT}43`);

    // The net game re-resolves off the same roster:
    //   Rae: net = (6-0) + (5-1) = 10 -> relativeToPar = 10-8 = +2 -> vsPar "(+2)"
    //   Gil: net = 8 (UNCHANGED)      -> relativeToPar = 0      -> vsPar "(E)"
    // Read on the same panel `panel` test 1 opened (re-queried, not re-opened: a second chip tap
    // would CLOSE it). StrokePlayBody sorts by vs-par ascending, so Gil still renders first here;
    // the rows are located by name, so the order is not what is being asserted.
    const gilRow = panel.getByRole("row").filter({ hasText: "Gil" });
    const raeRow = panel.getByRole("row").filter({ hasText: "Rae" });
    await expect(gilRow.getByRole("cell")).toHaveText(["Gil", "8", "2", "(E)"]);
    await expect(raeRow.getByRole("cell")).toHaveText(["Rae", "10", "2", "(+2)"]);
    await expect(chip(page, "Stroke play (net)")).toContainText("Gil 8 thru 2 (E)");
  });

  test("4: a bigger number on the same row — 14 lands verbatim on a nine-hole card and flips the leader", async () => {
    await setStrokesInBrowser(page, "Rae", RAE_STROKES_BUMPED);
    await expect(page.locator("li").filter({ hasText: "Rae" }).first()).toContainText(`white · ${RAE_STROKES_BUMPED} strokes`);

    // DERIVED BY HAND: the number is taken verbatim — there is no halving rule for a nine any
    // more (spec §9), so 14 is 14. allocateStrokes(14, 9 holes): base = floor(14/9) = 1,
    // extra = 14 % 9 = 5 -> SI<=5 holes get 2 dots, the rest get 1.
    //   Rae hole 1 (SI 5, <= 5): 2 dots -> gross 6, net 6-2=4 -> "●●64"
    //   Rae hole 2 (SI 1, <= 5): 2 dots -> gross 5, net 5-2=3 -> "●●53"
    //   Gil: still 4 strokes, untouched again -> "5" and "●43"
    await expect(page.getByRole("button", { name: "Rae hole 1", exact: true })).toHaveText(`${DOT}${DOT}64`);
    await expect(page.getByRole("button", { name: "Rae hole 2", exact: true })).toHaveText(`${DOT}${DOT}53`);
    await expect(page.getByRole("button", { name: "Gil hole 1", exact: true })).toHaveText("5");
    await expect(page.getByRole("button", { name: "Gil hole 2", exact: true })).toHaveText(`${DOT}43`);

    // And the net game moves with it, flipping the LEADER — the strongest available proof the
    // typed number really reached the engines and not just the roster row:
    //   Rae: net = (6-2) + (5-2) = 4+3 = 7 -> relativeToPar = 7-8 = -1 -> vsPar "(-1)"
    //   Gil: net = 8 (unchanged)            -> relativeToPar = 0     -> vsPar "(E)"
    const gilRow = panel.getByRole("row").filter({ hasText: "Gil" });
    const raeRow = panel.getByRole("row").filter({ hasText: "Rae" });
    await expect(raeRow.getByRole("cell")).toHaveText(["Rae", "7", "2", "(-1)"]);
    await expect(gilRow.getByRole("cell")).toHaveText(["Gil", "8", "2", "(E)"]);
    await expect(chip(page, "Stroke play (net)")).toContainText("Rae 7 thru 2 (-1)");
  });

  test("5: finalize through the real dialog; the archived card still shows Rae's 14, and getRoundArchive (API) folds to strokes 14 / 4", async () => {
    test.setTimeout(60_000);

    // Neither Gil nor Rae has scored past hole 2 of 9 — the net stroke-play game is genuinely
    // unresolved (packages/domain/src/scoring/result.ts: stroke-play only resolves once
    // `complete`), so the REAL dialog takes its "some games aren't finished" branch, exactly
    // like fieldTest.spec.ts's own M7 termination-coverage test.
    await page.getByRole("button", { name: "Finalize round" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm finalize" });
    await expect(dialog).toContainText("Some games aren't finished:");
    // describeMissing (finalizeReadiness.ts) groups both players under ONE clause since their
    // missing-hole sets are identical: holes 3-9 (thru=2 of 9), formatted as a single range.
    await expect(dialog).toContainText("Stroke play (net) — holes 3–9 unscored for Gil, Rae");
    await dialog.getByRole("button", { name: /^end unfinished games & finalize$/i }).click();

    await expect(page.getByRole("heading", { name: "Final results" })).toBeVisible();

    // The archived card is the SAME ScorecardGrid component, readOnly, rendered from THIS tab's
    // own live fold (RoundPage.tsx: ResultsView gets `session.state` directly, no archive fetch
    // needed for a tab that just finalized itself) — which already carries both
    // participant-strokes-set events synced in tests 2 and 4. Same hand-derived strings as test 4.
    const raeHole1 = page.getByRole("button", { name: "Rae hole 1", exact: true });
    await expect(raeHole1).toHaveText(`${DOT}${DOT}64`);
    await expect(raeHole1).toBeDisabled(); // archived: entry locked, no pad ever opens
    await expect(page.getByRole("button", { name: "Rae hole 2", exact: true })).toHaveText(`${DOT}${DOT}53`);

    // The wire cross-check: a FRESH fetch of GET /rounds/{roundId}/archive (not this tab's own
    // cached session fold) — "golfer"-gated (routes.ts: authorizes by the caller's ACCOUNT, not
    // the round-scoped participant token), so this uses gil.tokens.idToken, never `started.token`.
    // Folding the returned event log through the SAME domain reduceRound the server itself uses
    // for settlement must show Rae's LAST number (14), never the intermediate 2 or the join-time
    // 0: settleRound reads state.participants straight off the ordinary event fold, no
    // special-case archive logic (packages/domain/src/round/archive.ts).
    const archiveResponse = await fetch(`${httpUrl}/rounds/${roundId}/archive`, { headers: { authorization: `Bearer ${gil.tokens.idToken}` } });
    const archiveJson: unknown = await archiveResponse.json();
    if (!archiveResponse.ok) throw new Error(`GET /rounds/${roundId}/archive -> ${archiveResponse.status}: ${JSON.stringify(archiveJson)}`);
    const { events } = parse(getRoundArchiveResponseSchema, archiveJson);
    const archivedState = reduceRound(events);
    const raeArchived = archivedState.participants.find((p) => p.golferId === rae.golfer.golferId);
    const gilArchived = archivedState.participants.find((p) => p.golferId === gil.golfer.golferId);
    expect(raeArchived?.strokes).toBe(RAE_STROKES_BUMPED);
    expect(raeArchived?.name).toBe("Rae"); // a strokes-set carries ONLY the number — name/tee are untouched
    expect(raeArchived?.tee).toBe("white");
    // Gil's own seat, sealed at the number HE was given and never at anything Rae's changes
    // implied — the arc's own claim, one last time, on the permanent record.
    expect(gilArchived?.strokes).toBe(GIL_STROKES);
  });

  // Teardown: the round is finalized (nothing to scrap); Gil/Rae's throwaway Cognito users were
  // tracked at mint time (mintAccountGolfer -> support.ts's trackMintedUser) and are deleted by
  // the standard ndjson-driven globalTeardown, same as every other spec in this suite.
});
