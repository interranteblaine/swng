import { expect, test } from "@playwright/test";
import type { GetCrewRecordsResponse, GetMyRecordResponse } from "@swng/contracts";
import { golferId } from "@swng/domain";
import type { CrewId, GolferId, RoundId } from "@swng/domain";
import type { AuthTokens } from "../src/auth/tokenStore.js";
import {
  addCrewMemberDirect,
  addGameDirect,
  claimGolferDirect,
  createCrewDirect,
  createScoreOps,
  ensureCourse,
  finalizeRoundDirect,
  getCrewRecordsDirect,
  getMyRecordDirect,
  invokeRebuild,
  loadWebEnv,
  mintThrowawayUser,
  pollUntil,
  recordScoreDirect,
  saveStandingGameDirect,
  startRoundDirect,
  updateMeDirect,
} from "./support.js";
import type { SeasonGolferIds } from "./crewSeasonDeck.js";
import { HOLES, SEASON_ROUNDS, buildCourseCard, computeLocalSeason, frozenSeasonExpectation, roundScoresByGolfer, seasonGames } from "./crewSeasonDeck.js";

// The M8 gate (docs/implementation-plan.md M8; task-7-brief.md): "a scripted season simulation
// (a dozen golden rounds) produces the exact expected ledger and H2H records." Entirely
// API-driven (task-7-brief.md's own parenthetical: "browser only where the thing gated is
// UI") — nothing in this scenario (crew setup, playing 12 rounds, the ledger read, rebuild
// parity, a mid-season claim) is itself a UI behavior; the UI half of "one-tap Saturday" is
// primaryPath.spec.ts's job and CrewPage.test.tsx's own component coverage, not this spec's.
// One long describe.serial, like identityRecord.spec.ts's own M7 gate — later steps depend on
// state (crewId, golferIds, roundIds) earlier steps mint.
test.describe.serial("M8 golden season gate — crew ledger, H2H, rebuild parity, claim continuity", () => {
  const courseName = `Saturday Boys Muni ${Date.now()}`;
  const card = buildCourseCard(courseName);

  let hostU: AuthTokens;
  let crewId: CrewId;
  let ids: SeasonGolferIds;
  const roundIds: RoundId[] = [];

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

  test("2: U signs up, creates 'The Saturday Boys' as-self (Al), adds ghosts Bo/Cy/Dee", async () => {
    test.setTimeout(60_000);
    const { httpUrl } = loadWebEnv();

    hostU = await mintThrowawayUser("crew-u");
    const al = await updateMeDirect(httpUrl, hostU.idToken, { name: "Al" });

    const created = await createCrewDirect(httpUrl, hostU.idToken, "The Saturday Boys");
    crewId = created.crew.crewId;
    expect(created.crew.members).toEqual([{ golferId: al.golfer.golferId, name: "Al", role: "organizer", claimed: true }]);

    const afterBo = await addCrewMemberDirect(httpUrl, hostU.idToken, crewId, "Bo");
    const afterCy = await addCrewMemberDirect(httpUrl, hostU.idToken, crewId, "Cy");
    const afterDee = await addCrewMemberDirect(httpUrl, hostU.idToken, crewId, "Dee");

    const nameOf = (name: string): GolferId => {
      const found = afterDee.crew.members.find((m) => m.name === name);
      if (!found) throw new Error(`no crew member named "${name}" after adding Bo/Cy/Dee`);
      return found.golferId;
    };
    ids = { al: al.golfer.golferId, bo: nameOf("Bo"), cy: nameOf("Cy"), dee: nameOf("Dee") };

    expect(afterDee.crew.members).toHaveLength(4);
    expect(afterBo.crew.members.map((m) => m.name)).toContain("Bo");
    expect(afterCy.crew.members.map((m) => m.name)).toContain("Cy");
  });

  test("3: the standing game is saved — singles Al-Bo (allowance 1), 4-way skins, 4-way stableford", async () => {
    const { httpUrl } = loadWebEnv();
    const courseId = await ensureCourse(courseName, card);
    const games = seasonGames(ids);

    const saved = await saveStandingGameDirect(httpUrl, hostU.idToken, crewId, {
      courseId,
      tee: "member",
      games: [games.singles, games.skins, games.stableford],
    });

    expect(saved.crew.standingGame?.courseId).toBe(courseId);
    expect(saved.crew.standingGame?.tee).toBe("member");
    expect(saved.crew.standingGame?.games).toEqual([games.singles, games.skins, games.stableford]);
  });

  // One crew round, played entirely via the API: StartRound as-self (Al's own golferId) with
  // crewId + players (Bo/Cy/Dee seated by the SAME stable ghost ids the crew roster already
  // knows them by — Task 5b/M8's "one ghost plays the whole season" continuity), the season's
  // three standing games added, all 18 holes scored for all four (score-for-anyone: Al's own
  // participant token authors every cell, exactly like a real host entering the group's card),
  // then finalized. Scoring is batched 4-wide per hole (one Promise.all per hole, 18 holes) —
  // ops.next() for all four golfers in a batch resolves synchronously before any of the four
  // fetches' own await yields (JS's own run-to-first-await semantics), so opId/hlc ordering
  // stays deterministic even though the four POSTs race on the wire.
  const playCrewRound = async (httpUrl: string, roundNumber: number): Promise<void> => {
    const started = await startRoundDirect(
      httpUrl,
      {
        card,
        host: { name: "Al", tee: "member", courseHandicap: 0 },
        golferId: ids.al,
        crewId,
        players: [
          { name: "Bo", tee: "member", courseHandicap: 0, golferId: ids.bo },
          { name: "Cy", tee: "member", courseHandicap: 0, golferId: ids.cy },
          { name: "Dee", tee: "member", courseHandicap: 0, golferId: ids.dee },
        ],
      },
      hostU.idToken,
    );
    roundIds.push(started.roundId);

    const games = seasonGames(ids);
    await addGameDirect(httpUrl, started.roundId, started.token, games.singles);
    await addGameDirect(httpUrl, started.roundId, started.token, games.skins);
    await addGameDirect(httpUrl, started.roundId, started.token, games.stableford);

    const scores = roundScoresByGolfer(ids, roundNumber);
    const ops = createScoreOps(`crew-r${roundNumber}`);
    for (let hole = 1; hole <= HOLES; hole += 1) {
      await Promise.all(
        Object.entries(scores).map(([golfer, holeScores]) =>
          recordScoreDirect(httpUrl, started.roundId, started.token, { golferId: golferId(golfer), hole, strokes: holeScores[hole - 1]! }, ops),
        ),
      );
    }

    await finalizeRoundDirect(httpUrl, started.roundId, started.token);
  };

  test("4: 12 crew rounds are played via the API, scripted to the frozen deck", async () => {
    test.setTimeout(900_000); // 12 rounds x (1 start + 3 games + 18 hole-batches + 1 finalize) against real beta latency
    const { httpUrl } = loadWebEnv();
    for (let roundNumber = 1; roundNumber <= SEASON_ROUNDS; roundNumber += 1) {
      await playCrewRound(httpUrl, roundNumber);
    }
    expect(roundIds).toHaveLength(SEASON_ROUNDS);
  });

  let liveRecords: GetCrewRecordsResponse;

  test("5: GET /crews/{id}/records deep-equals the frozen season expectation", async () => {
    test.setTimeout(120_000);
    const { httpUrl } = loadWebEnv();
    const frozen = frozenSeasonExpectation(ids);

    // projectArchive's own crew-tagged write (packages/application/src/projections/
    // projectArchive.ts) runs off the LAST round's finalize asynchronously (DynamoDB Streams)
    // relative to that finalize's own HTTP response — poll on structural readiness (every
    // ledger line at 12 rounds) before asserting exact values, same "poll on shape, assert on
    // content" split as identityRecord.spec.ts's own pollRecord.
    liveRecords = await pollUntil(
      () => getCrewRecordsDirect(httpUrl, hostU.idToken, crewId),
      (r) => r.ledger.length === 4 && r.ledger.every((line) => line.rounds === SEASON_ROUNDS),
      120_000,
      "crew records",
    );

    expect(liveRecords.headToHead).toHaveLength(1); // singles Al-Bo is the only head-to-head pair this season ever plays
    expect(liveRecords.ledger).toEqual(frozen.ledger);
    expect(liveRecords.headToHead).toEqual(frozen.headToHead);
  });

  test("6: rebuild parity — wiping and replaying every projection reproduces the identical ledger", async () => {
    test.setTimeout(360_000); // the rebuild lambda replays every finalized round on beta (5-minute CDK timeout)

    const summary = await invokeRebuild();
    console.log(`[crewSeason] rebuild: ${summary.rounds} rounds, ${summary.golfers} golfers`);
    expect(summary.rounds).toBeGreaterThanOrEqual(SEASON_ROUNDS);

    const { httpUrl } = loadWebEnv();
    const postRebuild = await getCrewRecordsDirect(httpUrl, hostU.idToken, crewId);
    expect(postRebuild.ledger).toEqual(liveRecords.ledger);
    expect(postRebuild.headToHead).toEqual(liveRecords.headToHead);
  });

  test("7: mid-season claim continuity — V claims Bo's ghost and inherits all 12 history lines", async () => {
    test.setTimeout(120_000);
    const { httpUrl } = loadWebEnv();

    const userV = await mintThrowawayUser("crew-v");
    const claimed = await claimGolferDirect(httpUrl, userV.idToken, { golferId: ids.bo, name: "Bo" });
    expect(claimed.golfer.golferId).toBe(ids.bo);
    expect(claimed.golfer.name).toBe("Bo"); // Bo's row already existed (addCrewMember minted it) — the claim binds V's sub, it never renames an existing row

    // The stable-crew-ghost promise (task-7-brief.md): ONE claim adopts Bo's WHOLE season —
    // every round Bo played reused the SAME golferId (crewSeason's own players[] above), so
    // claiming it now surfaces all 12 history lines, not just whichever round happened to be
    // "live" at claim time (unlike M7's identityRecord.spec.ts, which claims mid-round —
    // nothing here is still live to claim FROM; the claim is a bare API call against the
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
