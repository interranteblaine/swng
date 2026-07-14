import { afterAll, describe, expect, it } from "vitest";
import WS from "ws";
import { addGameResponseSchema, finalizeRoundResponseSchema, joinRoundResponseSchema, startRoundResponseSchema } from "@swng/contracts";
import type { FinalizeRoundResponse } from "@swng/contracts";
import { createHttpTransport, createRoundSession } from "@swng/client";
import type { RoundSession } from "@swng/client";
import { cellKey, deviceId, fixtureLinks, resultOf } from "@swng/domain";
import type { GameResult, GameState, GolferId, HoleResult, RoundId } from "@swng/domain";
import { apiUrl, loadEndpoints, mintAccountGolfer, post, waitUntil } from "./support/client.js";

// The M2 golden stableford deck for two golfers — reproduced verbatim from
// packages/domain/src/scoring/stableford.test.ts. The card and its 15/19 lines are pinned by the domain golden fixture
// (`packages/domain/src/scoring/stableford.test.ts`) and exercised in-memory by
// `application/src/rounds/roundSlice.test.ts` and `packages/client/src/session.test.ts`;
// THIS suite is what first proves them over the wire, offline queueing included. Ann (courseHandicap 8) and Bo (courseHandicap 2),
// white tees, one stableford game referencing both. Ann's h4 is a pickup. This suite's whole
// point is proving that the SAME Ann 15 / Bo 19 numbers survive a real offline outbox drained
// over the real deployed stack — not deriving them fresh.
const ANN_CARD: readonly (number | "picked-up")[] = [5, 6, 3, "picked-up", 5, 4, 5, 6, 5];
const BO_CARD: readonly number[] = [4, 4, 3, 5, 5, 3, 4, 5, 4];
const GOLDEN_LINES = [
  { thru: 9, points: 15 }, // Ann
  { thru: 9, points: 19 }, // Bo
];

const toHoleResult = (score: number | "picked-up"): HoleResult => (score === "picked-up" ? { kind: "picked-up" } : { kind: "strokes", strokes: score });

const stablefordStateOf = (games: readonly GameState[]): Extract<GameState, { kind: "stableford" }> => {
  const found = games.find((game): game is Extract<GameState, { kind: "stableford" }> => game.kind === "stableford");
  if (!found) throw new Error("no stableford game in session.games()");
  return found;
};

const stablefordResultOf = (results: readonly GameResult[]): Extract<GameResult, { kind: "stableford" }> => {
  const found = results.find((result): result is Extract<GameResult, { kind: "stableford" }> => result.kind === "stableford");
  if (!found) throw new Error("no stableford result in finalize response");
  return found;
};

// A `fetch` wrapper whose offline toggle rejects BEFORE the request ever reaches the wire —
// the same failure shape a real network outage takes (both browser fetch and Node's
// undici-backed global fetch reject with a TypeError for a network-level failure), which is
// exactly what transport.ts's requestJson catches and maps to TransportError("network"). The
// session's queue-not-lose-work behavior (session.ts: isTransientPushFailure) is what this
// test is actually exercising, so the toggle has to fail the SAME way a dead network would.
interface ToggleableFetch {
  readonly fetchImpl: typeof fetch;
  setOffline(offline: boolean): void;
}

const createToggleableFetch = (): ToggleableFetch => {
  let offline = false;
  const fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => {
    if (offline) return Promise.reject(new TypeError("kill-network test: fetch disabled while offline"));
    return fetch(...args);
  };
  return { fetchImpl, setOffline: (value: boolean) => (offline = value) };
};

describe("kill-network sync gate: two real createRoundSessions over the deployed beta stack", () => {
  const { httpUrl, wsUrl } = loadEndpoints();
  const rounds = (path = ""): string => apiUrl(httpUrl, `/rounds${path}`);
  const webSocketCtor = WS as unknown as new (url: string) => WebSocket;

  let roundId!: RoundId;
  let annId!: GolferId;
  let boId!: GolferId;
  let tokenAnn!: string;
  let tokenBo!: string;

  let bo!: ToggleableFetch;
  let sessionA!: RoundSession; // Ann's phone — never goes offline
  let sessionB!: RoundSession; // Bo's phone — goes dark in step 4

  let finalize!: FinalizeRoundResponse;

  afterAll(async () => {
    sessionA?.disconnect();
    sessionB?.disconnect();
    await sessionA?.close();
    await sessionB?.close();
  });

  // Step 1: create the round + join, entirely through the existing HTTP e2e harness (no
  // session involved yet) — Ann host ch 8, Bo ch 2, white tees, one stableford game.
  // Accounts-only (the wall): Ann and Bo are both signed-in accounts — minted, named via
  // PUT /me, starting/joining as themselves with their own Bearers. The seat is resolved
  // server-side from each Bearer (ensureGolfer), so the request carries no name/golferId.
  it("1: Ann and Bo sign up; Ann starts the round as herself, Bo joins as himself; the stableford game is added", async () => {
    const annAccount = await mintAccountGolfer(httpUrl, "sync-ann", "Ann");
    const boAccount = await mintAccountGolfer(httpUrl, "sync-bo", "Bo");

    const started = await post(rounds(), { card: fixtureLinks, host: { tee: "white", courseHandicap: 8 } }, startRoundResponseSchema, annAccount.idToken);
    roundId = started.roundId;
    annId = started.golferId;
    tokenAnn = started.token;
    expect(annId).toBe(annAccount.golferId); // as-self: the host seat is the account's own golfer

    const joined = await post(rounds("/join"), { code: started.joinCode, tee: "white", courseHandicap: 2 }, joinRoundResponseSchema, boAccount.idToken);
    boId = joined.golferId;
    tokenBo = joined.token;
    expect(boId).toBe(boAccount.golferId);

    const added = await post(rounds(`/${roundId}/games`), { game: { kind: "stableford", players: [annId, boId] } }, addGameResponseSchema, tokenAnn);
    expect(added.gameId).toBeDefined();
  });

  // Step 2: two REAL createRoundSessions over createHttpTransport, real HTTP + real WS
  // (ws package), both connect() then an initial sync() to catch up on genesis.
  it("2: builds two real sessions over createHttpTransport; both connect() + initial sync()", async () => {
    bo = createToggleableFetch();

    const transportA = createHttpTransport({ httpUrl, wsUrl, roundId, token: tokenAnn, webSocketCtor });
    const transportB = createHttpTransport({ httpUrl, wsUrl, roundId, token: tokenBo, fetchImpl: bo.fetchImpl, webSocketCtor });

    sessionA = await createRoundSession({ transport: transportA, roundId, golferId: annId, deviceId: deviceId("ann-phone") });
    sessionB = await createRoundSession({ transport: transportB, roundId, golferId: boId, deviceId: deviceId("bo-phone") });

    sessionA.connect();
    sessionB.connect();
    await sessionA.sync();
    await sessionB.sync();

    expect(sessionA.connected()).toBe(true);
    expect(sessionB.connected()).toBe(true);
    expect(sessionA.state().participants).toHaveLength(2);
    expect(sessionB.state().participants).toHaveLength(2);
  });

  // Step 3: A records Ann's front three; B must converge purely via its own socket delivery
  // — B never calls sync() in this step, so a pass here can only be explained by the WS push.
  it("3: A records Ann's front three; B converges over the socket alone", async () => {
    sessionA.recordScore(annId, 1, toHoleResult(ANN_CARD[0]!));
    sessionA.recordScore(annId, 2, toHoleResult(ANN_CARD[1]!));
    sessionA.recordScore(annId, 3, toHoleResult(ANN_CARD[2]!));
    await sessionA.sync(); // push all three, pull the confirmed copies back

    await waitUntil(() => [1, 2, 3].every((hole) => sessionB.state().cells[cellKey(annId, hole)] !== undefined), {
      timeoutMs: 20_000,
      label: "B's socket delivers Ann's front three without B ever calling sync()",
    });

    for (let hole = 1; hole <= 3; hole += 1) {
      expect(sessionB.state().cells[cellKey(annId, hole)]).toMatchObject({ result: toHoleResult(ANN_CARD[hole - 1]!) });
    }
  });

  // Step 4: kill B's network — toggle its fetch wrapper to throw AND close its socket — then
  // B records Bo's full card entirely offline. pending() must be exactly 9 (nothing pushed),
  // and B's own local fold must already resolve Bo's stableford line to 19, independent of
  // Ann's still-incomplete card (stableford scores each golfer's line off their own thru).
  it("4: kills B's network; B records Bo's full card offline — pending()===9, local games() already shows Bo 19", () => {
    bo.setOffline(true);
    sessionB.disconnect();
    expect(sessionB.connected()).toBe(false);

    for (let hole = 1; hole <= 9; hole += 1) {
      sessionB.recordScore(boId, hole, toHoleResult(BO_CARD[hole - 1]!));
    }

    expect(sessionB.pending()).toBe(9);
    expect(stablefordStateOf(sessionB.games()).lines).toContainEqual({ golferId: boId, thru: 9, points: 19 });
  });

  // Step 5: while B is dark, A keeps scoring — Ann's remaining card including the h4 pickup.
  // Only Ann's own cells are recorded here (score-for-anyone is already exercised by the M3
  // e2e suite; this test isolates offline convergence).
  it("5: while B is dark, A finishes Ann's remaining card, including the h4 pickup", async () => {
    for (let hole = 4; hole <= 9; hole += 1) {
      sessionA.recordScore(annId, hole, toHoleResult(ANN_CARD[hole - 1]!));
    }
    await sessionA.sync();

    expect(stablefordStateOf(sessionA.games()).lines).toContainEqual({ golferId: annId, thru: 9, points: 15 });
  });

  // Step 6: restore B's network, connect() + sync() — the offline burst drains (pending 0,
  // rejected 0), and — now that both golfers' full cards exist somewhere in the system — both
  // sessions must converge on the M2 golden numbers and land on byte-identical state(), no
  // matter that they got there via completely different arrival orders (A: live via A's own
  // pushes + B's late drain over the socket; B: local pending all along, now confirmed).
  it("6: restores B's network; the queue drains and both sessions converge on the golden numbers", async () => {
    bo.setOffline(false);
    sessionB.connect();
    await sessionB.sync();

    expect(sessionB.pending()).toBe(0);
    expect(sessionB.rejected()).toHaveLength(0);

    await waitUntil(
      () => {
        const a = stablefordStateOf(sessionA.games());
        const b = stablefordStateOf(sessionB.games());
        return a.complete && b.complete && a.lines.every((line, i) => line.thru === GOLDEN_LINES[i]!.thru && line.points === GOLDEN_LINES[i]!.points)
          && b.lines.every((line, i) => line.thru === GOLDEN_LINES[i]!.thru && line.points === GOLDEN_LINES[i]!.points);
      },
      { timeoutMs: 30_000, label: "both sessions converge on the golden stableford numbers" },
    );

    const stablefordA = stablefordStateOf(sessionA.games());
    const stablefordB = stablefordStateOf(sessionB.games());
    expect(stablefordA.lines).toEqual([
      { golferId: annId, thru: 9, points: 15 },
      { golferId: boId, thru: 9, points: 19 },
    ]);
    expect(stablefordB.lines).toEqual(stablefordA.lines);
    expect(stablefordA.complete).toBe(true);
    expect(stablefordB.complete).toBe(true);

    // Full reduced RoundState is byte-identical across the two sessions — proof of
    // convergence, not just of this one game's derived numbers.
    expect(sessionA.state()).toEqual(sessionB.state());
  });

  // Step 7: finalize via the HTTP harness; the settled response must match what both sessions
  // already independently derived locally (resultOf over the same GameState shape finalize
  // itself settles from server-side).
  it("7: finalize via the HTTP harness matches both sessions' games()", async () => {
    finalize = await post(rounds(`/${roundId}/finalize`), undefined, finalizeRoundResponseSchema, tokenAnn);

    const finalizedStableford = stablefordResultOf(finalize.results);
    const resultFromA = resultOf(stablefordStateOf(sessionA.games()));
    const resultFromB = resultOf(stablefordStateOf(sessionB.games()));

    expect(resultFromA).toEqual(finalizedStableford);
    expect(resultFromB).toEqual(finalizedStableford);
  });

  // Step 8 (re-runnability) needs no extra code: every run above starts a brand-new round via
  // POST /rounds, so nothing here depends on a fixed roundId, join code, or prior server state.
});
