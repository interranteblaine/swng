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
  startRoundDirect,
  waitForParticipant,
} from "./support.js";
import type { AccountGolfer } from "./support.js";

// The mid-round handicap correction gate (spec 2026-07-20; task-6-brief.md): a wrong course
// handicap entered at join — the single most common real-world scoring mistake, per the
// owner's own field report — is corrected LIVE from the roster editor, and the correction is
// retroactive by construction: dots on an ALREADY-SCORED hole and a live game's own standings
// both re-strike with no re-entry, because every downstream compute reads
// `state.participants[].courseHandicap` off the freshly-folded log, never a cached value
// (packages/domain/src/round/state.ts's own fold; packages/domain/src/scoring/allocation.ts's
// `courseHandicapAllocation`/`gameStrokeAllocation`).
//
// Structure follows unratedCourse.spec.ts (serial describe, mintAccountGolfer x2, ensureCourse
// with a rated fixture card) but stays to ONE browser page: score-for-anyone (product.md §9)
// means Gil's single page can enter scores for BOTH Gil and Rae, and Rae's own join is a
// direct out-of-browser self-join (joinRoundDirect) exactly like unratedCourse's Vic — her own
// browser is never needed. The round, Rae's deliberately WRONG join (CH 2), and the net
// stroke-play game are all seeded via the *Direct API helpers BEFORE the browser ever opens
// (brief: "startRoundDirect/joinRoundDirect for setup speed... addGameDirect... the game under
// test needs net standings, not picker coverage") — the ONE thing this spec drives through the
// real UI is the roster editor itself (the correction) plus the ScorePad and the finalize
// dialog, which is what's actually under test.
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

const GIL_CH = 9;
const RAE_CH_WRONG = 2;
const RAE_CH_CORRECTED = 13;

// fixtureLinks' one tee, "white" (packages/domain/src/scoring/golden/fixtureCourse.ts) — the
// SAME 9-hole rated card e2e/roundSlice.e2e.test.ts's own M2 deck plays. Only holes 1-2 are
// ever scored in this spec; their par/stroke-index (this table IS the gate — copied from the
// fixture file, never derived from the engine under test):
//   hole 1: par 4, SI 5
//   hole 2: par 4, SI 1

test.describe.serial("mid-round handicap correction — a wrong course handicap entered at join is fixed live from the roster, retroactively", () => {
  let page: Page;
  let httpUrl: string;
  let gil: AccountGolfer;
  let rae: AccountGolfer;
  let roundId: string;
  // Held across tests so test 3 re-reads the SAME panel test 1 opened, rather than clicking the
  // chip a second time — StandingsHeader's chip is a plain expand/collapse TOGGLE (spec
  // 2026-07-19 §2a/§2b), so a second click would CLOSE it, not re-open it.
  let panel: Locator;

  test.beforeAll(async ({ browser }) => {
    gil = await mintAccountGolfer("handicap-gil", "Gil");
    rae = await mintAccountGolfer("handicap-rae", "Rae");
    ({ httpUrl } = loadWebEnv());
    const course = await ensureCourse(fixtureLinks.courseName, fixtureLinks, gil);

    const started = await startRoundDirect(httpUrl, gil, { course, tee: "white", courseHandicap: GIL_CH });
    roundId = started.roundId;
    // Rae's deliberately WRONG course handicap at join — the field mistake this whole arc fixes.
    await joinRoundDirect(httpUrl, rae, { code: started.joinCode, tee: "white", courseHandicap: RAE_CH_WRONG });
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

  test("1: holes 1-2 scored for both through the real ScorePad — Rae's wrong CH 2 draws no dot at all on hole 1, and the net panel trails her behind Gil", async () => {
    await enterScore(page, "Gil", 1, 5);
    await enterScore(page, "Rae", 1, 6);
    await enterScore(page, "Gil", 2, 4);
    await enterScore(page, "Rae", 2, 5);

    // The STANDARD CARD's dots (spec 2026-07-19 §2a): courseHandicapAllocation(participants,
    // card) — EACH PLAYER'S OWN raw course handicap, allocated by stroke index, no allowance
    // (packages/domain/src/scoring/allocation.ts -> strokes.ts's allocateStrokes). For a 9-hole
    // tee: base = floor(|CH|/9), extra = |CH|%9; a hole whose strokeIndex <= extra gets base+1
    // dots, every other hole gets base.
    //   Gil CH 9: base = floor(9/9) = 1, extra = 9%9 = 0 -> NO strokeIndex is <= 0, so EVERY
    //     hole gets exactly base = 1 dot, including hole 1 (SI 5) and hole 2 (SI 1).
    //   Rae CH 2 (wrong): base = floor(2/9) = 0, extra = 2 -> only SI<=2 holes get 1 dot: hole
    //     2 (SI 1) and hole 7 (SI 2, unscored here). Hole 1 (SI 5) gets 0 dots.
    // Cell text = dot-span + gross-span + (net-span iff dots !== 0), concatenated with no
    // separator (ScorecardGrid.tsx's Cell component); net = gross - dots (strokes.ts's
    // netStrokes).
    //   Gil hole 1: 1 dot, gross 5, net 5-1=4 -> "●54"
    //   Gil hole 2: 1 dot, gross 4, net 4-1=3 -> "●43"
    //   Rae hole 1: 0 dots (no dot span, no net span) -> "6"
    //   Rae hole 2: 1 dot, gross 5, net 5-1=4 -> "●54"
    await expect(page.getByRole("button", { name: "Gil hole 1", exact: true })).toHaveText(`${DOT}54`);
    await expect(page.getByRole("button", { name: "Gil hole 2", exact: true })).toHaveText(`${DOT}43`);
    await expect(page.getByRole("button", { name: "Rae hole 1", exact: true })).toHaveText("6");
    await expect(page.getByRole("button", { name: "Rae hole 2", exact: true })).toHaveText(`${DOT}54`);

    // The net stroke-play GAME's own strokes are RELATIVE to a 95% PLAYING handicap
    // (defaultAllowance("stroke-play") = 0.95; scoring/allowances.ts's playingHandicap =
    // roundHalfUp(courseHandicap * allowance), roundHalfUp = floor(value + 0.5)) — a DIFFERENT
    // number from the grid's raw CH above, that happens to allocate identically on holes 1-2
    // here:
    //   Gil: playingHandicap(9, 0.95) = floor(8.55+0.5) = floor(9.05) = 9 -> base 1, extra 0 ->
    //     same 1-dot-every-hole allocation as the grid.
    //   Rae (wrong CH 2): playingHandicap(2, 0.95) = floor(1.9+0.5) = floor(2.4) = 2 -> base 0,
    //     extra 2 -> same allocation as the grid (0 dots hole 1, 1 dot hole 2).
    // scoreStrokePlay's net total is a running sum of (gross - dots) over scored holes
    // (scoring/strokePlay.ts); par over the first `thru` holes = par(h1)+par(h2) = 4+4 = 8;
    // relativeToPar = netTotal - parThru.
    //   Gil: net = (5-1) + (4-1) = 4+3 = 7 -> relativeToPar = 7-8 = -1 -> vsPar "(-1)"
    //   Rae: net = (6-0) + (5-1) = 6+4 = 10 -> relativeToPar = 10-8 = +2 -> vsPar "(+2)"
    // Gil leads (7 < 10) — the chip (leader-only, describeGame.ts's describeStrokePlay) reads
    // "Gil 7 thru 2 (-1)"; the panel (GamePanel.tsx's StrokePlayBody) lists EVERY player, one
    // row per golfer: [name, total, thru, vsPar] cells, sorted by vsPar ascending.
    await expect(chip(page, "Stroke play (net)")).toContainText("Gil 7 thru 2 (-1)");

    panel = await openGamePanel(page, "Stroke play (net)");
    const gilRow = panel.getByRole("row").filter({ hasText: "Gil" });
    const raeRow = panel.getByRole("row").filter({ hasText: "Rae" });
    await expect(gilRow.getByRole("cell")).toHaveText(["Gil", "7", "2", "(-1)"]);
    await expect(raeRow.getByRole("cell")).toHaveText(["Rae", "10", "2", "(+2)"]);
  });

  test("2: the correction, through the real roster editor — Edit on Rae's row, the teaching line, 2 replaced with 13, Save", async () => {
    const rosterRow = page.locator("li").filter({ hasText: "Rae" });
    await expect(rosterRow).toContainText("CH 2"); // formatCourseHandicap(2) === "2" — no plus sign, not a plus handicap
    await rosterRow.getByRole("button", { name: "Edit" }).click();

    // SetupPanel.tsx: while editing, the static "CH ..." span is REPLACED by the editor (not
    // shown alongside it) — the input's own aria-label names the SUBJECT, and its starting
    // value is the participant's current (wrong) courseHandicap as a raw signed-integer string.
    const input = page.getByRole("spinbutton", { name: "Course handicap for Rae" });
    await expect(input).toHaveValue(String(RAE_CH_WRONG));
    await expect(page.getByText("Strokes apply to the whole round — dots and games update everywhere.")).toBeVisible();

    await input.fill(String(RAE_CH_CORRECTED));
    await rosterRow.getByRole("button", { name: "Save" }).click();

    // save() awaits onSetHandicap (api.setHandicap's POST, then session.sync()) before closing
    // the editor on success (SetupPanel.tsx) — the static "CH 13" span reappearing, and the
    // Save/Cancel pair disappearing, both only happen once the correction has already folded.
    await expect(rosterRow).toContainText(`CH ${RAE_CH_CORRECTED}`);
    await expect(rosterRow.getByRole("button", { name: "Save" })).toHaveCount(0);
  });

  test("3: retroactivity, live, with NO re-entry — Rae's ALREADY-SCORED holes gain a dot, and the net panel standing moves", async () => {
    // Grid dots recomputed off Rae's CORRECTED raw CH 13 — courseHandicapAllocation reads
    // state.participants live off the freshly-folded log, nothing is cached at score-record
    // time (packages/domain/src/scoring/allocation.ts's own doc comment). base = floor(13/9) =
    // 1, extra = 13%9 = 4 -> holes with SI<=4 get base+1=2, every other hole gets base=1.
    //   hole 1 (SI 5, NOT <= 4): stays at base = 1 dot -> gross 6, net 6-1=5 -> "●65"
    //   hole 2 (SI 1, <= 4): now base+1 = 2 dots -> gross 5, net 5-2=3 -> "●●53"
    // Gil's own dots are untouched — his CH never changed, and a correction to Rae touches
    // ONLY Rae's seat (packages/domain/src/round/state.ts's fold: the handicap-set map is
    // keyed per golferId).
    await expect(page.getByRole("button", { name: "Rae hole 1", exact: true })).toHaveText(`${DOT}65`);
    await expect(page.getByRole("button", { name: "Rae hole 2", exact: true })).toHaveText(`${DOT}${DOT}53`);
    await expect(page.getByRole("button", { name: "Gil hole 1", exact: true })).toHaveText(`${DOT}54`);
    await expect(page.getByRole("button", { name: "Gil hole 2", exact: true })).toHaveText(`${DOT}43`);

    // The net GAME's own playingHandicap moves too: playingHandicap(13, 0.95) =
    // floor(12.35+0.5) = floor(12.85) = 12 -> base = floor(12/9) = 1, extra = 12%9 = 3 ->
    // SI<=3 gets 2, else 1. hole 1 (SI 5, > 3): stays 1 dot -> net 6-1=5. hole 2 (SI 1, <= 3):
    // now 2 dots -> net 5-2=3 (the SAME per-hole dots as the grid above, on these two holes,
    // even though the underlying total differs — 12 vs 13 — because both allocations agree on
    // which of SI-1/SI-5 clear their own extra-strokes threshold).
    //   Rae: net = (6-1) + (5-2) = 5+3 = 8 -> relativeToPar = 8-8 = 0 -> vsPar "(E)"
    // Gil's own line is completely untouched: net 7, vsPar "(-1)" — the same panel `panel`
    // test 1 opened (re-queried, not re-opened: a second chip tap would CLOSE it).
    const gilRow = panel.getByRole("row").filter({ hasText: "Gil" });
    const raeRow = panel.getByRole("row").filter({ hasText: "Rae" });
    await expect(gilRow.getByRole("cell")).toHaveText(["Gil", "7", "2", "(-1)"]);
    await expect(raeRow.getByRole("cell")).toHaveText(["Rae", "8", "2", "(E)"]);
    // Gil still leads (7 < 8) — the chip's own leader-only line is unchanged, a control showing
    // exactly what moved (Rae's full-panel row) versus what didn't (the leader).
    await expect(chip(page, "Stroke play (net)")).toContainText("Gil 7 thru 2 (-1)");
  });

  test("4: finalize through the real dialog; the archived card still shows Rae's corrected dots, and getRoundArchive (API) carries courseHandicap 13", async () => {
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
    // needed for a tab that just finalized itself) — which already carries the
    // participant-handicap-set correction synced in test 2. Same hand-derived strings as test 3.
    const raeHole1 = page.getByRole("button", { name: "Rae hole 1", exact: true });
    await expect(raeHole1).toHaveText(`${DOT}65`);
    await expect(raeHole1).toBeDisabled(); // archived: entry locked, no pad ever opens
    await expect(page.getByRole("button", { name: "Rae hole 2", exact: true })).toHaveText(`${DOT}${DOT}53`);

    // The wire cross-check the brief names explicitly: a FRESH fetch of GET
    // /rounds/{roundId}/archive (not this tab's own cached session fold) — "golfer"-gated
    // (routes.ts: authorizes by the caller's ACCOUNT, not the round-scoped participant token),
    // so this uses gil.tokens.idToken, never `started.token`. Folding the returned event log
    // through the SAME domain reduceRound the server itself uses for settlement must show Rae's
    // courseHandicap as the corrected 13, never the join-time 2 — settleRound reads
    // state.participants straight off the ordinary event fold, no special-case archive logic
    // (packages/domain/src/round/archive.ts).
    const archiveResponse = await fetch(`${httpUrl}/rounds/${roundId}/archive`, { headers: { authorization: `Bearer ${gil.tokens.idToken}` } });
    const archiveJson: unknown = await archiveResponse.json();
    if (!archiveResponse.ok) throw new Error(`GET /rounds/${roundId}/archive -> ${archiveResponse.status}: ${JSON.stringify(archiveJson)}`);
    const { events } = parse(getRoundArchiveResponseSchema, archiveJson);
    const archivedState = reduceRound(events);
    const raeArchived = archivedState.participants.find((p) => p.golferId === rae.golfer.golferId);
    expect(raeArchived?.courseHandicap).toBe(RAE_CH_CORRECTED);
    expect(raeArchived?.name).toBe("Rae"); // the correction carries ONLY the number — name/tee are untouched
    expect(raeArchived?.tee).toBe("white");
  });

  // Teardown: the round is finalized (nothing to scrap); Gil/Rae's throwaway Cognito users were
  // tracked at mint time (mintAccountGolfer -> support.ts's trackMintedUser) and are deleted by
  // the standard ndjson-driven globalTeardown, same as every other spec in this suite.
});
