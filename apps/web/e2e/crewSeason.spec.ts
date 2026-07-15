import { expect, test } from "@playwright/test";
import type { GetMyRecordResponse, SeasonStandingLine } from "@swng/contracts";
import { golferId } from "@swng/domain";
import type { CrewId, GolferId, HeadToHeadRecord, RoundId, SeasonLedgerLine } from "@swng/domain";
import {
  addGameDirect,
  appendCountedRoundDirect,
  createCrewDirect,
  createScoreOps,
  createSeasonDirect,
  ensureCourse,
  finalizeRoundDirect,
  getMyRecordDirect,
  getSeasonStandingsDirect,
  invokeRebuild,
  joinCrewDirect,
  joinRoundDirect,
  loadWebEnv,
  mintAccountGolfer,
  mintCrewInviteDirect,
  pollUntil,
  recordScoreDirect,
  removeCountedRoundDirect,
  removeCrewMemberDirect,
  startRoundDirect,
} from "./support.js";
import type { AccountGolfer } from "./support.js";
import type { SeasonGolferIds } from "./crewSeasonDeck.js";
import { HOLES, SEASON_ROUNDS, buildCourseCard, computeLocalSeason, frozenSeasonExpectation, roundScoresByGolfer, seasonGames } from "./crewSeasonDeck.js";

// The golden season gate, rewritten accounts-only (accounts-only identity spec §1-3; the
// FROZEN deck M8 Task 7 minted is still played byte-for-byte): rounds are sealed leaves —
// never crew-tagged — and a crew creates a named SEASON and counts finished rounds into it
// by roundId (POST /crews/{crewId}/seasons/{seasonId}/rounds), with standings COMPUTED ON
// READ from the counted snapshots (no season projection to poll or rebuild). The deck's four
// players are now four minted ACCOUNTS — Al starts every round as himself and Bo/Cy/Dee join
// each round as themselves with their own Bearers (the per-account joins that replaced
// StartRound's deleted players[] ghost seeding) — and the deck's math is seeding-independent,
// so every frozen expectation (crewSeasonDeck.ts: singles H2H 5W-5L-2H, skins 54 each,
// stableford 430/430/435/435) is asserted UNCHANGED against the same standings endpoint.
// Entirely API-driven (task-7-brief.md's own parenthetical: "browser only where the thing
// gated is UI") — nothing in this scenario (crew setup, playing 12 rounds, seasons,
// standings, rebuild parity, a late crew join) is itself a UI behavior; the UI half is
// CrewPage/SeasonPanel's own component coverage, not this spec's. One long describe.serial,
// like identityRecord.spec.ts's own gate — later steps depend on state (crew id, golferIds,
// roundIds, seasonId) earlier steps mint.
test.describe.serial("golden season gate — counted rounds, standings-on-read, rebuild parity, late-join aggregation scope", () => {
  const courseName = `Saturday Boys Muni ${Date.now()}`;
  const card = buildCourseCard(courseName);
  const SEASON_NAME = "The Golden Dozen";

  let al: AccountGolfer;
  let bo: AccountGolfer;
  let cy: AccountGolfer;
  let dee: AccountGolfer;
  let crewId: CrewId;
  let ids: SeasonGolferIds;
  let seasonId = "";
  const roundIds: RoundId[] = [];
  // Course-cards spec §4: StartRound resolves a REFERENCE now — seeded ONCE (step 3, before the
  // deck loop) via the public course API, then passed into every startRoundDirect call below.
  // Deck DATA (card's holes/pars/tees) is untouched — only the seeding mechanics change.
  let course: Awaited<ReturnType<typeof ensureCourse>>;

  // The frozen ledger, resolved to the wire's SeasonStandingLine shape: a crew is a
  // grouping/competition ONLY (owner ruling, spec §11a) — standings aggregate the CURRENT
  // roster only, `name` comes from the roster's own CrewMember.name, and there is no `member`
  // flag on the wire (getSeasonStandings.ts's own doc comment: every row that reaches here is,
  // by construction, a member). `memberIds` is the roster AT THE POINT OF THE CALL — Al alone
  // through steps 5-7 (Bo/Cy/Dee hold accounts all season but join no roster), Al + Bo once
  // Bo joins the crew late in step 8.
  const nameOf = (id: GolferId): string => (id === ids.al ? "Al" : id === ids.bo ? "Bo" : id === ids.cy ? "Cy" : "Dee");

  const expectedStandingLines = (lines: readonly SeasonLedgerLine[], memberIds: ReadonlySet<GolferId>): readonly SeasonStandingLine[] =>
    lines.filter((line) => memberIds.has(line.golferId)).map((line) => ({ ...line, name: nameOf(line.golferId) }));

  // A head-to-head pair survives only when BOTH sides are current members (getSeasonStandings.ts)
  // — with Al the crew's sole member through steps 5-7, the Al-Bo pair is filtered to nothing;
  // it only reappears once Bo joins too (step 8).
  const expectedHeadToHead = (records: readonly HeadToHeadRecord[], memberIds: ReadonlySet<GolferId>): readonly HeadToHeadRecord[] =>
    records.filter((record) => memberIds.has(record.a) && memberIds.has(record.b));

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

  test("2: four accounts sign up (Al/Bo/Cy/Dee); Al creates 'The Saturday Boys' — its only member for now", async () => {
    test.setTimeout(120_000);
    const { httpUrl } = loadWebEnv();

    // Accounts-only (the wall): every seat in every deck round below is a signed-in account.
    // All four sign up NOW; only Al joins the crew's roster until step 8 — membership
    // (aggregation scope) is the thing steps 5-8 prove, so it must stay independent of merely
    // HAVING an account. The golferIds the whole deck plays under are the accounts' own,
    // known before a single round starts.
    al = await mintAccountGolfer("crew-al", "Al");
    bo = await mintAccountGolfer("crew-bo", "Bo");
    cy = await mintAccountGolfer("crew-cy", "Cy");
    dee = await mintAccountGolfer("crew-dee", "Dee");
    ids = { al: al.golfer.golferId, bo: bo.golfer.golferId, cy: cy.golfer.golferId, dee: dee.golfer.golferId };

    const created = await createCrewDirect(httpUrl, al.tokens.idToken, "The Saturday Boys");
    crewId = created.crew.crewId;
    expect(created.crew.members).toEqual([{ golferId: ids.al, name: "Al", role: "organizer", claimed: true }]);
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

  test("3: 12 rounds are played via the API, scripted to the frozen deck — every seat a self-join, no crew tag anywhere", async () => {
    test.setTimeout(900_000); // 12 rounds x (1 start + 3 self-joins + 3 games + 18 hole-batches + 1 finalize) against real beta latency
    const { httpUrl } = loadWebEnv();

    // Course-cards spec §4: seed the lineage ONCE, before the deck loop — every one of the 12
    // rounds below resolves the SAME reference (deck data untouched, standings stay byte-identical).
    course = await ensureCourse(courseName, card, al);

    // Every round has the same shape: Al starts as himself, then Bo/Cy/Dee each JOIN as
    // themselves with their own Bearers — the per-account joins that replaced StartRound's
    // deleted players[] ghost seeding. The same four golferIds recur across all 12 rounds
    // because they ARE the accounts' own ids (asserted per join below) — season-long
    // continuity is just identity now, not a reused ghost mint.
    for (let roundNumber = 1; roundNumber <= SEASON_ROUNDS; roundNumber += 1) {
      const started = await startRoundDirect(httpUrl, al, { course, tee: "member", courseHandicap: 0 });
      expect(started.golferId).toBe(ids.al); // as-self: the host seat is Al's account golfer, never a fresh id

      for (const account of [bo, cy, dee]) {
        const joined = await joinRoundDirect(httpUrl, account, { code: started.joinCode, tee: "member", courseHandicap: 0 });
        expect(joined.golferId).toBe(account.golfer.golferId); // self-join: the seat is the joiner's own account golfer
      }

      roundIds.push(started.roundId);
      await playRoundToTheDeck(httpUrl, started.roundId, started.token, roundNumber);
    }

    expect(roundIds).toHaveLength(SEASON_ROUNDS);
  });

  test("4: one season is created and every finished round is counted into it by a member who played it", async () => {
    test.setTimeout(180_000);
    const { httpUrl } = loadWebEnv();

    const created = await createSeasonDirect(httpUrl, al.tokens.idToken, crewId, SEASON_NAME);
    seasonId = created.season.seasonId;
    expect(created.season.name).toBe(SEASON_NAME);
    expect(created.season.status).toBe("open");

    // appendCountedRound's did-not-play guard: the appender must be a signed-in crew member
    // who is a PARTICIPANT of the round being counted. Al is in every one of the deck's 12
    // rounds (the host seat, as-self) and is the crew's only member, so Al counts them all —
    // each response echoing appendedBy as Al's own golferId is that guard's positive half.
    for (const id of roundIds) {
      const appended = await appendCountedRoundDirect(httpUrl, al.tokens.idToken, crewId, seasonId, id);
      expect(appended.round.roundId).toBe(id);
      expect(appended.round.appendedBy).toBe(ids.al);
    }
  });

  test("5: season standings equal the frozen ledger exactly — computed on read from the counted rounds", async () => {
    const { httpUrl } = loadWebEnv();
    const standings = await getSeasonStandingsDirect(httpUrl, al.tokens.idToken, crewId, seasonId);
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
    // (BLOCKED-don't-fudge), never an assertion to bend. Membership is Al ALONE at this point
    // (Bo/Cy/Dee hold accounts and played every round, but joined no roster) — a members-only
    // aggregation (owner ruling, spec §11a) surfaces only Al's row and an EMPTY head-to-head
    // (no pair has two members yet). The others' frozen numbers stay pinned in
    // crewSeasonDeck.ts as constants; Bo's resurface once he joins the roster in step 8.
    const memberIds = new Set<GolferId>([ids.al]);
    expect(standings.ledger).toEqual(expectedStandingLines(frozen.ledger, memberIds));
    expect(standings.headToHead).toEqual(expectedHeadToHead(frozen.headToHead, memberIds));
  });

  test("6: un-counting round 1 shifts the standings by exactly its contribution; re-counting restores the frozen ledger", async () => {
    test.setTimeout(120_000);
    const { httpUrl } = loadWebEnv();
    const roundOne = roundIds[0]!;

    // DELETE by the appender (Al) — removeCountedRound's not-the-appender guard is why nobody
    // else could.
    const removed = await removeCountedRoundDirect(httpUrl, al.tokens.idToken, crewId, seasonId, roundOne);
    expect(removed.roundId).toBe(roundOne);

    const without = await getSeasonStandingsDirect(httpUrl, al.tokens.idToken, crewId, seasonId);
    expect(without.rounds).toHaveLength(SEASON_ROUNDS - 1);
    expect(without.rounds.map((round) => round.roundId)).not.toContain(roundOne);

    // Round 1's own contribution, hand-read straight off the frozen deck (crewSeasonDeck.ts
    // ROUND_PLAN[0]: no decisive holes, hole18Winner "al"): Al birdies 18 while Bo pars it, so
    // Al wins the singles 1 up AND takes the whole carried 18-skin pot; stableford on this
    // all-par-4, handicap-0 card is 6-gross per hole, so Al scores 17×2+3 = 37 points and
    // Bo/Cy/Dee 18×2 = 36 each. The expected 11-round ledger is therefore the frozen one minus
    // exactly: Al -1 win, -37 points, -18 skins; Bo -1 loss, -36 points; Cy/Dee -36 points;
    // everyone -1 round; H2H Al 5→4 wins. Derived by SUBTRACTION from frozenSeasonExpectation
    // so the frozen numbers stay the single source of truth — asserted against the wire
    // members-only (Al alone; the H2H delta is computed for completeness but resolves to empty
    // either way, same as step 5, since Bo still isn't on the roster).
    const frozen = frozenSeasonExpectation(ids);
    const minusRoundOne = frozen.ledger.map((line) =>
      line.golferId === ids.al
        ? { ...line, rounds: SEASON_ROUNDS - 1, wins: line.wins - 1, points: line.points - 37, skins: line.skins - 18 }
        : line.golferId === ids.bo
          ? { ...line, rounds: SEASON_ROUNDS - 1, losses: line.losses - 1, points: line.points - 36 }
          : { ...line, rounds: SEASON_ROUNDS - 1, points: line.points - 36 },
    );
    const minusRoundOneHeadToHead = frozen.headToHead.map((record) =>
      record.a === ids.al ? { ...record, aWins: record.aWins - 1 } : { ...record, bWins: record.bWins - 1 },
    );
    const memberIds = new Set<GolferId>([ids.al]);
    expect(without.ledger).toEqual(expectedStandingLines(minusRoundOne, memberIds));
    expect(without.headToHead).toEqual(expectedHeadToHead(minusRoundOneHeadToHead, memberIds));

    // Re-count it — standings return to the frozen values exactly (counting is a pure inbound
    // reference; nothing about the round itself changed while it was uncounted).
    const reappended = await appendCountedRoundDirect(httpUrl, al.tokens.idToken, crewId, seasonId, roundOne);
    expect(reappended.round.roundId).toBe(roundOne);

    const restored = await getSeasonStandingsDirect(httpUrl, al.tokens.idToken, crewId, seasonId);
    expect([...restored.rounds.map((round) => round.roundId)].sort()).toEqual([...roundIds].sort());
    expect(restored.ledger).toEqual(expectedStandingLines(frozen.ledger, memberIds));
    expect(restored.headToHead).toEqual(expectedHeadToHead(frozen.headToHead, memberIds));
  });

  test("7: rebuild parity — the paged snapshot backfill reproduces Al's record; standings never depended on it", async () => {
    test.setTimeout(360_000); // the rebuild lambda replays every finalized round on beta (5-minute CDK timeout) — comfortably slower than every other step here
    const { httpUrl } = loadWebEnv();

    // Al's record is the projector's output (async, hence the poll): 12 as-self rounds →
    // 12 history lines.
    const pre = await pollUntil(
      () => getMyRecordDirect(httpUrl, al.tokens.idToken),
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
    // is the one deliberate exception: since pre-prod hardening D4a it's getMyRecord's
    // read-time stamp, so two reads always differ and it says nothing about the rebuild — the
    // rebuild proof is the history deep-equal plus value/differentialsUsed equality below.
    const post = await getMyRecordDirect(httpUrl, al.tokens.idToken);
    expect(post.history).toEqual(pre.history);
    expect(post.index?.value).toBe(pre.index?.value);
    expect(post.index?.differentialsUsed).toBe(pre.index?.differentialsUsed);
    expect(post.index?.computedAtMs).not.toBe(pre.index?.computedAtMs);

    // Standings are computed on read from the counted rounds' own snapshots — there is no
    // season projection for a rebuild to touch, and the frozen ledger must hold verbatim,
    // still filtered to the same Al-alone roster as steps 5-6 (membership itself is untouched
    // by a rebuild — it lives on the crew, not the snapshots).
    const standings = await getSeasonStandingsDirect(httpUrl, al.tokens.idToken, crewId, seasonId);
    const frozen = frozenSeasonExpectation(ids);
    const memberIds = new Set<GolferId>([ids.al]);
    expect(standings.ledger).toEqual(expectedStandingLines(frozen.ledger, memberIds));
    expect(standings.headToHead).toEqual(expectedHeadToHead(frozen.headToHead, memberIds));
  });

  test("8: Bo joins the crew late — his frozen rows and the Al-Bo head-to-head materialize; membership is pure aggregation scope", async () => {
    test.setTimeout(120_000);
    const { httpUrl } = loadWebEnv();

    // Bo's own record accrued all season with NO claim step — every round seated him by his
    // account's own golferId (test 3's self-joins), so all 12 history lines are simply his.
    // This is the accounts-only replacement for the deleted claim-continuity arc: continuity
    // is identity itself now, not a claim that adopts a ghost's history after the fact.
    const record: GetMyRecordResponse = await pollUntil(
      () => getMyRecordDirect(httpUrl, bo.tokens.idToken),
      (r) => r.history.length >= SEASON_ROUNDS,
      120_000,
      "Bo's record",
    );
    expect(record.history).toHaveLength(SEASON_ROUNDS);
    expect([...record.history.map((line) => line.roundId)].sort()).toEqual([...roundIds].sort());

    // The live proof that membership is pure aggregation scope: Bo — a season-long
    // NON-member whose rounds were all counted anyway — joins the crew off a fresh invite Al
    // mints right here (crew membership, invited in, accountable out — spec §2: ANY member may
    // invite; the permanent join code this step used to read off crew creation is gone), the
    // self-service arm (joinCrewByInvite.ts) that adds the CALLER's own account golfer. His
    // roster-row name comes from his account golfer record — asserted directly off the live
    // join response before trusting it in the standings comparison below.
    const invite = await mintCrewInviteDirect(httpUrl, al.tokens.idToken, crewId);
    const joined = await joinCrewDirect(httpUrl, bo.tokens.idToken, invite.token);
    expect(joined.crew.members.map((member) => member.golferId).sort()).toEqual([ids.al, ids.bo].sort());
    const boMember = joined.crew.members.find((member) => member.golferId === ids.bo);
    expect(boMember?.name).toBe("Bo");
    expect(boMember?.role).toBe("member");
    expect(boMember?.claimed).toBe(true);

    // Standings, re-fetched: Bo's frozen rows and the Al-Bo head-to-head materialize on the
    // very next read — nothing was lost while Bo was a non-member, since the counted rounds
    // themselves never changed, only the roster this read filters against.
    const standings = await getSeasonStandingsDirect(httpUrl, al.tokens.idToken, crewId, seasonId);
    const frozen = frozenSeasonExpectation(ids);
    const memberIds = new Set<GolferId>([ids.al, ids.bo]);
    expect(standings.ledger).toEqual(expectedStandingLines(frozen.ledger, memberIds));
    expect(standings.headToHead).toEqual(expectedHeadToHead(frozen.headToHead, memberIds));
  });

  test("8b: Al removes Bo — his standings rows vanish; a fresh invite and re-join restore them byte-identical — the aggregation-scope law, reached through remove", async () => {
    test.setTimeout(120_000);
    const { httpUrl } = loadWebEnv();
    const frozen = frozenSeasonExpectation(ids);

    // The organizer's own authority (crew membership, invited in, accountable out — spec §1):
    // DELETE /crews/{crewId}/members/{golferId}, Al on Bo. Same law as step 8's own late join,
    // run in reverse — the counted rounds never change, only the roster the NEXT standings
    // read filters against. Bo's account, his 12 history lines, and every round he's counted
    // into all stay exactly as they were; only his ROW in THIS season's standings depends on
    // current membership.
    const afterRemoval = await removeCrewMemberDirect(httpUrl, al.tokens.idToken, crewId, ids.bo);
    expect(afterRemoval.crew.members.map((member) => member.golferId)).toEqual([ids.al]);

    const remainingMemberIds = new Set<GolferId>([ids.al]);
    const standingsAfterRemoval = await getSeasonStandingsDirect(httpUrl, al.tokens.idToken, crewId, seasonId);
    expect(standingsAfterRemoval.ledger).toEqual(expectedStandingLines(frozen.ledger, remainingMemberIds));
    expect(standingsAfterRemoval.headToHead).toEqual(expectedHeadToHead(frozen.headToHead, remainingMemberIds));

    // Getting back in takes a FRESH invite — the permanent join code this file swapped away
    // from (C-T3) has no comeback, and neither does the one Bo used in step 8; it already spent
    // itself becoming membership once. A brand-new mint + join is what "accountable out" means
    // in practice: leaving is never a one-way door, but it's also never free.
    const reinvite = await mintCrewInviteDirect(httpUrl, al.tokens.idToken, crewId);
    const rejoined = await joinCrewDirect(httpUrl, bo.tokens.idToken, reinvite.token);
    expect(rejoined.crew.members.map((member) => member.golferId).sort()).toEqual([ids.al, ids.bo].sort());

    // BYTE-IDENTICAL restoration: the exact same frozen-derived expected objects step 8 already
    // asserted, not merely "Bo's rows are non-empty again" — standings are computed on read from
    // the counted snapshots every time, so a roster round-trip that ends where it started must
    // reproduce the identical numbers, not just similar ones.
    const restoredMemberIds = new Set<GolferId>([ids.al, ids.bo]);
    const standingsAfterRejoin = await getSeasonStandingsDirect(httpUrl, al.tokens.idToken, crewId, seasonId);
    expect(standingsAfterRejoin.ledger).toEqual(expectedStandingLines(frozen.ledger, restoredMemberIds));
    expect(standingsAfterRejoin.headToHead).toEqual(expectedHeadToHead(frozen.headToHead, restoredMemberIds));
  });
});
