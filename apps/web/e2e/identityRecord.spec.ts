import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { GetMyRecordResponse } from "@swng/contracts";
import { postedDifferential } from "@swng/domain";
import type { CourseCard, RoundId } from "@swng/domain";
import {
  createScoreOps,
  ensureCourse,
  finalizeRoundDirect,
  getMyRecordDirect,
  injectAuthTokens,
  invokeRebuild,
  loadWebEnv,
  mintAccountGolfer,
  recordScoreDirect,
  screenshotPath,
  startRoundDirect,
} from "./support.js";
import type { AccountGolfer } from "./support.js";

// The record gate, rewritten accounts-only (accounts-only identity spec §1-2): the old
// play-as-ghost-then-claim arc is DELETED, not stubbed — nothing exists to claim anymore, so
// the story is the product's own instead: one account signs up, names itself once, plays
// three rounds AS ITSELF, and its history/index accrue live; then a projections rebuild
// reproduces the identical record. The oracle discipline is unchanged from the M7 original:
// every expected number below was hand-pinned BEFORE any live call, never computed from the
// system under test (BLOCKED-don't-fudge). Everything is API-driven except test 3 —
// ProfilePage is real UI, so it gets the one browser step ("browser only where the story
// needs one", the same precedent as fieldTest.spec.ts's Cal/Dee).
//
// Course: a throwaway 18-hole, all-par-4 (par 72) card at rating 71.6 / slope 128 — chosen so
// every hole's net-double-bogey cap (par+2, or par+3 on the 8 stroke-index-1..8 holes where
// the account's ch-8 strokes land) sits comfortably above the worst score this deck ever
// posts (bogey, +1), so AGS == gross exactly regardless of which specific holes land the
// "extra" strokes. A single flat tee keeps the composition arithmetic (bogeys × (par+1) +
// pars × par) trivial to hand-verify against the pinned table.
const buildIdentityCourseCard = (courseName: string): CourseCard => ({
  courseName,
  teeSets: [
    {
      name: "white",
      rating: 71.6,
      slope: 128,
      holes: Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4, yardage: 380, strokeIndex: i + 1 })),
    },
  ],
});

// Round n's hole-by-hole gross composition, oldest-first: `bogeys` holes score par+1, the rest
// score par — every hole here is par 4, so this is just fives-then-fours. The pinned table:
// 10/13/16 bogeys -> gross 82/85/88 (par 72 + bogeys, since every non-bogey hole is a
// scratch par).
const holeScoresFor = (bogeys: number): readonly number[] => Array.from({ length: 18 }, (_, i) => (i < bogeys ? 5 : 4));

// Hand-pinned (BLOCKED-don't-fudge territory): differential = (113/128)*(AGS-71.6) for AGS
// 82/85/88. Unrounded (scoreDifferential's own contract) — asserted via toBeCloseTo below,
// the SAME convention packages/domain/src/handicap/whs.test.ts itself uses for raw
// (pre-tenth-rounding) differential values, never a brittle exact toBe on a float.
const PINNED_DIFFERENTIALS = [9.18125, 11.8296875, 14.478125] as const;
const PINNED_INDEX = 7.2;
const PINNED_DIFFERENTIALS_USED = 1;

// One deck round, played entirely as the account itself: start as-self (Bearer + the
// account's own golferId — startRoundDirect sources both from the record), 18 scores via the
// round's own participant token, finalize. Pure API — nothing in "a finalized round lands on
// the record" is UI behavior (the UI half is test 3's ProfilePage read).
// Course-cards spec §4: takes the already-seeded REFERENCE (course-cards spec §4), not a card —
// the caller seeds the lineage once (test 1, below) and threads the same reference through all
// three rounds.
const playRecordRound = async (
  httpUrl: string,
  account: AccountGolfer,
  course: Awaited<ReturnType<typeof ensureCourse>>,
  label: string,
  bogeys: number,
): Promise<RoundId> => {
  const started = await startRoundDirect(httpUrl, account, { course, tee: "white", courseHandicap: 8 });
  const ops = createScoreOps(`record-${label}`);
  for (const [i, strokes] of holeScoresFor(bogeys).entries()) {
    await recordScoreDirect(httpUrl, started.roundId, started.token, { golferId: account.golfer.golferId, hole: i + 1, strokes }, ops);
  }
  await finalizeRoundDirect(httpUrl, started.roundId, started.token);
  return started.roundId;
};

// getMyRecord's history is populated by the DynamoDB Streams projector (packages/lambda/src/
// entries/projector.ts) — asynchronous relative to finalizeRound's own HTTP response, so a
// bare single fetch right after finalize is a race. Polls the SAME endpoint finalize's own doc
// comment already treats as the authoritative read, not a fixed sleep.
// Since the pre-prod hardening (D4a) the index is computed at read time from the very lines
// this response carries — once history.length crosses the bootstrap, index is present in the
// SAME response by construction (the projector's old putLine-then-store-the-index write gap,
// which this gate's dual condition was originally built to ride out, no longer exists). The
// dual gate stays as a cheap invariant assertion, not a race fix.
const pollRecord = async (httpUrl: string, token: string, minHistory: number, timeoutMs = 60_000): Promise<GetMyRecordResponse> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await getMyRecordDirect(httpUrl, token);
    if (record.history.length >= minHistory && record.metrics.whsIndex !== undefined) return record;
    if (Date.now() >= deadline) {
      throw new Error(`/me/record still has ${record.history.length}/${minHistory} history lines (whsIndex ${record.metrics.whsIndex ? "present" : "absent"}) after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

test.describe.serial("identity/record gate — one account, three rounds as self, live index, rebuild parity", () => {
  let page: Page;
  const courseName = `Identity Record Course ${Date.now()}`;
  const card = buildIdentityCourseCard(courseName);
  let account: AccountGolfer;
  const roundIds: RoundId[] = [];
  let preRebuildRecord: GetMyRecordResponse;

  test.beforeAll(async ({ browser }) => {
    // The one sign-up: minted via the admin APIs (Cognito's stock hosted sign-up form is the
    // controller's live spot-walk, not this gate's) and named once through PUT /me — the
    // account golfer this whole record accrues to. Injected before the context's first
    // navigation so the one browser step (ProfilePage, test 3) runs signed in.
    account = await mintAccountGolfer("record-account", "Rae");
    const context = await browser.newContext();
    page = await context.newPage();
    await injectAuthTokens(page, account.tokens);
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test("1: the account plays rounds 1-3 as itself via the API — the pinned gross totals (82/85/88)", async () => {
    test.setTimeout(180_000);
    const { httpUrl } = loadWebEnv();

    // Course-cards spec §4: seed the lineage ONCE, then thread the same reference through all
    // three rounds — StartRound resolves a reference now, never a card.
    const course = await ensureCourse(courseName, card, account);

    // Strictly in deck order, each finalized before the next starts — test 2's newest-first
    // expectation depends on exactly this sequence. The same account golferId seats every
    // round because it IS the account's own id; season-long continuity needs no claim step
    // and no ghost reuse, it's just identity.
    roundIds.push(await playRecordRound(httpUrl, account, course, "r1", 10));
    roundIds.push(await playRecordRound(httpUrl, account, course, "r2", 13));
    roundIds.push(await playRecordRound(httpUrl, account, course, "r3", 16));
  });

  test("2: /me/record settles to 3 lines and the pinned index, live", async () => {
    test.setTimeout(90_000);
    const { httpUrl } = loadWebEnv();
    const record = await pollRecord(httpUrl, account.tokens.idToken, 3);
    expect(record.history).toHaveLength(3);

    // history is newest-first (packages/contracts/src/golfers.ts's own doc comment;
    // getMyRecord.ts implements it via sortLines + reverse) — and test 1's own control flow
    // finalizes strictly in deck order: round 1 (AGS 82), round 2 (85), round 3 (88).
    // Newest-first is therefore [round3 (88), round2 (85), round1 (82)] —
    // PINNED_DIFFERENTIALS reversed. Derived from the pinned constant rather than re-typed
    // literals, so a future re-ordering of the play sequence fails this assertion loudly
    // instead of silently passing a stale expectation.
    // The WIRE serves the POSTED differential — one decimal (record-redesign arc 2026-07-18): a
    // golfer's record reads 9.2, not the raw 9.18125. The index still folds the RAW full-precision
    // lines (PINNED_INDEX below is unchanged), so only the DISPLAYED value rounds — assert the exact
    // posted value via the domain's own postedDifferential, not the raw pin.
    const expectedNewestFirst = [PINNED_DIFFERENTIALS[2], PINNED_DIFFERENTIALS[1], PINNED_DIFFERENTIALS[0]];
    for (const [i, value] of record.history.map((line) => line.differential).entries()) {
      expect(value, `history[${i}].differential`).toBeCloseTo(postedDifferential(expectedNewestFirst[i]!), 6);
    }

    // Round 3 finalized last -> newest -> history[0]; round 1 first -> oldest -> history[2].
    expect(record.history[0]?.roundId).toBe(roundIds[2]);
    expect(record.history[2]?.roundId).toBe(roundIds[0]);

    // Three differentials -> WHS small-sample table row (<=3: use 1, adjustment -2.0) -> lowest
    // 9.18125 - 2.0 = 7.18125 -> tenth-rounded -> 7.2, differentialsUsed 1 (packages/domain/
    // src/handicap/whs.ts's smallSampleTable). If the live system disagrees with either pinned
    // number, this assertion fails loudly rather than being adjusted to match — the
    // BLOCKED-don't-fudge instruction.
    expect(record.metrics.whsIndex?.value).toBe(PINNED_INDEX);
    expect(record.metrics.whsIndex?.differentialsUsed).toBe(PINNED_DIFFERENTIALS_USED);

    // Bests + milestones (analytics read-folds spec 2026-07-21 §3, packages/domain/src/golfer/
    // analytics.ts) — hand-derived BEFORE any live run from this deck's own pinned scores, never
    // read back off the system (BLOCKED-don't-fudge). All three rounds are fully holed out
    // (every hole a strokes cell) 18-hole cards on the par-72 all-par-4 course, so:
    //
    //   round 1 (10 bogeys): gross 82, toPar 82 - 72 = 10   <- LOWEST gross
    //   round 2 (13 bogeys): gross 85, toPar 13
    //   round 3 (16 bogeys): gross 88, toPar 16
    //
    // BESTS: lowest gross per hole count, tie -> earlier round (bestsOf's strict `<`). Round 1's
    // 82 is the outright lowest 18-hole gross, so best18 = { round 1, 82, +10 }. There is no
    // 9-hole round at all, so best9 is ABSENT (the honest empty answer, not zeroed). roundIds[0]
    // is round 1 (test 1 pushes r1/r2/r3 in play order; roundIds[2] is round 3, the newest).
    expect(record.metrics.bests.best18).toEqual({ roundId: roundIds[0], gross: 82, toPar: 10 });
    expect(record.metrics.bests.best9).toBeUndefined();
    //
    // MILESTONES: achieved-only, emitted in the FIXED kind order (first-birdie, first-eagle,
    // broke-100, broke-90, broke-80 — milestonesOf), each the earliest qualifying round.
    //   - first-birdie / first-eagle: this deck NEVER scores below par (every hole is a 4 or a
    //     bogey 5 on a par-4 card), so no under-par hole exists -> BOTH absent.
    //   - broke-100: first fully holed-out 18 under 100 -> round 1 (82 < 100).
    //   - broke-90:  first under 90 -> round 1 (82 < 90).
    //   - broke-80:  none under 80 (82/85/88 all >= 80) -> absent.
    // So exactly [broke-100 @ r1, broke-90 @ r1], in that fixed order.
    expect(record.metrics.milestones).toEqual([
      { kind: "broke-100", roundId: roundIds[0] },
      { kind: "broke-90", roundId: roundIds[0] },
    ]);

    preRebuildRecord = record;
  });

  test("3: ProfilePage renders the same live record for the signed-in golfer", async () => {
    await page.goto("/profile");

    // "Your index" (handicap-model legibility spec §3): the old "swng Index {value} — from N
    // differential(s)" paragraph this test pinned against was DELETED whole by HL-T2 — it was a
    // mislabel (a "swng Index" heading over what was actually the WHS value). The value pinned
    // in test 2 above (record.metrics.whsIndex.value === PINNED_INDEX) has a direct analog on
    // the new surface: the "WHS index · <value>" data point (ProfilePage.tsx's INDEX_SOURCES
    // row), read straight off the very same field — the account plays only rated rounds, so its
    // swng index and WHS index are numerically identical (7.2 either way), but the WHS row is
    // the more direct read of the field this suite already pinned. The new surface renders no
    // differentials-count copy anywhere near the value, so the old `/from 1 differential(?!s)/`
    // half of this assertion has nothing left to target — dropped rather than invented against
    // text that no longer exists.
    const whsIndexRow = page.getByText(/WHS index/);
    await expect(whsIndexRow).toContainText("7.2");

    // "History" h3's own following <ul> (ProfilePage.tsx: history.length > 0 renders exactly
    // this shape) — same structural-lookup idiom as support.ts's readJoinCode, since neither
    // element carries an aria-label/testid of its own.
    const historyList = page.locator("xpath=//h3[normalize-space(text())='History']/following-sibling::ul[1]");
    await expect(historyList.getByRole("listitem")).toHaveCount(3);

    // Legibility walk (papercuts.md §4): ProfilePage with a real record — index, trend, history.
    await page.screenshot({ path: screenshotPath("profile-with-record.png"), fullPage: true });
  });

  test("4: rebuild parity — the paged snapshot backfill reproduces the identical record", async () => {
    test.setTimeout(360_000); // the rebuild lambda replays every finalized round on beta (5-minute CDK timeout) — comfortably slower than every other step here

    const summary = await invokeRebuild();
    console.log(`[identityRecord] rebuild: ${summary.processed} snapshots processed`);
    expect(summary.processed).toBeGreaterThanOrEqual(3); // at least this run's own 3 rounds

    const { httpUrl } = loadWebEnv();
    const postRebuildRecord = await getMyRecordDirect(httpUrl, account.tokens.idToken);

    // Deep-equal on history: archiveGolferLine is a pure recompute from the SAME stored
    // archive both before and after rebuild — no wall-clock or randomness anywhere in it, so
    // this holds bit-for-bit, not just toBeCloseTo.
    expect(postRebuildRecord.history).toEqual(preRebuildRecord.history);
    expect(postRebuildRecord.metrics.whsIndex?.value).toBe(preRebuildRecord.metrics.whsIndex?.value);
    expect(postRebuildRecord.metrics.whsIndex?.differentialsUsed).toBe(preRebuildRecord.metrics.whsIndex?.differentialsUsed);

    // computedAtMs is deliberately EXCLUDED from the equality above — since pre-prod
    // hardening D4a it's getMyRecord's read-time stamp (`deps.clock.now()` at each GET), so
    // two reads at different instants ALWAYS differ; it proves nothing about the rebuild. The
    // real parity proof is the history deep-equal plus the value/differentialsUsed equality
    // just above — the index recomputed from rebuilt lines landing identical.
    expect(postRebuildRecord.metrics.whsIndex?.computedAtMs).not.toBe(preRebuildRecord.metrics.whsIndex?.computedAtMs);
  });
});
