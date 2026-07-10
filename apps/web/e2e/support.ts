// Shared plumbing for fieldTest.spec.ts AND courseEntry.spec.ts: reading the live endpoint the
// built app itself was compiled against, out-of-browser joins, course seeding via the public
// course API, the deck-derived expected UI strings, the SetupPanel join-code lookup, and the
// two-tap grid interaction every score entry in either spec goes through. Split out of the spec
// files for the same reason e2e/support/client.ts is split from the root workspace's own specs:
// one place for the plumbing, one file per scenario for the story.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page, WebSocketRoute } from "@playwright/test";
import {
  createCourseRequestSchema,
  createCourseResponseSchema,
  joinRoundRequestSchema,
  joinRoundResponseSchema,
  parse,
  searchCoursesResponseSchema,
} from "@swng/contracts";
import type { JoinRoundResponse } from "@swng/contracts";
import { fieldDeck18, fixtureLinks18, playGoldenRoundLog, reduceRound, scoreGame } from "@swng/domain";
import type { CourseCard, FixtureScores, GolferId, RoundState } from "@swng/domain";
import { describeGame } from "../src/games/describeGame.js";

// --- Endpoints ---------------------------------------------------------------------------

export interface WebEnv {
  readonly httpUrl: string;
  readonly wsUrl: string;
}

// Reads the SAME apps/web/.env.local playwright.config.ts's webServer.command generates
// (via scripts/webEnv.mjs) before `vite build` runs — the spec's own direct joinRound calls
// for Cal/Dee (brief: score-for-anyone makes their browsers unnecessary) must hit the
// identical, already-trailing-slash-stripped origin the built app was compiled against, not a
// second independently-loaded copy of apps/infra-cdk/cdk-outputs.json that could drift from
// it. By the time a test body runs, webServer has already succeeded, so this file is
// guaranteed to exist.
export const loadWebEnv = (): WebEnv => {
  const envPath = fileURLToPath(new URL("../.env.local", import.meta.url));
  const contents = readFileSync(envPath, "utf8");
  const read = (key: string): string => {
    const line = contents.split("\n").find((candidate) => candidate.startsWith(`${key}=`));
    if (!line) throw new Error(`${key} not found in ${envPath} — did scripts/webEnv.mjs run (playwright.config.ts's webServer.command)?`);
    return line.slice(key.length + 1).trim();
  };
  return { httpUrl: read("VITE_HTTP_URL"), wsUrl: read("VITE_WS_URL") };
};

// --- Course seeding: search-first, create-if-absent, via the PUBLIC course API ---------------

// M6 field-test upkeep: the web app's create flow dropped bundled fixtures entirely — search
// is the only picker (CreateRoundPage now renders CourseSearch, never a fixture <select>) — so
// fieldTest.spec.ts's own deck (fieldDeck18/fixtureLinks18) needs a REAL course record to find
// and pick in step 1. Idempotent across repeat runs: searches by the exact name first
// (courseNameKey's prefix-match GSI — createDynamoCourseStore.ts's own normalization, the same
// one createCourse's write uses), and only creates when no exact match comes back, so the
// gate's three consecutive `pnpm e2e:field` runs (brief) seed the course once, not three times.
export const ensureCourse = async (name: string, card: CourseCard): Promise<void> => {
  const { httpUrl } = loadWebEnv();
  const teeSet = card.teeSets[0];
  if (!teeSet) throw new Error(`course card "${name}" has no tee sets to seed with`);

  const searchParams = new URLSearchParams({ query: name });
  const searchResponse = await fetch(`${httpUrl}/courses?${searchParams.toString()}`);
  const searchJson: unknown = await searchResponse.json();
  if (!searchResponse.ok) throw new Error(`GET /courses -> ${searchResponse.status}: ${JSON.stringify(searchJson)}`);
  const { courses } = parse(searchCoursesResponseSchema, searchJson);
  if (courses.some((c) => c.name === name)) return; // already seeded by a prior run

  const body = parse(createCourseRequestSchema, { name, tee: teeSet, enteredBy: "field-test-setup" });
  const createResponse = await fetch(`${httpUrl}/courses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const createJson: unknown = await createResponse.json();
  if (!createResponse.ok) throw new Error(`POST /courses -> ${createResponse.status}: ${JSON.stringify(createJson)}`);
  parse(createCourseResponseSchema, createJson); // shape-check only — step 1's own search UI is what finds it
};

// --- Cal/Dee's out-of-browser joins ---------------------------------------------------------

// Joins the round the same way JoinRoundPage's own submit handler does, but via a direct
// fetch instead of a browser (brief step 2: joining Cal/Dee through context A would overwrite
// Ann's localStorage credential for the round — `swng:credential:<roundId>` is one key per
// round per browser, not per golfer).
export const joinRoundDirect = async (
  httpUrl: string,
  input: { readonly code: string; readonly name: string; readonly tee: string; readonly courseHandicap: number },
): Promise<JoinRoundResponse> => {
  const body = parse(joinRoundRequestSchema, input);
  const response = await fetch(`${httpUrl}/rounds/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json: unknown = await response.json();
  if (!response.ok) throw new Error(`POST /rounds/join -> ${response.status}: ${JSON.stringify(json)}`);
  return parse(joinRoundResponseSchema, json);
};

// --- The deck as the oracle: expected UI strings, derived, not hand-copied -----------------

const { players, fourball, skins, scores, corrections } = fieldDeck18;

// Same truncation idiom as fieldDeck18.test.ts/describeGame.test.ts's own `thru`/thru16
// helpers — a mid-round snapshot is the same deck cut off after hole n.
const truncate = (n: number): FixtureScores => Object.fromEntries(Object.entries(scores).map(([golfer, holes]) => [golfer, holes.slice(0, n)]));

// Rebuilds the RoundState the deck's own scores (thru n, with or without the h9 correction)
// fold to — mirrors describeGame.test.ts's own `playRound` helper. This is what lets the
// spec assert against text derived from the SAME domain engines the real app's session runs,
// rather than a hand-typed expectation that could silently drift from either.
const roundThru = (n: number, withCorrection: boolean): RoundState => {
  const events = playGoldenRoundLog(fixtureLinks18, players, [fourball, skins], truncate(n), withCorrection ? corrections : [], false);
  return reduceRound(events);
};

// The fourball-match chip/digest line at hole n (with or without the h9 correction folded in).
export const describeFourballAt = (n: number, withCorrection: boolean): string => {
  const round = roundThru(n, withCorrection);
  return describeGame(scoreGame(fourball, round), round).line;
};

// The skins chip/digest line at hole n (with or without the h9 correction folded in) — this
// is what lets the spec assert B's stale offline view (thru 12, correction withheld, since B
// never received it) and A's/B's post-reconnect refold (thru 12, correction applied) without
// either being a hand-typed string.
export const describeSkinsAt = (n: number, withCorrection: boolean): string => {
  const round = roundThru(n, withCorrection);
  return describeGame(scoreGame(skins, round), round).line;
};

// name -> the deck's own golferId key ("ann"/"bo"/"cal"/"dee") for indexing into
// fieldDeck18.scores — derived from fieldDeck18.players rather than a second hand-authored
// name map, so a deck edit can't silently desync this from the actual roster.
export const golferKeyFor = (name: string): GolferId => {
  const found = players.find((p) => p.name === name);
  if (!found) throw new Error(`no fieldDeck18 player named "${name}"`);
  return found.golferId;
};

export const scoreFor = (name: string, hole: number): number | "picked-up" | "conceded" => {
  const value = fieldDeck18.scores[golferKeyFor(name)]?.[hole - 1];
  if (value === undefined || value === null) throw new Error(`fieldDeck18 has no hole ${hole} score for ${name}`);
  return value;
};

export const correctedScore = (golferName: string, hole: number): number | "picked-up" | "conceded" => {
  const found = corrections.find((c) => c.golfer === golferKeyFor(golferName) && c.hole === hole);
  if (!found) throw new Error(`no fieldDeck18 correction for ${golferName} hole ${hole}`);
  return found.score;
};

export const PLAYER_NAMES = ["Ann", "Bo", "Cal", "Dee"] as const;

// --- UI interaction: the two-tap contract, everywhere -------------------------------------

const scoreButtonText = (score: number | "picked-up" | "conceded"): string =>
  score === "picked-up" ? "Picked up" : score === "conceded" ? "Conceded" : String(score);

// A hole-complete digest overlay (role="status", fixed at the bottom of the viewport, z-40)
// sits ABOVE the scorecard grid in stacking order — the grid itself only auto-dismisses it on
// the NEXT score entry (a cells change), never on merely opening a cell's pad, so a lingering
// digest can block the very next tap. Dismissed here before every entry, not just where a
// digest is expected, since exactly which hole a batch collapses onto (Task 6: highest newly-
// completed hole) isn't always the caller's to predict.
const clearDigestIfPresent = async (page: Page): Promise<void> => {
  const digest = page.getByRole("status", { name: /^After hole / });
  if ((await digest.count()) === 0) return;
  if (await digest.first().isVisible()) {
    await digest.first().getByRole("button", { name: "Dismiss" }).click();
  }
};

// The two-tap contract (product.md §9), literally: exactly two `.click()` calls take the grid
// from idle to a posted score, and the pad closes on the second one — no separate confirm
// step. Every score entry in the spec goes through this one function, so the M5 Task 7 brief's
// "assert exactly two click() calls on one representative entry" holds for every entry, not
// just the one the spec calls out explicitly.
export const enterScore = async (page: Page, golferName: string, hole: number, score: number | "picked-up" | "conceded"): Promise<void> => {
  await clearDigestIfPresent(page);

  // exact: true throughout — "hole 1" is a substring of "hole 10".."hole 18" (and the dialog's
  // "hole 1" likewise), so a non-exact name match would resolve to every one of them at once.
  const cell = page.getByRole("button", { name: `${golferName} hole ${hole}`, exact: true });
  await cell.click(); // tap 1

  const dialog = page.getByRole("dialog", { name: `Score for ${golferName}, hole ${hole}`, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: scoreButtonText(score), exact: true }).click(); // tap 2

  await expect(dialog).toBeHidden(); // no confirm step: the pad closes on the posting tap itself

  // The cell's rendered text is dots (●, non-digit) + the score glyph + an optional net digit,
  // concatenated with no separators (e.g. "●65" — 1 dot, gross 6, net 5) — for a numeric score
  // (always exactly one digit; ScorePad only ever offers 1-12), matching on "the first digit in
  // the text" is what keeps this from a false-positive match against the net span's own digit
  // (e.g. posting 7 with 2 dots renders net 5, so a bare `toContainText("5")` would wrongly
  // pass even though 5 was never the posted score — but net can never be the FIRST digit).
  if (score === "picked-up") await expect(cell).toContainText("PU");
  else if (score === "conceded") await expect(cell).toContainText("CN");
  else await expect(cell).toHaveText(new RegExp(`^\\D*${score}`));
};

// --- Setup: reading the join code, waiting on cross-context participant/game propagation ----

// SetupPanel's own layout: "Join code" label, then the code itself, as adjacent <p>s — no ARIA
// name/testid on either, so a structural (following-sibling) lookup is the reliable way to grab
// it, same convention as ../src/round/SetupPanel.tsx. fieldTest.spec.ts's own step 1 keeps its
// established inline version of this same xpath (untouched, per this milestone's field-test-
// upkeep scope) — this export exists for courseEntry.spec.ts's own single-context flow, so any
// NEW caller has one place to get it from rather than a third copy.
export const readJoinCode = async (page: Page): Promise<string> => {
  const joinCodeCell = page.locator("xpath=//p[normalize-space(text())='Join code']/following-sibling::p[1]");
  await expect(joinCodeCell).toBeVisible();
  const code = ((await joinCodeCell.textContent()) ?? "").trim();
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  return code;
};

// --- Setup: waiting on cross-context participant/game propagation --------------------------

// Waits until `name` has propagated into this page's own folded round state (via WS/pull) —
// needed before driving a <select> whose <option>s come from state.participants (e.g.
// AddGameForm's side pickers), since Cal/Dee joined out-of-browser and their
// participant-joined events reach context A asynchronously.
export const waitForParticipant = async (page: Page, name: string): Promise<void> => {
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
};

// --- WS proxy: routes traffic through Playwright so a socket can be force-closed on demand ---

// context.setOffline(true) alone does NOT close an already-open WebSocket in Chromium (CDP's
// offline emulation blocks NEW network activity — including new WebSocket upgrades — but
// doesn't tear down a connection that's already established, verified against the real beta WS
// endpoint before wiring this in). It DOES reliably block fetch/XHR, so it's still what makes a
// dark context's push/pull fail. To also get the client-visible "disconnected" state (offline
// banner, the reconnect affordance) — which real network loss WOULD produce, by actually
// severing the TCP connection — WS traffic is routed through routeWebSocket so the socket can be
// closed on demand, exactly like a dropped connection: the client's own onclose fires for real,
// flipping connected() false.
//
// An earlier design (task-6-report.md's "Fix wave: harness zombie-socket watchdog") tried to
// INFER a dead socket from receive silence — a debounced inactivity timer that force-closed a
// connection after N seconds without an upstream message. That turned out to be a design flaw,
// not a tuning problem: a receive-only socket has LEGITIMATE multi-second silence between
// scoring bursts, and especially during a recovery wait itself (a 10s digest wait carries zero
// traffic by design), so the watchdog could force-close a perfectly healthy socket mid-recovery —
// racing a fresh reconnect against an in-flight pull and burning the bounded retry on a false
// positive (m6-gate-field-3.log: step 7's recovery fired and passed; step 8's fired but the
// re-assert still failed; total run 47.6s vs ~19s baseline — two 10s recovery waits, the
// signature of exactly this race). Inactivity cannot distinguish dead from quiet without an
// application heartbeat, and there is none, so the watchdog has been removed entirely.
//
// What remains is event-driven, not inferred: `server.onClose` below mirrors an OBSERVED upstream
// close onto the client-visible socket (no false positives — it only fires on a real close), and
// `expectOrRecover` (below) is the sole place recovery gets triggered — deterministically, from
// the assertion itself timing out, by directly force-closing the page's OWN proxied socket via
// `WsRouteHandle` rather than waiting to see whether the client "notices" on its own.
export interface WsRouteHandle {
  current: WebSocketRoute | undefined;
}

// Wires `context`'s WebSocket traffic through a routeWebSocket proxy. `handle.current` is kept
// pointed at the LATEST connection for this context — Playwright re-invokes this handler fresh
// per connection (including reconnects), so a caller holding `handle` can always force-close
// whatever socket is live right now, never a stale reference to a connection that already closed.
export const installWsProxy = async (context: BrowserContext, handle: WsRouteHandle): Promise<void> => {
  await context.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => ws.send(message));
    // Event-driven, not inferred: if the upstream leg itself closes, mirror that onto the
    // client-visible socket. No false positives — this only fires on an observed close.
    server.onClose(() => void ws.close().catch(() => {}));
    handle.current = ws;
  });
};

// --- Deterministic announced-recovery wrapper for cross-context WS-dependent assertions ----

// Any assertion that depends on ONE context receiving events pushed by the OTHER over WS is
// exposed to a WS push silently never arriving (delivery loss, not a product bug — see the WS
// proxy note above). Recovery here is deterministic, not inferred: on an assertion timeout, this
// FORCES the page's own proxied socket closed via `routeHandle` — no banner-gating, no guessing
// whether the client has "noticed" yet — which reliably flips connected() false and renders the
// Offline banner + Sync-now button (StatusChrome.tsx renders that button only inside its
// `!connected` block), then clicks Sync-now (the same recovery a real golfer has: a full HTTP
// pull, the sole cursor authority) and re-asserts the SAME `expect(...)` the caller built — same
// locator, same expected value; nothing about assertion strength changes.
//
// Bounded retry: up to two announced force-close+Sync-now cycles. A Sync-now pull is idempotent
// and authoritative, so repeated pulls converge on server truth — a genuine product mismatch
// still fails truthfully after both cycles (nothing here can paper over a real defect), while a
// transient race (e.g. a pull landing before the other page's own in-flight POST) gets a second
// chance to resolve. The announcement (console.log + a "ws-fallback" annotation) is pushed BEFORE
// each force-close, matching this suite's existing precedent. After the final cycle, a failure is
// rethrown as a labeled error (with the original assertion failure preserved via `cause`) instead
// of a bare, unrelated-looking locator timeout.
const MAX_RECOVERY_ATTEMPTS = 2;

export const expectOrRecover = async (page: Page, label: string, assert: () => Promise<void>, routeHandle: WsRouteHandle): Promise<void> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RECOVERY_ATTEMPTS; attempt += 1) {
    try {
      await assert();
      return;
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RECOVERY_ATTEMPTS) break; // recovery cycles exhausted

      console.log(
        `[fieldTest] ${label}: assertion did not arrive — force-closing the socket and recovering via Sync now (cycle ${attempt + 1}/${MAX_RECOVERY_ATTEMPTS})`,
      );
      test.info().annotations.push({
        type: "ws-fallback",
        description: `${label}: recovery cycle ${attempt + 1} — forced socket close + Sync-now`,
      });

      await routeHandle.current?.close().catch(() => {}); // deterministically flips connected() false
      const syncNow = page.getByRole("button", { name: "Sync now" });
      await expect(syncNow).toBeVisible({ timeout: 15_000 });
      await syncNow.click();
    }
  }

  throw new Error(`${label}: assertion still failing after ${MAX_RECOVERY_ATTEMPTS} force-close+Sync-now recovery cycles`, { cause: lastError });
};

// WS is delivery sugar, not the correctness path (architecture.md §3) — this session has no
// periodic pull, so if a push is ever silently lost, the ONLY thing that recovers a live tab is
// the same user-visible "Sync now" affordance StatusChrome ships (session/useRoundSession.ts's
// own connect()+sync()). Used for the round's finalize — the one WS-arrival wait in this spec
// with enough elapsed real time and backend work (settleRound + the archive write) for a rare
// delivery hiccup to matter.
export const waitForFinalOrRecover = async (page: Page, routeHandle: WsRouteHandle): Promise<void> => {
  const finalHeading = page.getByRole("heading", { name: "Final results" });
  await expectOrRecover(page, "Final results", () => expect(finalHeading).toBeVisible({ timeout: 45_000 }), routeHandle);
};

// Same recovery pattern as waitForFinalOrRecover just above, for a mid-round hole-complete
// digest instead of the finalize heading — the same delivery-loss risk (WS proxy note above) can
// just as easily strand a digest push as a finalize push; step 7's hole-16 digest wait had no
// fallback until this was added, unlike steps 6/9. `digestName` is a substring match against the
// digest's own accessible name (e.g. "After hole 16"), same as the bare locator step 7 used
// before this helper existed.
export const waitForDigestOrRecover = async (page: Page, digestName: string, routeHandle: WsRouteHandle): Promise<void> => {
  const digest = page.getByRole("status", { name: digestName });
  await expectOrRecover(page, `"${digestName}" digest`, () => expect(digest).toBeVisible({ timeout: 10_000 }), routeHandle);
};

// <select>s only, never getByLabel — Playwright's getByLabel match text for a <label> wrapping
// a <select> includes the currently-DISPLAYED option's own text (e.g. "CourseFixture Links",
// the label's own text concatenated with the collapsed dropdown's visible value), not just the
// label's literal text, so an exact match against just "Course" finds nothing and a substring
// match over-matches (e.g. "Course" also substring-matches "Course handicap"). getByRole's
// accessible-name computation for the CONTROL itself doesn't have this contamination — the
// combobox's own name is cleanly "Course", excluding its own displayed option text.
export const gameKindSelect = (page: Page) => page.getByRole("combobox", { name: "Kind", exact: true });

export const addFourballGame = async (
  page: Page,
  sides: { readonly a1: string; readonly a2: string; readonly b1: string; readonly b2: string },
): Promise<void> => {
  await gameKindSelect(page).selectOption({ value: "fourball-match" });
  await page.getByRole("combobox", { name: "Side A – Player 1", exact: true }).selectOption({ label: sides.a1 });
  await page.getByRole("combobox", { name: "Side A – Player 2", exact: true }).selectOption({ label: sides.a2 });
  await page.getByRole("combobox", { name: "Side B – Player 1", exact: true }).selectOption({ label: sides.b1 });
  await page.getByRole("combobox", { name: "Side B – Player 2", exact: true }).selectOption({ label: sides.b2 });
  await page.getByRole("button", { name: "Add game" }).click();
};

export const addSkinsGame = async (page: Page, names: readonly string[]): Promise<void> => {
  await gameKindSelect(page).selectOption({ value: "skins" });
  const group = page.getByRole("group", { name: "Players" });
  for (const name of names) {
    await group.getByLabel(name, { exact: true }).check();
  }
  await page.getByRole("button", { name: "Add game" }).click();
};

// StandingsHeader's chip text is the CONCATENATION of two adjacent <span>s (title, line) with
// no separating whitespace in the DOM — using the computed accessible NAME (which may insert
// its own separator depending on the browser's accname algorithm) would be a fragile way to
// assert on it. `.filter({ hasText })` + raw textContent-based matchers sidestep that.
export const chip = (page: Page, titlePrefix: string) => page.getByRole("tab").filter({ hasText: titlePrefix });
