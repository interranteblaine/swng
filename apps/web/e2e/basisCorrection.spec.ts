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

// The mid-round BASIS correction gate (spec 2026-07-20, re-aimed by spec 2026-07-29): a wrong
// number stated at join — the single most common real-world scoring mistake, per the owner's own
// field report — is corrected LIVE from the roster editor, and the correction is retroactive by
// construction: dots on an ALREADY-SCORED hole and a live game's own standings both re-strike
// with no re-entry, because every downstream compute reads `state.participants[].strokes` off the
// freshly-folded log, never a cached value (packages/domain/src/round/state.ts's own fold, which
// re-resolves the WHOLE field's strokes on every reduce; packages/domain/src/scoring/
// allocation.ts's `roundStrokeAllocation`/`gameStrokeAllocation`).
//
// **What changed, and why this file is now a better gate than it was.** A seat no longer states
// the strokes it receives; it states what the golfer normally shoots relative to par, and strokes
// are DERIVED as the difference from the lowest in the field (spec §2b). So correcting ONE seat can
// move EVERY seat — if the corrected number becomes (or stops being) the field's anchor, everyone's
// dots move. This spec drives exactly that: Rae joins wrong at +2, which makes HER the anchor and
// puts Gil on 4 strokes; correcting her to +13 hands the anchor to Gil and leaves HIM on 0. The old
// version of test 3 asserted Gil's line as an untouched "control"; that control is now provably
// false, and asserting the re-anchor is the honest replacement.
//
// It also covers BOTH of StrokeBasis's constructors live (spec §2a): test 2/3 correct the
// `normally-shoots` assertion, and test 4 uses the roster's own "Give strokes directly" affordance
// to switch Rae to `{kind:"strokes"}` — a statement about THIS round that never enters the anchor
// and is never halved.
//
// Structure follows unratedCourse.spec.ts (serial describe, mintAccountGolfer x2, ensureCourse
// with a rated fixture card) but stays to ONE browser page: score-for-anyone (product.md §9)
// means Gil's single page can enter scores for BOTH Gil and Rae, and Rae's own join is a
// direct out-of-browser self-join (joinRoundDirect) exactly like unratedCourse's Vic — her own
// browser is never needed. The round, Rae's deliberately WRONG join (+2), and the net
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

// What each player STATES (spec §2a's first constructor) — a normal score relative to par, never
// the strokes they receive. Named for what they are: the old GIL_CH/RAE_CH names invited exactly
// the mistake the derivations below had to be corrected for.
const GIL_OVER_PAR = 9;
const RAE_OVER_PAR_WRONG = 2;
const RAE_OVER_PAR_CORRECTED = 13;
// The second constructor (spec §2a): "just give her 14." Chosen so the correction is unmistakable
// on screen — 14 on a nine puts Rae 2 dots deep on the two scored holes and FLIPS the net leader,
// which a smaller number would not (Rae's gross over holes 1-2 is 11 against Gil's 9, so she needs
// more than 2 dots there to lead). A literal strokes assertion is never halved for a nine.
const RAE_STROKES_DIRECT = 14;

// fixtureLinks' one tee, "white" (packages/domain/src/scoring/golden/fixtureCourse.ts) — the
// SAME 9-hole rated card e2e/roundSlice.e2e.test.ts's own M2 deck plays. Only holes 1-2 are
// ever scored in this spec; their par/stroke-index (this table IS the gate — copied from the
// fixture file, never derived from the engine under test):
//   hole 1: par 4, SI 5
//   hole 2: par 4, SI 1
// Par over the first two holes is therefore 8 — the baseline every relativeToPar below subtracts.

test.describe.serial("mid-round basis correction — a wrong stated number is fixed live from the roster, retroactively, and re-anchors the field", () => {
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
    gil = await mintAccountGolfer("basis-gil", "Gil");
    rae = await mintAccountGolfer("basis-rae", "Rae");
    ({ httpUrl } = loadWebEnv());
    const course = await ensureCourse(fixtureLinks.courseName, fixtureLinks, gil);

    const started = await startRoundDirect(httpUrl, gil, { course, tee: "white", basis: { kind: "normally-shoots", overPar: GIL_OVER_PAR } });
    roundId = started.roundId;
    // Rae's deliberately WRONG number at join — the field mistake this whole arc fixes. +2 also
    // makes her the FIELD'S ANCHOR, which is what gives test 3 a re-anchor to prove.
    await joinRoundDirect(httpUrl, rae, { code: started.joinCode, tee: "white", basis: { kind: "normally-shoots", overPar: RAE_OVER_PAR_WRONG } });
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

  test("1: holes 1-2 scored for both through the real ScorePad — Rae's wrong +2 makes HER the anchor, so she draws no dot at all and Gil gets 4 strokes", async () => {
    await enterScore(page, "Gil", 1, 5);
    await enterScore(page, "Rae", 1, 6);
    await enterScore(page, "Gil", 2, 4);
    await enterScore(page, "Rae", 2, 5);

    // The STANDARD CARD's dots (spec 2026-07-19 §2a): roundStrokeAllocation(participants, card)
    // renders each player's DERIVED round strokes, allocated by stroke index, no game
    // (packages/domain/src/scoring/allocation.ts -> strokes.ts's allocateStrokes).
    //
    // DERIVED BY HAND (spec 2026-07-29 §2b — strokes are the difference from the lowest in the
    // field, halved once on a nine):
    //   anchor = min(stated normal scores) = min(9, 2) = 2  <- Rae's WRONG number is the anchor
    //   Gil: 9 − 2 = 7 → nine holes → roundHalfUp(7/2) = roundHalfUp(3.5) = 4 strokes
    //   Rae: 2 − 2 = 0 → roundHalfUp(0/2) = 0 strokes
    // allocateStrokes on a 9-hole tee: base = floor(strokes/9), extra = strokes % 9; a hole whose
    // strokeIndex <= extra gets base+1 dots, every other hole gets base.
    //   Gil 4:  base 0, extra 4 -> only SI<=4 holes get a dot. Hole 1 (SI 5) gets NONE; hole 2
    //     (SI 1) gets one.
    //   Rae 0:  no dot on any hole — the anchor receives nothing.
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

    // The net stroke-play GAME applies the SAME one rule over its OWN field (spec §2b/§3) — no
    // allowance percentage exists anymore. This game's field is the whole two-player roster, so it
    // resolves the identical 4/0 the card just showed; a subset game is where the two diverge.
    // scoreStrokePlay's net total is a running sum of (gross - dots) over scored holes
    // (scoring/strokePlay.ts); par over the first `thru` holes = par(h1)+par(h2) = 4+4 = 8;
    // relativeToPar = netTotal - parThru.
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

  test("2: the correction, through the real roster editor — Edit on Rae's row, the teaching line, 2 replaced with 13, Save", async () => {
    const rosterRow = page.locator("li").filter({ hasText: "Rae" });
    // SetupPanel.tsx renders what a seat STATED and then what the field's rule turned it into:
    // " — normally {formatOverPar(overPar)} · gets {strokes}". formatOverPar(2) === "+2" (positive
    // is over par, spec §4), and Rae's derived strokes are 0 because she is the anchor — so the
    // row states the wrong claim AND its consequence, which is exactly what makes the mistake
    // visible on screen.
    await expect(rosterRow).toContainText("normally +2 · gets 0");
    await rosterRow.getByRole("button", { name: "Edit" }).click();

    // SetupPanel.tsx: while editing, the static " — normally … · gets …" span is REPLACED by the
    // editor (not shown alongside it) — the input's own aria-label names both the SUBJECT and
    // WHICH constructor is being written, and its starting value is the participant's current
    // (wrong) stated number as a raw signed-integer string.
    const input = page.getByRole("spinbutton", { name: "What Rae normally shoots, relative to par" });
    await expect(input).toHaveValue(String(RAE_OVER_PAR_WRONG));
    await expect(page.getByText("Strokes come from the difference across the group — dots and games update everywhere.")).toBeVisible();

    await input.fill(String(RAE_OVER_PAR_CORRECTED));
    await rosterRow.getByRole("button", { name: "Save" }).click();

    // save() awaits onSetBasis (api.setBasis's POST, then session.sync()) before closing the
    // editor on success (SetupPanel.tsx) — the static span reappearing, and the Save/Cancel pair
    // disappearing, both only happen once the correction has already folded. The row now states
    // "normally +13 · gets 2": the correction hands the anchor to Gil (9), so Rae's own strokes
    // become roundHalfUp((13 − 9)/2) = 2 — the assertion covers the STATED number and the
    // DERIVED one together, which is the whole point of the two-part row.
    await expect(rosterRow).toContainText(`normally +${RAE_OVER_PAR_CORRECTED} · gets 2`);
    await expect(rosterRow.getByRole("button", { name: "Save" })).toHaveCount(0);
  });

  test("3: retroactivity, live, with NO re-entry — the correction RE-ANCHORS the field: Rae's already-scored hole gains a dot and Gil's loses one", async () => {
    // Grid dots recomputed off the CORRECTED field — roundStrokeAllocation reads
    // state.participants live off the freshly-folded log, nothing is cached at score-record
    // time (packages/domain/src/scoring/allocation.ts's own doc comment), and reduceRound
    // re-resolves EVERY seat's strokes on every reduce (round/state.ts).
    //
    // DERIVED BY HAND, the whole field (spec §2b):
    //   anchor = min(9, 13) = 9  <- the anchor MOVED to Gil
    //   Gil: 9 − 9 = 0 → 0 strokes (down from 4)
    //   Rae: 13 − 9 = 4 → nine holes → roundHalfUp(4/2) = 2 strokes (up from 0)
    // allocateStrokes(2, 9 holes): base 0, extra 2 -> only SI<=2 holes get a dot.
    //   Rae hole 1 (SI 5, NOT <= 2): still 0 dots -> "6"
    //   Rae hole 2 (SI 1, <= 2): now 1 dot -> gross 5, net 5-1=4 -> "●54"
    //   Gil hole 1: 0 dots either way -> "5"
    //   Gil hole 2 (SI 1): LOSES its dot (he is the anchor now) -> "4"
    // This is the load-bearing behaviour change from the pre-2026-07-29 model, where a correction
    // to Rae could only ever touch Rae's own seat: strokes are relative, so one seat's correction
    // can move the whole card. Gil's gross is of course untouched — only what he RECEIVES moved.
    await expect(page.getByRole("button", { name: "Rae hole 1", exact: true })).toHaveText("6");
    await expect(page.getByRole("button", { name: "Rae hole 2", exact: true })).toHaveText(`${DOT}54`);
    await expect(page.getByRole("button", { name: "Gil hole 1", exact: true })).toHaveText("5");
    await expect(page.getByRole("button", { name: "Gil hole 2", exact: true })).toHaveText("4");

    // The net GAME re-resolves off the same corrected field (its field IS this roster):
    //   Gil: net = (5-0) + (4-0) = 9  -> relativeToPar = 9-8  = +1 -> vsPar "(+1)"
    //   Rae: net = (6-0) + (5-1) = 10 -> relativeToPar = 10-8 = +2 -> vsPar "(+2)"
    // BOTH rows move — Gil's from 8/(E) to 9/(+1), Rae's from 11/(+3) to 10/(+2). Read on the
    // same panel `panel` test 1 opened (re-queried, not re-opened: a second chip tap would CLOSE
    // it). StrokePlayBody sorts by vs-par ascending, so Gil still renders first here; the rows are
    // located by name, so the order is not what is being asserted.
    const gilRow = panel.getByRole("row").filter({ hasText: "Gil" });
    const raeRow = panel.getByRole("row").filter({ hasText: "Rae" });
    await expect(gilRow.getByRole("cell")).toHaveText(["Gil", "9", "2", "(+1)"]);
    await expect(raeRow.getByRole("cell")).toHaveText(["Rae", "10", "2", "(+2)"]);
    // Gil still leads on the net total (9 < 10), but at a DIFFERENT number than before — the chip
    // moving is the correction's own visible proof, which is what the brief asks this test to pin.
    await expect(chip(page, "Stroke play (net)")).toContainText("Gil 9 thru 2 (+1)");
  });

  test("4: the OTHER constructor, live — 'Give strokes directly' on Rae's row writes {kind:'strokes'}: 14 dots, never halved, never in the anchor", async () => {
    // "Just give her 14" is a DIFFERENT KIND of statement, not a fudge of the first (spec §2a), so
    // SetupPanel offers it as its own affordance rather than a mode on one field — this beat is the
    // live coverage of that second constructor, end to end through the real roster editor.
    const rosterRow = page.locator("li").filter({ hasText: "Rae" });
    await rosterRow.getByRole("button", { name: "Give strokes directly" }).click();

    // The editor's aria-label names the constructor being written ("Strokes for Rae", not "What Rae
    // normally shoots…"), and startEdit seeds it BLANK: Rae currently states a normal score, and
    // there is nothing honest to convert between the two kinds (SetupPanel.tsx's own comment).
    const input = page.getByRole("spinbutton", { name: "Strokes for Rae" });
    await expect(input).toHaveValue("");
    await expect(page.getByText("Strokes given directly, for the whole round — dots and games update everywhere.")).toBeVisible();

    await input.fill(String(RAE_STROKES_DIRECT));
    await rosterRow.getByRole("button", { name: "Save" }).click();

    // The row now says so in its own words — a seat that stated strokes has no normal score to
    // show, so it reads "gets 14 (given directly)" rather than implying one was measured.
    await expect(rosterRow).toContainText(`gets ${RAE_STROKES_DIRECT} (given directly)`);

    // DERIVED BY HAND (spec §2b): a `strokes` assertion is taken verbatim and NEVER enters the
    // anchor, so the anchor is now the only stated normal score left — Gil's 9 — and he stays on
    // 9 − 9 = 0. Rae gets exactly 14, NOT halved for the nine (the halving rule applies to a
    // DIFFERENCE between normal scores; 14 is already a claim about this round).
    //   allocateStrokes(14, 9 holes): base = floor(14/9) = 1, extra = 14 % 9 = 5 -> SI<=5 holes get
    //   2 dots, the rest get 1.
    //   Rae hole 1 (SI 5, <= 5): 2 dots -> gross 6, net 6-2=4 -> "●●64"
    //   Rae hole 2 (SI 1, <= 5): 2 dots -> gross 5, net 5-2=3 -> "●●53"
    //   Gil: still 0 strokes -> "5" and "4"
    await expect(page.getByRole("button", { name: "Rae hole 1", exact: true })).toHaveText(`${DOT}${DOT}64`);
    await expect(page.getByRole("button", { name: "Rae hole 2", exact: true })).toHaveText(`${DOT}${DOT}53`);
    await expect(page.getByRole("button", { name: "Gil hole 1", exact: true })).toHaveText("5");
    await expect(page.getByRole("button", { name: "Gil hole 2", exact: true })).toHaveText("4");

    // And the net game moves with it, flipping the LEADER — the strongest available proof the
    // second constructor really reached the engines and not just the roster row:
    //   Rae: net = (6-2) + (5-2) = 4+3 = 7 -> relativeToPar = 7-8 = -1 -> vsPar "(-1)"
    //   Gil: net = 9 (unchanged)            -> relativeToPar = +1     -> vsPar "(+1)"
    const gilRow = panel.getByRole("row").filter({ hasText: "Gil" });
    const raeRow = panel.getByRole("row").filter({ hasText: "Rae" });
    await expect(raeRow.getByRole("cell")).toHaveText(["Rae", "7", "2", "(-1)"]);
    await expect(gilRow.getByRole("cell")).toHaveText(["Gil", "9", "2", "(+1)"]);
    await expect(chip(page, "Stroke play (net)")).toContainText("Rae 7 thru 2 (-1)");
  });

  test("5: finalize through the real dialog; the archived card still shows Rae's given strokes, and getRoundArchive (API) folds to basis {strokes:14} / strokes 14", async () => {
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
    // needed for a tab that just finalized itself) — which already carries BOTH
    // participant-basis-set events synced in tests 2 and 4. Same hand-derived strings as test 4.
    const raeHole1 = page.getByRole("button", { name: "Rae hole 1", exact: true });
    await expect(raeHole1).toHaveText(`${DOT}${DOT}64`);
    await expect(raeHole1).toBeDisabled(); // archived: entry locked, no pad ever opens
    await expect(page.getByRole("button", { name: "Rae hole 2", exact: true })).toHaveText(`${DOT}${DOT}53`);

    // The wire cross-check the brief names explicitly: a FRESH fetch of GET
    // /rounds/{roundId}/archive (not this tab's own cached session fold) — "golfer"-gated
    // (routes.ts: authorizes by the caller's ACCOUNT, not the round-scoped participant token),
    // so this uses gil.tokens.idToken, never `started.token`. Folding the returned event log
    // through the SAME domain reduceRound the server itself uses for settlement must show Rae's
    // LAST assertion — the given-strokes basis from test 4 — never the join-time +2 or the
    // intermediate +13: settleRound reads state.participants straight off the ordinary event fold,
    // no special-case archive logic (packages/domain/src/round/archive.ts).
    const archiveResponse = await fetch(`${httpUrl}/rounds/${roundId}/archive`, { headers: { authorization: `Bearer ${gil.tokens.idToken}` } });
    const archiveJson: unknown = await archiveResponse.json();
    if (!archiveResponse.ok) throw new Error(`GET /rounds/${roundId}/archive -> ${archiveResponse.status}: ${JSON.stringify(archiveJson)}`);
    const { events } = parse(getRoundArchiveResponseSchema, archiveJson);
    const archivedState = reduceRound(events);
    const raeArchived = archivedState.participants.find((p) => p.golferId === rae.golfer.golferId);
    const gilArchived = archivedState.participants.find((p) => p.golferId === gil.golfer.golferId);
    // The ASSERTION and the DERIVED value are separate facts on the wire now (spec §2b: `basis` is
    // what the log carries, `strokes` is fold output), so both are pinned. Rae's last stated basis
    // is the strokes constructor, taken verbatim and unhalved.
    expect(raeArchived?.basis).toEqual({ kind: "strokes", strokes: RAE_STROKES_DIRECT });
    expect(raeArchived?.strokes).toBe(RAE_STROKES_DIRECT);
    expect(raeArchived?.name).toBe("Rae"); // a basis-set carries ONLY the assertion — name/tee are untouched
    expect(raeArchived?.tee).toBe("white");
    // Gil's own seat proves the exclusion rule end to end: a `strokes` seat never enters the
    // anchor, so the only stated normal score left is his own +9 and he derives 0 — his join
    // payload was never corrected, and it never had to be.
    expect(gilArchived?.basis).toEqual({ kind: "normally-shoots", overPar: GIL_OVER_PAR });
    expect(gilArchived?.strokes).toBe(0);
  });

  // Teardown: the round is finalized (nothing to scrap); Gil/Rae's throwaway Cognito users were
  // tracked at mint time (mintAccountGolfer -> support.ts's trackMintedUser) and are deleted by
  // the standard ndjson-driven globalTeardown, same as every other spec in this suite.
});
