import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { fixtureLinks } from "@swng/domain";
import type { GolferId, RoundId } from "@swng/domain";
import { createScoreOps, finalizeRoundDirect, loadWebEnv, mintAccountGolfer, recordScoreDirect, shareRoundDirect, startRoundDirect } from "./support.js";

// M9 Task 3 (share): the round has a link. The participant side is driven entirely over the
// API (score-for-anyone/API-only, the SAME idiom identityRecord.spec.ts's own API-played
// rounds already use — a browser adds nothing to "did the participant score a hole"); the
// participant is a signed-in ACCOUNT (accounts-only identity: the wall), minted and named by
// the harness, since anonymous round creation is gone. The spectator side is the one REAL
// browser this spec drives, deliberately with NO auth at all (no injectAuthTokens, no saved
// credential — a fresh, untouched context) to prove the brief's own headline claim: a
// spectator needs nothing but the link — the watch tier is the one participation lane the
// wall deliberately leaves open. Kept deliberately minimal on the round itself (no extra
// participants, no games) — a share link works identically regardless of what's being
// scored, and zero games means finalize resolves trivially, keeping this spec about SHARE,
// not about a scoring engine already gated by fieldTest.spec.ts/courseEntry.spec.ts.
//
// NOT run by the implementing agent (task-3-brief.md's own scope split) — the controller runs
// `pnpm e2e:field` (all specs, this one included) against the deployed beta stack.
test.describe.serial("M9 Task 3 field test — the round has a link: live spectator, finalize flip, write-rejection", () => {
  let httpUrl: string;
  let hostToken: string;
  let hostGolferId: GolferId;
  let roundIdValue: RoundId;
  let watchPath: string; // "/watch/{roundId}#{token}" — a path+fragment, resolved against playwright.config.ts's own baseURL
  let spectatorToken: string;
  let spectatorContext: BrowserContext;
  let spectatorPage: Page;
  const ops = createScoreOps("share-link-host");

  test.beforeAll(async ({ browser }) => {
    ({ httpUrl } = loadWebEnv());
    // A FRESH context — no cookies, no localStorage credential, no Cognito tokens injected.
    // This IS "opens the /watch link in a REAL browser with NO auth" (the brief's own words),
    // not a stand-in for it.
    spectatorContext = await browser.newContext();
    spectatorPage = await spectatorContext.newPage();
  });

  test.afterAll(async () => {
    await spectatorContext?.close();
  });

  test("1: a signed-in participant creates a round as herself and scores hole 1, entirely over the API", async () => {
    const ann = await mintAccountGolfer("share-ann", "Ann");
    const started = await startRoundDirect(httpUrl, ann, { card: fixtureLinks, tee: "white", courseHandicap: 8 });
    roundIdValue = started.roundId;
    hostToken = started.token;
    hostGolferId = started.golferId;

    await recordScoreDirect(httpUrl, started.roundId, started.token, { golferId: started.golferId, hole: 1, strokes: 4 }, ops);
  });

  test("2: the participant mints the round's own share link over the API — deterministic across repeat calls", async () => {
    const first = await shareRoundDirect(httpUrl, roundIdValue, hostToken);
    const second = await shareRoundDirect(httpUrl, roundIdValue, hostToken);
    expect(second.url).toBe(first.url); // same round -> the byte-identical link, every time

    watchPath = first.url;
    expect(watchPath).toMatch(new RegExp(`^/watch/${roundIdValue}#`));
    spectatorToken = watchPath.split("#")[1]!;
    expect(spectatorToken.length).toBeGreaterThan(0);
  });

  test("3: a spectator opens the /watch link in a REAL browser with NO auth and sees Ann's live hole-1 score", async () => {
    await spectatorPage.goto(watchPath);
    await expect(spectatorPage).toHaveURL(new RegExp(`/watch/${roundIdValue}#`));

    const cell = spectatorPage.getByRole("button", { name: "Ann hole 1", exact: true });
    await expect(cell).toBeVisible();
    await expect(cell).toContainText("4");
    await expect(cell).toBeDisabled(); // read-only, structurally — no pad ever opens (no click() attempted here on purpose)

    // No sign-in chrome anywhere on this page (brief: "No sign-in") — WatchPage renders
    // outside the app's Layout/AuthChrome entirely.
    await expect(spectatorPage.getByRole("button", { name: "Sign out" })).toHaveCount(0);
    await expect(spectatorPage.getByRole("link", { name: /Sign in/i })).toHaveCount(0);
  });

  test("4: a NEW score lands on the spectator's page live — WS or poll, useWatchRound's own fallback story", async () => {
    await recordScoreDirect(httpUrl, roundIdValue, hostToken, { golferId: hostGolferId, hole: 2, strokes: 5 }, ops);

    const cell = spectatorPage.getByRole("button", { name: "Ann hole 2", exact: true });
    // Headroom past useWatchRound's own 4s production poll cadence — playwright.config.ts's
    // own expect.timeout (10s) already covers this, but the extra explicit budget documents
    // WHY this assertion in particular needs more than an instant.
    await expect(cell).toContainText("5", { timeout: 15_000 });
  });

  test("5: finalize flips the spectator's view to the archived card", async () => {
    await finalizeRoundDirect(httpUrl, roundIdValue, hostToken);

    await expect(spectatorPage.getByRole("heading", { name: "Final results" })).toBeVisible({ timeout: 15_000 });
    // The archived card is read-only there too (ResultsView's own readOnly ScorecardGrid)...
    await expect(spectatorPage.getByRole("button", { name: "Ann hole 1", exact: true })).toBeDisabled();
    // ...and carries NO Share affordance: a spectator holds no participant token to mint a
    // NEW link with (POST /rounds/{roundId}/share is participant-gated) — ResultsView.tsx's
    // own doc comment on why shareToken is optional and omitted by WatchPage's reuse.
    await expect(spectatorPage.getByRole("button", { name: "Share round" })).toHaveCount(0);
  });

  test("6: a spectator-token WRITE attempt over HTTP is rejected — 403 read-only-token, the real mapped code", async () => {
    const response = await fetch(`${httpUrl}/rounds/${roundIdValue}/scores`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${spectatorToken}` },
      body: JSON.stringify({
        golferId: hostGolferId,
        hole: 3,
        result: { kind: "strokes", strokes: 4 },
        opId: "shareLink-spec-write-attempt",
        hlc: { wallMs: Date.now(), counter: 0, deviceId: "shareLink-spec" },
      }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("read-only-token");
  });
});
