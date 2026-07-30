import { afterAll, describe, expect, it } from "vitest";
import {
  addGameResponseSchema,
  eventsResponseSchema,
  finalizeRoundResponseSchema,
  getRoundArchiveResponseSchema,
  joinRoundResponseSchema,
  recordScoreResponseSchema,
  setBasisResponseSchema,
  startRoundResponseSchema,
} from "@swng/contracts";
import type { AddGameRequest, FinalizeRoundResponse, RecordScoreRequest, SetBasisRequest } from "@swng/contracts";
import { fixtureLinks, reduceRound, resultOf, scoreGame } from "@swng/domain";
import type { GameResult, GolferId, HoleResult, RoundEvent, RoundId } from "@swng/domain";
import { apiUrl, connectWs, createClientOps, ensureCourse, get, loadEndpoints, mintAccountGolfer, post, waitUntil } from "./support/client.js";
import type { ClientOps, WsClient } from "./support/client.js";

// The M2 golden concurrency deck, reproduced verbatim (packages/domain/src/scoring/concurrent.test.ts)
// — same players, same handicaps, same nine-hole cards, same correction, same hand-verified
// post-correction numbers. This suite's whole point is proving the deployed server (not just
// the domain library) reaches those exact numbers over the wire.
//
// Accounts-only (the wall): all three golfers are signed-in accounts — Ann/Bo/Cal each mint a
// throwaway Cognito user, name themselves via PUT /me, and start/join with their own Bearers
// (self-join is the only way onto a card). Everything AFTER the seeding is unchanged: two
// "phones" (client op streams + sockets), score-for-anyone, the same golden numbers.
const ANN_CARD: readonly (number | "picked-up")[] = [5, 5, 4, 6, 5, 4, 5, 6, "picked-up"];
const BO_CARD: readonly number[] = [4, 5, 3, 6, 4, 4, 4, 5, 4];
const CAL_CARD: readonly number[] = [6, 7, 4, 8, 6, 5, 6, 7, 6];

const toHoleResult = (score: number | "picked-up"): HoleResult => (score === "picked-up" ? { kind: "picked-up" } : { kind: "strokes", strokes: score });

const scoreRecordedEvents = (events: readonly RoundEvent[]): readonly Extract<RoundEvent, { kind: "score-recorded" }>[] =>
  events.filter((event): event is Extract<RoundEvent, { kind: "score-recorded" }> => event.kind === "score-recorded");

const scoreKeys = (events: readonly RoundEvent[]): Set<string> => new Set(scoreRecordedEvents(events).map((event) => `${event.golferId}#${event.hole}`));

const skinsResultOf = (results: readonly GameResult[]): Extract<GameResult, { kind: "skins" }> => {
  const found = results.find((result): result is Extract<GameResult, { kind: "skins" }> => result.kind === "skins");
  if (!found) throw new Error("no skins result in finalize response");
  return found;
};

const stablefordResultOf = (results: readonly GameResult[]): Extract<GameResult, { kind: "stableford" }> => {
  const found = results.find((result): result is Extract<GameResult, { kind: "stableford" }> => result.kind === "stableford");
  if (!found) throw new Error("no stableford result in finalize response");
  return found;
};

describe("deployed vertical slice: the M2 concurrency deck over the wire", () => {
  const { httpUrl, wsUrl } = loadEndpoints();
  const rounds = (path = ""): string => apiUrl(httpUrl, `/rounds${path}`);

  let roundId!: RoundId;
  let joinCode!: string;
  let token1!: string; // Ann's phone — host
  let annId!: GolferId;
  let token2!: string; // Bo's phone — scores for Bo AND Cal (score-for-anyone)
  let boId!: GolferId;
  let calId!: GolferId;
  let ws1!: WsClient;
  let ws2!: WsClient;
  let annPhone!: ClientOps;
  let boPhone!: ClientOps;
  let boH1Body!: RecordScoreRequest;
  let finalize1!: FinalizeRoundResponse;

  afterAll(() => {
    ws1?.close();
    ws2?.close();
  });

  // Step 1: Ann signs up, then client 1 (her phone) starts the round as herself and opens its
  // socket. The host seat is her account's own golfer — resolved server-side from her Bearer
  // (ensureGolfer), so the request carries no name/golferId.
  it("1: Ann's account starts the round as herself", async () => {
    const ann = await mintAccountGolfer(httpUrl, "slice-ann", "Ann");
    // Course-cards spec §4: StartRound resolves a REFERENCE now — seed the lineage via the
    // public course API (search-first, create-if-absent — apps/web/e2e/support.ts's own
    // ensureCourse idiom, mirrored here), then pass it through.
    const course = await ensureCourse(httpUrl, fixtureLinks.courseName, fixtureLinks, ann);
    const started = await post(rounds(), { course, host: { tee: "white", basis: { kind: "normally-shoots", overPar: 8 } } }, startRoundResponseSchema, ann.idToken);
    roundId = started.roundId;
    joinCode = started.joinCode;
    token1 = started.token;
    annId = started.golferId;
    expect(annId).toBe(ann.golferId); // as-self: the host seat IS the account's golfer, never a fresh id

    ws1 = await connectWs(wsUrl, token1);
  });

  // Step 2: Bo and Cal each sign up and join as THEMSELVES (self-join is the only way onto a
  // card), but client 2 is still ONE phone with ONE socket — Bo's — which scores for both of
  // them from step 4 on (score-for-anyone). Cal's own join exists to hold his seat, nothing
  // more; his participant token is never used.
  it("2: Bo and Cal join as themselves; client 2 (Bo's phone) opens its one socket", async () => {
    const boAccount = await mintAccountGolfer(httpUrl, "slice-bo", "Bo");
    const calAccount = await mintAccountGolfer(httpUrl, "slice-cal", "Cal");

    const bo = await post(rounds("/join"), { code: joinCode, tee: "white", basis: { kind: "normally-shoots", overPar: 2 } }, joinRoundResponseSchema, boAccount.idToken);
    // The join response echoes the canonical code (spec 2026-07-20: token implies code); the
    // re-mint arm of the same invariant is proven in the browser (basisCorrection.spec).
    expect(bo.joinCode).toBe(joinCode);
    token2 = bo.token;
    boId = bo.golferId;
    expect(boId).toBe(boAccount.golferId);

    const cal = await post(rounds("/join"), { code: joinCode, tee: "white", basis: { kind: "normally-shoots", overPar: 12 } }, joinRoundResponseSchema, calAccount.idToken);
    calId = cal.golferId;
    expect(calId).toBe(calAccount.golferId);

    ws2 = await connectWs(wsUrl, token2);

    annPhone = createClientOps("ann-phone");
    boPhone = createClientOps("bo-phone");
  });

  // Step 3: client 1 adds both games over the now-3-participant roster. Both bodies are typed
  // AddGameRequest deliberately: `post` takes an `unknown` body, so an untyped literal here would
  // hide a newly-required game field from typecheck and only surface as a 400 on the first live
  // run (which is exactly how skins' own `scoring` was missed once).
  it("3: client 1 adds skins and stableford", async () => {
    const skinsBody: AddGameRequest = { game: { kind: "skins", scoring: "net", players: [annId, boId, calId] } };
    const stablefordBody: AddGameRequest = { game: { kind: "stableford", players: [annId, boId, calId] } };
    const skinsAdded = await post(rounds(`/${roundId}/games`), skinsBody, addGameResponseSchema, token1);
    const stablefordAdded = await post(rounds(`/${roundId}/games`), stablefordBody, addGameResponseSchema, token1);
    expect(skinsAdded.gameId).not.toBe(stablefordAdded.gameId);
  });

  // Steps 4-5: score the deck concurrently — Ann's card from client 1, Bo's AND Cal's cards
  // from client 2 (score-for-anyone), all 27 record calls fired via one Promise.all so the
  // journal's seq-race handling under concurrent appends is actually exercised — then both
  // sockets must cross-receive the events the OTHER client's phone authored.
  it("4-5: scores the deck concurrently; both sockets cross-receive every event", async () => {
    const scoresUrl = rounds(`/${roundId}/scores`);

    const annBodies: RecordScoreRequest[] = ANN_CARD.map((score, i) => ({ golferId: annId, hole: i + 1, result: toHoleResult(score), ...annPhone.next() }));
    const boBodies: RecordScoreRequest[] = BO_CARD.map((score, i) => ({ golferId: boId, hole: i + 1, result: toHoleResult(score), ...boPhone.next() }));
    const calBodies: RecordScoreRequest[] = CAL_CARD.map((score, i) => ({ golferId: calId, hole: i + 1, result: toHoleResult(score), ...boPhone.next() }));
    boH1Body = boBodies[0]!; // kept for step 6's exact-opId re-send

    const results = await Promise.all([
      ...annBodies.map((body) => post(scoresUrl, body, recordScoreResponseSchema, token1)),
      ...boBodies.map((body) => post(scoresUrl, body, recordScoreResponseSchema, token2)),
      ...calBodies.map((body) => post(scoresUrl, body, recordScoreResponseSchema, token2)),
    ]);
    expect(results.every((result) => result.duplicate === false)).toBe(true);

    const annKeys = annBodies.map((body) => `${body.golferId}#${body.hole}`);
    const boKeys = boBodies.map((body) => `${body.golferId}#${body.hole}`);
    const calKeys = calBodies.map((body) => `${body.golferId}#${body.hole}`);

    // Client 1's socket must receive Bo's and Cal's score-recorded events, and client 2's
    // socket must receive Ann's — one wait covering both halves of the cross-receipt so a
    // slow-but-eventual delivery doesn't burn two separate 30s budgets sequentially.
    await waitUntil(
      () => [...boKeys, ...calKeys].every((key) => scoreKeys(ws1.events()).has(key)) && annKeys.every((key) => scoreKeys(ws2.events()).has(key)),
      { timeoutMs: 30_000, label: "both sockets cross-receive the other client's scores" },
    );

    // 27 within the deck: both sockets are subscribed to the round before any score is
    // recorded, and broadcast fans out to every registered connection (not just the
    // author's own) — so each socket ends up observing the full deck, not just its own.
    expect(scoreKeys(ws1.events()).size).toBe(27);
    expect(scoreKeys(ws2.events()).size).toBe(27);
  });

  // Step 6: an exact re-send of a prior opId is a no-op — duplicate:true, and neither socket
  // gets a second copy of that event.
  it("6: duplicate opId re-send is a no-op on both the API and the WS fan-out", async () => {
    const scoresUrl = rounds(`/${roundId}/scores`);
    const duplicateResponse = await post(scoresUrl, boH1Body, recordScoreResponseSchema, token2);
    expect(duplicateResponse).toEqual({ duplicate: true });

    // Proving an absence has no "appear" to poll toward — a short bounded grace window is
    // the only shape this assertion can take (contrast with the poll-with-deadline waits
    // used everywhere else in this file for positive expectations).
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const countWithOpId = (events: readonly RoundEvent[]): number => events.filter((event) => event.opId === boH1Body.opId).length;
    expect(countWithOpId(ws1.events())).toBe(1);
    expect(countWithOpId(ws2.events())).toBe(1);
  });

  // Step 7: the correction — client 2 (Bo's phone) records Ann's h9 as 4 gross with a later
  // hlc than her original "picked-up" (score-for-anyone again).
  it("7: client 2 corrects Ann's h9 to 4 gross", async () => {
    const scoresUrl = rounds(`/${roundId}/scores`);
    const correctionOp = boPhone.next();
    const correctionBody: RecordScoreRequest = { golferId: annId, hole: 9, result: { kind: "strokes", strokes: 4 }, ...correctionOp };

    const correctionResponse = await post(scoresUrl, correctionBody, recordScoreResponseSchema, token2);
    expect(correctionResponse.duplicate).toBe(false);

    await waitUntil(() => ws1.events().some((event) => event.opId === correctionOp.opId) && ws2.events().some((event) => event.opId === correctionOp.opId), {
      timeoutMs: 20_000,
      label: "both sockets observe the correction",
    });
  });

  // Step 8: finalize reproduces the M2 post-correction golden numbers over deployed
  // infrastructure — skins ann 2 / bo 6 / cal 0, carriedOut 1; stableford ann 13 / bo 15 /
  // cal 4; and the response carries no handicapping block at all. Both games' strokes are the difference
  // from the lowest in the field (Bo's 2), halved on this nine-hole card: Ann 3 dots, Bo 0, Cal 5
  // — the same numbers concurrent.test.ts and archive.test.ts hand-derive for this deck.
  it("8: finalize reproduces the M2 post-correction golden numbers", async () => {
    finalize1 = await post(rounds(`/${roundId}/finalize`), undefined, finalizeRoundResponseSchema, token1);

    const skins = skinsResultOf(finalize1.results);
    expect(skins.carriedOut).toBe(1);
    expect(skins.won).toEqual(
      expect.arrayContaining([
        { golferId: annId, skins: 2 },
        { golferId: boId, skins: 6 },
        { golferId: calId, skins: 0 },
      ]),
    );

    const stableford = stablefordResultOf(finalize1.results);
    expect(stableford.points).toEqual(
      expect.arrayContaining([
        { golferId: annId, points: 13 },
        { golferId: boId, points: 15 },
        { golferId: calId, points: 4 },
      ]),
    );

    // `handicapping` (per-participant adjusted gross score + differential) is deleted from this
    // response with the whole WHS pipeline (spec 2026-07-29 §7) — a finalize now returns the settled
    // game results and nothing else.
    expect(finalize1).not.toHaveProperty("handicapping");
  });

  // Step 9: catch-up is the correctness path — GET events?since=0 returns the full log,
  // seqs contiguous from 1; reducing it with @swng/domain's reduceRound and rescoring both
  // games locally must deep-equal the finalize response (client/server parity over the wire),
  // pinning the exact shape (including the `won` array's zero-entry convention) without
  // hand-writing it.
  it("9: GET events since=0 is seq-contiguous and locally refolds to the same result", async () => {
    const fetched = await get(rounds(`/${roundId}/events?since=0`), eventsResponseSchema, token1);
    expect(fetched.events.map((event) => event.seq)).toEqual(fetched.events.map((_, i) => i + 1));

    const state = reduceRound(fetched.events);
    expect(state.status).toBe("final");

    const localResults = state.games.map((config) => {
      const result = resultOf(scoreGame(config, state));
      if (!result) throw new Error(`game ${config.id} (${config.kind}) never resolved locally`);
      return result;
    });

    expect(localResults).toEqual(finalize1.results);
  });

  // Step 10: finalize again is idempotent — identical results, no new event.
  it("10: finalize again returns identical results", async () => {
    const finalize2 = await post(rounds(`/${roundId}/finalize`), undefined, finalizeRoundResponseSchema, token1);
    expect(finalize2).toEqual(finalize1);
  });
});

// Mid-round basis correction (spec 2026-07-20, re-shaped by 2026-07-29): a self-contained scenario with its own
// accounts and its own round — the M2 golden-deck round above is already finalized by the
// time this file's other tests run (steps 8-10), and setBasis throws round-not-live on a
// finalized round (packages/application/src/rounds/setBasis.ts), so this can't reuse any
// of the state above. One `it`, five inline steps, mirroring the task brief's own scenario
// verbatim — the same account-minting/course-seeding/score-posting idioms as the suite above,
// just not threaded through numbered `it`s sharing closure state.
describe("deployed vertical slice: mid-round basis correction", () => {
  const { httpUrl } = loadEndpoints();
  const rounds = (path = ""): string => apiUrl(httpUrl, `/rounds${path}`);
  const holeCount = fixtureLinks.teeSets[0]!.holes.length; // 9 — fixtureLinks is the same 9-hole card the M2 deck above plays

  it("corrects what a player stated mid-round: events carry it, the fold and archive reflect it", async () => {
    // 1. Start a round (host normally shoots +8), join a second account (+2).
    const host = await mintAccountGolfer(httpUrl, "basis-host", "Host");
    const course = await ensureCourse(httpUrl, fixtureLinks.courseName, fixtureLinks, host);
    const started = await post(rounds(), { course, host: { tee: "white", basis: { kind: "normally-shoots", overPar: 8 } } }, startRoundResponseSchema, host.idToken);
    const roundId = started.roundId;
    const hostToken = started.token; // round-scoped participant token — "participant"-gated routes (scores/basis/finalize) take THIS, never the account's own idToken
    const hostId = started.golferId;
    expect(hostId).toBe(host.golferId); // as-self: the host seat IS the account's own golfer

    const guest = await mintAccountGolfer(httpUrl, "basis-guest", "Guest");
    const joined = await post(rounds("/join"), { code: started.joinCode, tee: "white", basis: { kind: "normally-shoots", overPar: 2 } }, joinRoundResponseSchema, guest.idToken);
    const guestToken = joined.token;
    const guestId = joined.golferId;
    expect(guestId).toBe(guest.golferId);

    const hostOps = createClientOps("basis-host-phone");
    const guestOps = createClientOps("basis-guest-phone");
    const scoresUrl = rounds(`/${roundId}/scores`);

    // 2. Score hole 1 for both.
    await post(scoresUrl, { golferId: hostId, hole: 1, result: { kind: "strokes", strokes: 5 }, ...hostOps.next() }, recordScoreResponseSchema, hostToken);
    await post(scoresUrl, { golferId: guestId, hole: 1, result: { kind: "strokes", strokes: 6 }, ...guestOps.next() }, recordScoreResponseSchema, guestToken);

    // 3. POST /rounds/{roundId}/basis as the HOST with { golferId: <second>, basis: +13 }.
    //    Assert 200 and events[0].kind === "participant-basis-set". (`post()` itself throws
    //    on a non-2xx status — see e2e/support/client.ts's own httpError — so a resolved call
    //    here already IS the 200 assertion; the response body is what's left to check.)
    const correctionRequest: SetBasisRequest = { golferId: guestId, basis: { kind: "normally-shoots", overPar: 13 } };
    const setResponse = await post(rounds(`/${roundId}/basis`), correctionRequest, setBasisResponseSchema, hostToken);
    expect(setResponse.events).toHaveLength(1);
    expect(setResponse.events[0]?.kind).toBe("participant-basis-set");

    // 4. GET events → fold with reduceRound → the second seat's stated basis is the corrected +13,
    //    its DERIVED strokes moved with it, departed undefined, name/tee untouched.
    //
    //    Hand-derived (spec 2026-07-29 §2b, this 9-hole card): the guest's +2 anchored the field
    //    at join, so the correction to +13 makes the host's +8 the lowest — the host drops to 0
    //    and the guest takes (13 − 8) / 2 = 2.5 → 3, halved once at the end and rounded half-up.
    const midRoundEvents = await get(rounds(`/${roundId}/events?since=0`), eventsResponseSchema, hostToken);
    const midRoundState = reduceRound(midRoundEvents.events);
    const guestSeatMidRound = midRoundState.participants.find((p) => p.golferId === guestId);
    if (!guestSeatMidRound) throw new Error("guest seat missing from the folded roster after the correction");
    expect(guestSeatMidRound.basis).toEqual({ kind: "normally-shoots", overPar: 13 });
    expect(guestSeatMidRound.strokes).toBe(3);
    expect(midRoundState.participants.find((p) => p.golferId === hostId)?.strokes).toBe(0);
    expect(guestSeatMidRound.departed).toBeUndefined();
    expect(guestSeatMidRound.name).toBe(guest.name);
    expect(guestSeatMidRound.tee).toBe("white");

    // 5. Score remaining holes, finalize, GET /rounds/{roundId}/archive → participants carry the
    //    corrected assertion and the strokes it derived (a sealed snapshot freezes both).
    for (let hole = 2; hole <= holeCount; hole += 1) {
      await post(scoresUrl, { golferId: hostId, hole, result: { kind: "strokes", strokes: 5 }, ...hostOps.next() }, recordScoreResponseSchema, hostToken);
      await post(scoresUrl, { golferId: guestId, hole, result: { kind: "strokes", strokes: 5 }, ...guestOps.next() }, recordScoreResponseSchema, guestToken);
    }
    await post(rounds(`/${roundId}/finalize`), undefined, finalizeRoundResponseSchema, hostToken);

    // GET /rounds/{roundId}/archive is "golfer"-gated (routes.ts: "unlike GET
    // /rounds/{roundId}/events' 'round-read' tier, which trusts a round-scoped token... this
    // route authorizes by the caller's ACCOUNT instead") — the account's own idToken, NOT the
    // round-scoped hostToken used for every write above.
    const archive = await get(rounds(`/${roundId}/archive`), getRoundArchiveResponseSchema, host.idToken);
    const archivedState = reduceRound(archive.events);
    const guestSeatArchived = archivedState.participants.find((p) => p.golferId === guestId);
    expect(guestSeatArchived?.basis).toEqual({ kind: "normally-shoots", overPar: 13 });
    expect(guestSeatArchived?.strokes).toBe(3);
  });
});
