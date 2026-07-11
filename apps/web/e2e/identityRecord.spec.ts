import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { GetMyRecordResponse } from "@swng/contracts";
import { golferId, roundId } from "@swng/domain";
import type { CourseCard, GolferId, RoundId } from "@swng/domain";
import type { AuthTokens } from "../src/auth/tokenStore.js";
import {
  createScoreOps,
  ensureCourse,
  finalizeRoundDirect,
  getMyRecordDirect,
  injectAuthTokens,
  invokeRebuild,
  joinRoundDirect,
  loadWebEnv,
  mintThrowawayUser,
  readJoinCode,
  recordScoreDirect,
  screenshotPath,
  startRoundDirect,
} from "./support.js";

// The M7 gate (docs/implementation-plan.md M7; docs/superpowers/plans/2026-07-10-m7-identity.md
// Task 8): finalizing a round updates a golfer's history and index LIVE, claiming a ghost
// mid-season leaves the record unbroken, and a projections wipe+rebuild reproduces the exact
// same values. One Playwright context (the claim/finalize/profile steps genuinely need a
// browser — SetupPanel's roster and ProfilePage are real UI), everything else (playing ghost
// g's three rounds, the pre/post-rebuild record fetches) goes straight over the API via
// support.ts's *Direct helpers — the same "browser only where the story needs one" precedent
// as fieldTest.spec.ts's Cal/Dee and courseEntry.spec.ts's Quinn.
//
// Course: a throwaway 18-hole, all-par-4 (par 72) card at rating 71.6 / slope 128 — chosen so
// every hole's net-double-bogey cap (par+2, or par+3 on g's 8 stroke-index-1..8 holes) sits
// comfortably above the worst score this deck ever posts (bogey, +1), so AGS == gross exactly
// regardless of which specific holes land the "extra" strokes (the brief's own note: "no
// net-double-bogey caps bite"). A single flat tee keeps the composition arithmetic (bogeys ×
// (par+1) + pars × par) trivial to hand-verify against the brief's pinned table.
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
// score par — every hole here is par 4, so this is just fives-then-fours. The brief's own
// table: 10/13/16 bogeys -> gross 82/85/88 (par 72 + bogeys, since every non-bogey hole is a
// scratch par).
const holeScoresFor = (bogeys: number): readonly number[] => Array.from({ length: 18 }, (_, i) => (i < bogeys ? 5 : 4));

// Hand-pinned in the brief (BLOCKED-don't-fudge territory): differential = (113/128)*(AGS-71.6)
// for AGS 82/85/88. Unrounded (scoreDifferential's own contract) — asserted via toBeCloseTo
// below, the SAME convention packages/domain/src/handicap/whs.test.ts itself uses for raw
// (pre-tenth-rounding) differential values, never a brittle exact toBe on a float.
const PINNED_DIFFERENTIALS = [9.18125, 11.8296875, 14.478125] as const;
const PINNED_INDEX = 7.2;
const PINNED_DIFFERENTIALS_USED = 1;

// Playing rounds 2 and 3 is pure API — no browser, no story reason for one (score-for-anyone,
// same precedent as joinRoundDirect's own doc comment). Round 1 is different: it's the round
// the browser opens live to claim g on, so it's created through the real UI (test 1) and
// finalized through the real UI (test 4) — everything else about it (joining g, scoring g)
// is API, identical in shape to this helper.
const playApiRound = async (httpUrl: string, card: CourseCard, hostLabel: string, ghost: GolferId, bogeys: number): Promise<void> => {
  const started = await startRoundDirect(httpUrl, { card, host: { name: `Host-${hostLabel}`, tee: "white", courseHandicap: 0 } });
  const joined = await joinRoundDirect(httpUrl, { code: started.joinCode, name: "Ghost G", tee: "white", courseHandicap: 8, golferId: ghost });
  const ops = createScoreOps(`ghost-${hostLabel}`);
  for (const [i, strokes] of holeScoresFor(bogeys).entries()) {
    await recordScoreDirect(httpUrl, started.roundId, joined.token, { golferId: ghost, hole: i + 1, strokes }, ops);
  }
  await finalizeRoundDirect(httpUrl, started.roundId, joined.token);
};

// getMyRecord's history is populated by the DynamoDB Streams projector (packages/lambda/src/
// entries/projector.ts) — asynchronous relative to finalizeRound's own HTTP response, so a
// bare single fetch right after finalize is a race. Polls the SAME endpoint finalize's own doc
// comment already treats as the authoritative read, not a fixed sleep.
// projectArchive.ts's own two writes per golfer (putHistoryLine, THEN — a separate later
// await in the SAME call — putIndex once the bootstrap is met) are not transactional: a poll
// gated on history.length alone can observe the gap between them, where the 3rd line has
// landed but the index it unblocks hasn't yet (caught by this gate's own run 3: "Received:
// undefined" for index.value with history already at 3). Gating on BOTH conditions is the
// fix, not a longer timeout or a retry — the underlying race is real and instantaneous, not
// slow.
const pollRecord = async (httpUrl: string, token: string, minHistory: number, timeoutMs = 60_000): Promise<GetMyRecordResponse> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await getMyRecordDirect(httpUrl, token);
    if (record.history.length >= minHistory && record.index !== undefined) return record;
    if (Date.now() >= deadline) {
      throw new Error(`/me/record still has ${record.history.length}/${minHistory} history lines (index ${record.index ? "present" : "absent"}) after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

test.describe.serial("M7 identity/record gate — claim mid-season, live index, rebuild parity", () => {
  let page: Page;
  const ghostGolferId: GolferId = golferId(crypto.randomUUID());
  const courseName = `Identity Record Course ${Date.now()}`;
  const card = buildIdentityCourseCard(courseName);
  let userA: AuthTokens;
  let roundId1: RoundId;
  let joinCode1 = "";
  let ghostToken1 = "";
  let preRebuildRecord: GetMyRecordResponse;

  test.beforeAll(async ({ browser }) => {
    // Minted here, but NOT injected yet — see test 3's own comment. userA is created early
    // only so its throwaway Cognito user exists before anything needs it.
    userA = await mintThrowawayUser("user-a");
    const context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test("1: Host1 creates round 1 through the real UI, on a fresh throwaway course", async () => {
    await ensureCourse(courseName, card);

    await page.goto("/create");
    await page.getByLabel("Course", { exact: true }).fill(courseName);
    const result = page.getByRole("button", { name: courseName, exact: true }).first();
    await expect(result).toBeVisible();
    await result.click();
    await page.getByLabel("Your name").fill("Host1");
    await page.getByLabel("Course handicap").fill("0");
    await page.getByRole("button", { name: "Create round" }).click();

    await expect(page).toHaveURL(/\/round\//);
    roundId1 = roundId(new URL(page.url()).pathname.replace("/round/", ""));
    joinCode1 = await readJoinCode(page);
  });

  test("2: ghost g plays rounds 1–3 via the API — the pinned gross totals (82/85/88)", async () => {
    test.setTimeout(120_000);

    // Round 1 stays LIVE (not finalized) — the browser needs to open it live in test 3 to
    // claim g; SetupPanel's roster only renders pre-finalize (ResultsView has no roster at
    // all), so the claim MUST happen before this round finalizes. g's own token comes back
    // from THIS join, reused for both scoring and (test 4) finalizing round 1.
    const { httpUrl } = loadWebEnv();
    const joined1 = await joinRoundDirect(httpUrl, { code: joinCode1, name: "Ghost G", tee: "white", courseHandicap: 8, golferId: ghostGolferId });
    ghostToken1 = joined1.token;
    const ops1 = createScoreOps("ghost-r1");
    for (const [i, strokes] of holeScoresFor(10).entries()) {
      await recordScoreDirect(httpUrl, roundId1, ghostToken1, { golferId: ghostGolferId, hole: i + 1, strokes }, ops1);
    }

    // Rounds 2 and 3 reuse g's SAME golferId (Task 5b: unclaimed reuse) and finalize
    // immediately — they MUST both join (and thereby lock in that reuse) before the claim
    // below binds a sub to g, since a claimed g's golferStore row rejects further reuse.
    await playApiRound(httpUrl, card, "2", ghostGolferId, 13);
    await playApiRound(httpUrl, card, "3", ghostGolferId, 16);
  });

  test("3: signed-in user A claims ghost g on round 1's still-live roster", async () => {
    // Signed in HERE, not in beforeAll (M8 Task 7 field finding): M8's own "play as yourself"
    // CreateRoundPage (commit 236809c) auto-binds ANY signed-in caller's account to whatever
    // name they type at round-creation time (PUT /me + as-self StartRound) — this test predates
    // that behavior (9f02cd6) and its whole story depends on Host1 (test 1) staying a SEPARATE
    // identity from user A, who arrives later to claim ghost g. Injecting the token before test
    // 1 would silently consume userA's one-account-one-golfer slot on "Host1" instead of
    // leaving it free, so every claim attempt below would legitimately 409
    // "golfer-already-claimed" — reproduced directly against beta (bypassing the UI, raw fetch)
    // before this fix: a fresh ghost claims cleanly in isolation, but replaying this describe
    // block's OWN sequence (sign in before test 1, type "Host1", then claim ghost g) 409s every
    // time. addInitScript takes effect on the reload right after it, and on every navigation
    // after that (test 4/5 need no second injection).
    await injectAuthTokens(page, userA);
    await page.reload();

    const rosterRow = page.locator("li", { hasText: "Ghost G" });
    await expect(rosterRow).toBeVisible();
    await rosterRow.getByRole("button", { name: "This is me", exact: true }).click();
    await rosterRow.getByRole("dialog", { name: "Confirm claim" }).getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(rosterRow.getByRole("status")).toContainText("Linked to your account");

    // Legibility walk (papercuts.md §4): signed-in header chrome (name + Sign out, top of
    // every page via App.tsx's Layout) alongside the fresh claim confirmation — one screenshot
    // for both surfaces at once, still live (pre-finalize).
    await page.screenshot({ path: screenshotPath("signed-in-chrome-and-claim.png"), fullPage: true });
  });

  test("4: round 1 finalizes through the real UI; /me/record settles to 3 lines and the pinned index", async () => {
    test.setTimeout(90_000);
    await page.getByRole("button", { name: "Finalize round" }).click();
    await page.getByRole("dialog", { name: "Confirm finalize" }).getByRole("button", { name: "Finalize", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Final results" })).toBeVisible();

    const { httpUrl } = loadWebEnv();
    const record = await pollRecord(httpUrl, userA.idToken, 3);
    expect(record.history).toHaveLength(3);

    // history is newest-first (packages/contracts/src/golfers.ts's own doc comment;
    // getMyRecord.ts implements it via reverse of listHistory's oldest->newest) — and this
    // describe block's own control flow makes the finalize order, and therefore the position
    // of each differential, deterministic: round 2 finalizes inside test 2's playApiRound call
    // (bogeys 13 -> AGS 85), then round 3 (bogeys 16 -> AGS 88), then round 1 finalizes LAST
    // here in test 4 (bogeys 10 -> AGS 82, after the claim). Newest-first is therefore
    // [round1 (82), round3 (88), round2 (85)]. Derived from PINNED_DIFFERENTIALS (itself
    // ordered by AGS 82/85/88, see the constant's own comment) rather than re-typed literals,
    // so a future re-ordering of this test's own finalize sequence fails this assertion loudly
    // instead of silently passing a stale expectation.
    const expectedNewestFirst = [PINNED_DIFFERENTIALS[0], PINNED_DIFFERENTIALS[2], PINNED_DIFFERENTIALS[1]];
    for (const [i, value] of record.history.map((line) => line.differential).entries()) {
      expect(value, `history[${i}].differential`).toBeCloseTo(expectedNewestFirst[i]!, 6);
    }

    // round 1 finalizes last (test 4, after the claim) -> newest -> history[0].
    expect(record.history[0]?.roundId).toBe(roundId1);

    // Three differentials -> WHS small-sample table row (<=3: use 1, adjustment -2.0) -> lowest
    // 9.18125 - 2.0 = 7.18125 -> tenth-rounded -> 7.2, differentialsUsed 1 (brief's own
    // computation, packages/domain/src/handicap/whs.ts's smallSampleTable). If the live system
    // disagrees with either pinned number, this assertion fails loudly rather than being
    // adjusted to match — the brief's own BLOCKED-don't-fudge instruction.
    expect(record.index?.value).toBe(PINNED_INDEX);
    expect(record.index?.differentialsUsed).toBe(PINNED_DIFFERENTIALS_USED);

    preRebuildRecord = record;
  });

  test("5: ProfilePage renders the same live record for the signed-in golfer", async () => {
    await page.goto("/profile");

    const indexParagraph = page.getByText(/swng Index/);
    await expect(indexParagraph).toContainText("7.2");
    // Singular "differential" (not "differentials") is the differentialsUsed===1 case
    // (ProfilePage.tsx's own ternary) — a negative lookahead so a stray plural wouldn't pass
    // this as a false positive (a bare "contains 'differential'" substring check would).
    await expect(indexParagraph).toHaveText(/from 1 differential(?!s)/);

    // "History" h3's own following <ul> (ProfilePage.tsx: history.length > 0 renders exactly
    // this shape) — same structural-lookup idiom as support.ts's readJoinCode, since neither
    // element carries an aria-label/testid of its own.
    const historyList = page.locator("xpath=//h3[normalize-space(text())='History']/following-sibling::ul[1]");
    await expect(historyList.getByRole("listitem")).toHaveCount(3);

    // Legibility walk (papercuts.md §4): ProfilePage with a real record — index, trend, history.
    await page.screenshot({ path: screenshotPath("profile-with-record.png"), fullPage: true });
  });

  test("6: rebuild parity — wiping and replaying every projection reproduces the identical record", async () => {
    test.setTimeout(360_000); // the rebuild lambda replays every finalized round on beta (5-minute CDK timeout) — comfortably slower than every other step here

    const summary = await invokeRebuild();
    console.log(`[identityRecord] rebuild: ${summary.rounds} rounds, ${summary.golfers} golfers`);
    expect(summary.rounds).toBeGreaterThanOrEqual(3); // at least this run's own 3 rounds

    const { httpUrl } = loadWebEnv();
    const postRebuildRecord = await getMyRecordDirect(httpUrl, userA.idToken);

    // Deep-equal on history: archiveGolferLine is a pure recompute from the SAME stored
    // archive both before and after rebuild — no wall-clock or randomness anywhere in it, so
    // this holds bit-for-bit, not just toBeCloseTo.
    expect(postRebuildRecord.history).toEqual(preRebuildRecord.history);
    expect(postRebuildRecord.index?.value).toBe(preRebuildRecord.index?.value);
    expect(postRebuildRecord.index?.differentialsUsed).toBe(preRebuildRecord.index?.differentialsUsed);

    // computedAtMs is deliberately EXCLUDED from the equality above — projectArchive.ts's own
    // doc comment: `computedAtMs: deps.clock.now()`, a fresh wall-clock stamp taken every time
    // the index is (re)computed. Asserting it CHANGED is the positive half of that same fact:
    // honest proof the rebuild actually recomputed this golfer's index rather than reading a
    // stale snapshot back untouched.
    expect(postRebuildRecord.index?.computedAtMs).not.toBe(preRebuildRecord.index?.computedAtMs);
  });
});
