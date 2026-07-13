import { expect, test } from "@playwright/test";
import type { GetMyRecordResponse, SeasonStandingLine } from "@swng/contracts";
import { golferId } from "@swng/domain";
import type { CrewId, GolferId, RoundId, SeasonLedgerLine } from "@swng/domain";
import type { AuthTokens } from "../src/auth/tokenStore.js";
import {
  addGameDirect,
  appendCountedRoundDirect,
  claimGolferDirect,
  createCrewDirect,
  createScoreOps,
  createSeasonDirect,
  finalizeRoundDirect,
  getMyRecordDirect,
  getRoundEventsDirect,
  getSeasonStandingsDirect,
  invokeRebuild,
  loadWebEnv,
  mintThrowawayUser,
  pollUntil,
  recordScoreDirect,
  removeCountedRoundDirect,
  startRoundDirect,
  updateMeDirect,
} from "./support.js";
import type { SeasonGolferIds } from "./crewSeasonDeck.js";
import { HOLES, SEASON_ROUNDS, buildCourseCard, computeLocalSeason, frozenSeasonExpectation, roundScoresByGolfer, seasonGames } from "./crewSeasonDeck.js";

// The golden season gate, rewritten for the realigned crew model (architecture-realignment
// Task 12; M8 Task 7 minted the FROZEN deck this still plays byte-for-byte): rounds are
// sealed leaves — never crew-tagged — and a crew instead creates a named SEASON and counts
// finished rounds into it by roundId (POST /crews/{crewId}/seasons/{seasonId}/rounds), with
// standings COMPUTED ON READ from the counted snapshots (no season projection to poll or
// rebuild). The deck's math is model-independent, so every frozen expectation
// (crewSeasonDeck.ts: singles H2H 5W-5L-2H, skins 54 each, stableford 430/430/435/435) is
// asserted unchanged against the new standings endpoint. Entirely API-driven (task-7-brief.md's
// own parenthetical: "browser only where the thing gated is UI") — nothing in this scenario
// (crew setup, playing 12 rounds, seasons, standings, rebuild parity, a mid-season claim) is
// itself a UI behavior; the UI half is CrewPage/SeasonPanel's own component coverage, not this
// spec's. One long describe.serial, like identityRecord.spec.ts's own M7 gate — later steps
// depend on state (crew id, golferIds, roundIds, seasonId) earlier steps mint.
test.describe.serial("golden season gate — counted rounds, standings-on-read, rebuild parity, claim continuity", () => {
  const courseName = `Saturday Boys Muni ${Date.now()}`;
  const card = buildCourseCard(courseName);
  const SEASON_NAME = "The Golden Dozen";

  let hostU: AuthTokens;
  let alId: GolferId;
  let crewId: CrewId;
  let ids: SeasonGolferIds;
  let seasonId = "";
  let roundOneJoinCode = ""; // V's claim proof in step 8: a round Bo verifiably played in
  const roundIds: RoundId[] = [];

  // The frozen ledger, resolved to the wire's SeasonStandingLine shape: `name` resolves from
  // the counted snapshots' own participants (every round seats the same four names) and
  // `member` from the CURRENT roster — which is Al alone, since membership is real accounts
  // only now (de-ghost, architecture realignment) and Bo/Cy/Dee stay round-minted ghosts all
  // season. That ghosts aggregate with member:false is getSeasonStandings' own documented
  // behavior ("standings never depend on membership history"), asserted here, not worked
  // around.
  const expectedStandingLines = (lines: readonly SeasonLedgerLine[]): readonly SeasonStandingLine[] =>
    lines.map((line) => ({
      ...line,
      name: line.golferId === ids.al ? "Al" : line.golferId === ids.bo ? "Bo" : line.golferId === ids.cy ? "Cy" : "Dee",
      member: line.golferId === ids.al,
    }));

  test("1: local verification — the hand-derived deck matches the domain engines exactly", () => {
    // Placeholder golferIds are enough here: this step never touches the network, it only
    // proves ROUND_PLAN/roundScores (crewSeasonDeck.ts) fold, through the SAME playGoldenRoundLog
    // -> settleRound -> crewContribution -> aggregateSeason pipeline the real server exercises,
    // to EXACTLY the frozen numbers pinned in task-7-report.md. A mismatch here is a bug in the
    // deck's own construction — fixed before this file is trusted for a single live call, never
    // adjusted to match one (BLOCKED-don't-fudge, task-7-brief.md verbatim).
    const placeholderIds: SeasonGolferIds = {
      al: golferId("local-al"),
      bo: golferId("local-bo"),
      cy: golferId("local-cy"),
      dee: golferId("local-dee"),
    };
    expect(computeLocalSeason(placeholderIds)).toEqual(frozenSeasonExpectation(placeholderIds));
  });

  test("2: U signs up and creates 'The Saturday Boys' as-self (Al) — a roster of real accounts only", async () => {
    test.setTimeout(60_000);
    const { httpUrl } = loadWebEnv();

    hostU = await mintThrowawayUser("crew-u");
    const al = await updateMeDirect(httpUrl, hostU.idToken, { name: "Al" });
    alId = al.golfer.golferId;

    // De-ghost (architecture realignment): the M8 add-a-ghost-by-name roster path is GONE — a
    // crew member must be an existing ACCOUNT golfer (addCrewMember.ts's ghost-not-addable),
    // so the crew stays Al alone and Bo/Cy/Dee live as round-minted ghosts (step 3), exactly
    // the "ghosts still exist inside rounds" arm the realignment kept.
    const created = await createCrewDirect(httpUrl, hostU.idToken, "The Saturday Boys");
    crewId = created.crew.crewId;
    expect(created.crew.members).toEqual([{ golferId: alId, name: "Al", role: "organizer", claimed: true }]);
  });

  // One deck round, played entirely via the API: the season's three games added, all 18 holes
  // scored for all four (score-for-anyone: Al's own participant token authors every cell,
  // exactly like a real host entering the group's card), then finalized. Scoring is batched
  // 4-wide per hole (one Promise.all per hole, 18 holes) — ops.next() for all four golfers in
  // a batch resolves synchronously before any of the four fetches' own await yields (JS's own
  // run-to-first-await semantics), so opId/hlc ordering stays deterministic even though the
  // four POSTs race on the wire.
  const playRoundToTheDeck = async (httpUrl: string, id: RoundId, token: string, roundNumber: number): Promise<void> => {
    const games = seasonGames(ids);
    await addGameDirect(httpUrl, id, token, games.singles);
    await addGameDirect(httpUrl, id, token, games.skins);
    await addGameDirect(httpUrl, id, token, games.stableford);

    const scores = roundScoresByGolfer(ids, roundNumber);
    const ops = createScoreOps(`crew-r${roundNumber}`);
    for (let hole = 1; hole <= HOLES; hole += 1) {
      await Promise.all(
        Object.entries(scores).map(([golfer, holeScores]) =>
          recordScoreDirect(httpUrl, id, token, { golferId: golferId(golfer), hole, strokes: holeScores[hole - 1]! }, ops),
        ),
      );
    }

    await finalizeRoundDirect(httpUrl, id, token);
  };

  test("3: 12 rounds are played via the API, scripted to the frozen deck — no crew tag anywhere", async () => {
    test.setTimeout(900_000); // 12 rounds x (1 start + 3 games + 18 hole-batches + 1 finalize) against real beta latency
    const { httpUrl } = loadWebEnv();

    // Round 1 MINTS the ghosts: StartRound as-self (Al's account golferId) seats Bo/Cy/Dee by
    // name alone and the server mints each a fresh GolferId. StartRoundResponse only carries
    // the HOST's id, so the minted three are read back from the round's own participant-joined
    // events — the same log any real client folds for its roster.
    const first = await startRoundDirect(
      httpUrl,
      {
        card,
        host: { name: "Al", tee: "member", courseHandicap: 0 },
        golferId: alId,
        players: [
          { name: "Bo", tee: "member", courseHandicap: 0 },
          { name: "Cy", tee: "member", courseHandicap: 0 },
          { name: "Dee", tee: "member", courseHandicap: 0 },
        ],
      },
      hostU.idToken,
    );
    roundIds.push(first.roundId);
    roundOneJoinCode = first.joinCode;
    expect(first.golferId).toBe(alId); // as-self: the host seat reuses Al's account golferId, no fresh ghost

    const { events } = await getRoundEventsDirect(httpUrl, first.roundId, first.token);
    const seated = events.flatMap((event) => (event.kind === "participant-joined" ? [event.participant] : []));
    const mintedIdOf = (name: string): GolferId => {
      const found = seated.find((participant) => participant.name === name);
      if (!found) throw new Error(`round 1 seated no participant named "${name}"`);
      return found.golferId;
    };
    ids = { al: alId, bo: mintedIdOf("Bo"), cy: mintedIdOf("Cy"), dee: mintedIdOf("Dee") };
    expect(mintedIdOf("Al")).toBe(alId);

    await playRoundToTheDeck(httpUrl, first.roundId, first.token, 1);

    // Rounds 2-12 REUSE the minted ids (players[].golferId — the unclaimed-reuse arm of the
    // one shared golferIdentity resolver): Task 5b's "one ghost plays the whole season under
    // one GolferId" continuity, now anchored in the rounds themselves rather than a crew
    // roster.
    for (let roundNumber = 2; roundNumber <= SEASON_ROUNDS; roundNumber += 1) {
      const started = await startRoundDirect(
        httpUrl,
        {
          card,
          host: { name: "Al", tee: "member", courseHandicap: 0 },
          golferId: ids.al,
          players: [
            { name: "Bo", tee: "member", courseHandicap: 0, golferId: ids.bo },
            { name: "Cy", tee: "member", courseHandicap: 0, golferId: ids.cy },
            { name: "Dee", tee: "member", courseHandicap: 0, golferId: ids.dee },
          ],
        },
        hostU.idToken,
      );
      roundIds.push(started.roundId);
      await playRoundToTheDeck(httpUrl, started.roundId, started.token, roundNumber);
    }

    expect(roundIds).toHaveLength(SEASON_ROUNDS);
  });

  test("4: one season is created and every finished round is counted into it by a member who played it", async () => {
    test.setTimeout(180_000);
    const { httpUrl } = loadWebEnv();

    const created = await createSeasonDirect(httpUrl, hostU.idToken, crewId, SEASON_NAME);
    seasonId = created.season.seasonId;
    expect(created.season.name).toBe(SEASON_NAME);
    expect(created.season.status).toBe("open");

    // appendCountedRound's did-not-play guard: the appender must be a signed-in crew member
    // who is a PARTICIPANT of the round being counted. Al is in every one of the deck's 12
    // rounds (the host seat, as-self) and is the crew's only account member, so Al counts them
    // all — each response echoing appendedBy as Al's own golferId is that guard's positive
    // half.
    for (const id of roundIds) {
      const appended = await appendCountedRoundDirect(httpUrl, hostU.idToken, crewId, seasonId, id);
      expect(appended.round.roundId).toBe(id);
      expect(appended.round.appendedBy).toBe(ids.al);
    }
  });

  test("5: season standings equal the frozen ledger exactly — computed on read from the counted rounds", async () => {
    const { httpUrl } = loadWebEnv();
    const standings = await getSeasonStandingsDirect(httpUrl, hostU.idToken, crewId, seasonId);
    const frozen = frozenSeasonExpectation(ids);

    expect(standings.seasonId).toBe(seasonId);
    expect(standings.name).toBe(SEASON_NAME);
    expect(standings.status).toBe("open");

    // All 12 counted, every entry appended by Al, newest-first by the rounds' own finalize
    // times (getSeasonStandings' documented order).
    expect([...standings.rounds.map((round) => round.roundId)].sort()).toEqual([...roundIds].sort());
    for (const round of standings.rounds) expect(round.appendedBy).toBe(ids.al);
    for (let i = 1; i < standings.rounds.length; i += 1) {
      expect(standings.rounds[i - 1]!.finalizedAt).toBeGreaterThanOrEqual(standings.rounds[i]!.finalizedAt);
    }

    // THE frozen numbers (crewSeasonDeck.ts): singles H2H 5W-5L-2H, skins 54 each, stableford
    // 430/430/435/435 — identical to what the M8 projector once served from the deleted
    // GET /crews/{id}/records, now folded on read. A mismatch is a PRODUCT defect
    // (BLOCKED-don't-fudge), never an assertion to bend.
    expect(standings.ledger).toEqual(expectedStandingLines(frozen.ledger));
    expect(standings.headToHead).toEqual(frozen.headToHead);
  });

  test("6: un-counting round 1 shifts the standings by exactly its contribution; re-counting restores the frozen ledger", async () => {
    test.setTimeout(120_000);
    const { httpUrl } = loadWebEnv();
    const roundOne = roundIds[0]!;

    // DELETE by the appender (Al) — removeCountedRound's not-the-appender guard is why nobody
    // else could.
    const removed = await removeCountedRoundDirect(httpUrl, hostU.idToken, crewId, seasonId, roundOne);
    expect(removed.roundId).toBe(roundOne);

    const without = await getSeasonStandingsDirect(httpUrl, hostU.idToken, crewId, seasonId);
    expect(without.rounds).toHaveLength(SEASON_ROUNDS - 1);
    expect(without.rounds.map((round) => round.roundId)).not.toContain(roundOne);

    // Round 1's own contribution, hand-read straight off the frozen deck (crewSeasonDeck.ts
    // ROUND_PLAN[0]: no decisive holes, hole18Winner "al"): Al birdies 18 while Bo pars it, so
    // Al wins the singles 1 up AND takes the whole carried 18-skin pot; stableford on this
    // all-par-4, handicap-0 card is 6-gross per hole, so Al scores 17×2+3 = 37 points and
    // Bo/Cy/Dee 18×2 = 36 each. The expected 11-round ledger is therefore the frozen one minus
    // exactly: Al -1 win, -37 points, -18 skins; Bo -1 loss, -36 points; Cy/Dee -36 points;
    // everyone -1 round; H2H Al 5→4 wins. Derived by SUBTRACTION from frozenSeasonExpectation
    // so the frozen numbers stay the single source of truth.
    const frozen = frozenSeasonExpectation(ids);
    const minusRoundOne = frozen.ledger.map((line) =>
      line.golferId === ids.al
        ? { ...line, rounds: SEASON_ROUNDS - 1, wins: line.wins - 1, points: line.points - 37, skins: line.skins - 18 }
        : line.golferId === ids.bo
          ? { ...line, rounds: SEASON_ROUNDS - 1, losses: line.losses - 1, points: line.points - 36 }
          : { ...line, rounds: SEASON_ROUNDS - 1, points: line.points - 36 },
    );
    expect(without.ledger).toEqual(expectedStandingLines(minusRoundOne));
    expect(without.headToHead).toEqual(
      frozen.headToHead.map((record) => (record.a === ids.al ? { ...record, aWins: record.aWins - 1 } : { ...record, bWins: record.bWins - 1 })),
    );

    // Re-count it — standings return to the frozen values exactly (counting is a pure inbound
    // reference; nothing about the round itself changed while it was uncounted).
    const reappended = await appendCountedRoundDirect(httpUrl, hostU.idToken, crewId, seasonId, roundOne);
    expect(reappended.round.roundId).toBe(roundOne);

    const restored = await getSeasonStandingsDirect(httpUrl, hostU.idToken, crewId, seasonId);
    expect([...restored.rounds.map((round) => round.roundId)].sort()).toEqual([...roundIds].sort());
    expect(restored.ledger).toEqual(expectedStandingLines(frozen.ledger));
    expect(restored.headToHead).toEqual(frozen.headToHead);
  });

  test("7: rebuild parity — the paged snapshot backfill reproduces Al's record; standings never depended on it", async () => {
    test.setTimeout(360_000); // the rebuild lambda replays every finalized round on beta (5-minute CDK timeout) — comfortably slower than every other step here
    const { httpUrl } = loadWebEnv();

    // Al's record is the projector's output (async, hence the poll): 12 as-self rounds →
    // 12 history lines.
    const pre = await pollUntil(
      () => getMyRecordDirect(httpUrl, hostU.idToken),
      (record) => record.history.length >= SEASON_ROUNDS,
      120_000,
      "Al's record",
    );
    expect(pre.history).toHaveLength(SEASON_ROUNDS);
    expect([...pre.history.map((line) => line.roundId)].sort()).toEqual([...roundIds].sort());

    const summary = await invokeRebuild();
    console.log(`[crewSeason] rebuild: ${summary.processed} snapshots processed`);
    expect(summary.processed).toBeGreaterThanOrEqual(SEASON_ROUNDS); // at least this run's own 12 rounds

    // Deep-equal on history: archiveGolferLine is a pure recompute from the SAME stored
    // archives before and after the backfill — no wall-clock or randomness in it. computedAtMs
    // is the one deliberate exception (projectArchive stamps clock.now() on every index
    // recompute) — asserting it CHANGED is honest proof the rebuild actually recomputed this
    // golfer rather than reading a stale record back untouched.
    const post = await getMyRecordDirect(httpUrl, hostU.idToken);
    expect(post.history).toEqual(pre.history);
    expect(post.index?.value).toBe(pre.index?.value);
    expect(post.index?.differentialsUsed).toBe(pre.index?.differentialsUsed);
    expect(post.index?.computedAtMs).not.toBe(pre.index?.computedAtMs);

    // Standings are computed on read from the counted rounds' own snapshots — there is no
    // season projection for a rebuild to touch, and the frozen ledger must hold verbatim.
    const standings = await getSeasonStandingsDirect(httpUrl, hostU.idToken, crewId, seasonId);
    const frozen = frozenSeasonExpectation(ids);
    expect(standings.ledger).toEqual(expectedStandingLines(frozen.ledger));
    expect(standings.headToHead).toEqual(frozen.headToHead);
  });

  test("8: mid-season claim continuity — V claims Bo's ghost and inherits all 12 history lines", async () => {
    test.setTimeout(120_000);
    const { httpUrl } = loadWebEnv();

    const userV = await mintThrowawayUser("crew-v");
    // M9 hardening (claim proof-of-context): rosters are real accounts only now, so Bo's
    // ghost belongs to NO crew — the proof is a ROUND join code instead: round 1's, the very
    // round whose participant-joined event minted Bo's golferId (claimGolfer.ts's round arm
    // loads that round's state and finds Bo among its participants; a finalized round's code
    // still resolves).
    const claimed = await claimGolferDirect(httpUrl, userV.idToken, { golferId: ids.bo, name: "Bo", code: roundOneJoinCode });
    expect(claimed.golfer.golferId).toBe(ids.bo);
    // Ghost golfer rows are lazy — StartRound minted Bo's id without ever writing a row, so
    // the claim seeds a fresh row under that SAME id (named from this request), then binds
    // V's sub to it.
    expect(claimed.golfer.name).toBe("Bo");

    // The stable-ghost promise, now round-anchored: every round seated Bo by the SAME golferId
    // (players[].golferId reusing round 1's mint), so ONE claim adopts Bo's whole season — all
    // 12 history lines, not just whichever round happened to be live at claim time (nothing
    // here is still live to claim FROM; the claim is a bare API call against the
    // already-finalized ghost).
    const record: GetMyRecordResponse = await pollUntil(
      () => getMyRecordDirect(httpUrl, userV.idToken),
      (r) => r.history.length >= SEASON_ROUNDS,
      120_000,
      "V's record",
    );
    expect(record.history).toHaveLength(SEASON_ROUNDS);
    expect([...record.history.map((line) => line.roundId)].sort()).toEqual([...roundIds].sort());
  });
});
