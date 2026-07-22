import { expect, test } from "@playwright/test";
import type { CrewRecordsResponse, GetMyRecordResponse, PartnerStandingRecord, ScoreboardRow, SeasonStandingLine } from "@swng/contracts";
import { archiveGolferLine, crewScoreboard, golferId } from "@swng/domain";
import type { CrewId, GolferId, HeadToHeadRecord, RoundId, SeasonLedgerLine, StoredLine } from "@swng/domain";
import {
  addGameDirect,
  closeSeasonDirect,
  createCrewDirect,
  createScoreOps,
  createSeasonDirect,
  ensureCourse,
  finalizeRoundDirect,
  getCrewRecordsDirect,
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
  removeCrewMemberDirect,
  reopenSeasonDirect,
  startRoundDirect,
} from "./support.js";
import type { AccountGolfer } from "./support.js";
import type { SeasonGolferIds } from "./crewSeasonDeck.js";
import {
  HOLES,
  SEASON_ROUNDS,
  buildCourseCard,
  computeLocalArchives,
  computeLocalSeason,
  frozenScoreboardExpectation,
  frozenSeasonExpectation,
  roundScoresByGolfer,
  seasonGames,
} from "./crewSeasonDeck.js";

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

  // The scoreboard's own frozen rows (crew-scoreboard plan Task 4), roster-filtered exactly like
  // the together-folds above but WITHOUT the both-sides rule (a scoreboard row needs only ITS
  // OWN golfer on the roster — Al alone still gets a row; see test 4/5) and with `name` from the
  // same roster-name source every other row on this response uses.
  const expectedScoreboardRows = (memberIds: ReadonlySet<GolferId>): readonly ScoreboardRow[] =>
    frozenScoreboardExpectation(ids)
      .filter((row) => memberIds.has(row.golferId))
      .map((row) => ({ ...row, name: nameOf(row.golferId) }));

  // --- Additive analytics oracles (analytics read-folds spec 2026-07-21 §5) -------------------
  // Every value below is hand-derived from the FROZEN deck BEFORE any live call (the deck
  // discipline, task-8-brief.md) — never read back off the system. The existing standings
  // assertions above are byte-unchanged; this only ADDS partner/all-time coverage. The season
  // superlatives (lowest-net-average/most-improved-index) this section used to also cover are SUPERSEDED whole
  // by the crew-scoreboard redesign (spec §3c) — gone from the wire; their oracle helpers are
  // deleted with them. `standings.scoreboard`'s own new oracles (frozenScoreboardExpectation,
  // crewSeasonDeck.ts) land HERE (crew-scoreboard plan Task 4) — the comment this replaces named
  // this exact task as the later home for them.

  // PARTNERS: four-ball ONLY (partnerRecords, packages/domain/src/crew/analytics.ts). This deck
  // plays exactly three games every round — singles-match, skins, stableford (crewSeasonDeck.ts
  // seasonGames) — and NO four-ball anywhere, so the partner fold has zero results to accumulate
  // at every roster. `[]` is the honest, permanent expectation, not an omission.
  const EXPECTED_PARTNERS: readonly PartnerStandingRecord[] = [];

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

    // --- The scoreboard oracle (crew-scoreboard plan Task 4 Step 1) ----------------------------
    // A SEPARATE local fold from the ledger/head-to-head one above: crewScoreboard folds over
    // each member's OWN StoredLine[] (never the together-archives), so its lines are built here
    // directly from the SAME 12 settled archives via archiveGolferLine (never a hand-rolled line
    // shape — the "the fold is the derivation tool" rule) plus synthetic chronology —
    // finalizedAtMs = the deck's own round order (0..11), no createdAtMs (playedAtMs then falls
    // back to finalizedAtMs, scoreboard.ts's own rule). The result is asserted against
    // frozenScoreboardExpectation (crewSeasonDeck.ts) — hand-frozen from running this exact fold
    // ONCE and reading its printed output, never adjusted to match a live run.
    const archives = computeLocalArchives(placeholderIds);
    const members = (["al", "bo", "cy", "dee"] as const).map((role) => ({
      golferId: placeholderIds[role],
      lines: archives.map((archive, i): StoredLine => ({ ...archiveGolferLine(archive, placeholderIds[role]), finalizedAtMs: i })),
    }));
    const scoreboard = crewScoreboard(members, { startMs: 0 });
    expect(scoreboard).toEqual(frozenScoreboardExpectation(placeholderIds));

    // Expected shape (crew-scoreboard spec §3a, verified rather than assumed): 12 rounds each;
    // best18/netPer18/index all present (>=3 qualifying lines clears the netPer18 floor); no
    // member has a pre-window line, so indexDelta is ABSENT for everyone — never a `0`/`undefined`
    // value sitting on the object, no key at all.
    expect(scoreboard).toHaveLength(4);
    for (const row of scoreboard) {
      expect(row.rounds).toBe(SEASON_ROUNDS);
      expect(row.best18).toBeDefined();
      expect(row.netPer18).toBeDefined();
      expect(row.index).toBeDefined();
      expect(row).not.toHaveProperty("indexDelta");
    }
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

  test("4: a season created AFTER the 12 rounds still contains them — the window reaches back, no counting act", async () => {
    test.setTimeout(60_000);
    const { httpUrl } = loadWebEnv();

    const created = await createSeasonDirect(httpUrl, al.tokens.idToken, crewId, SEASON_NAME);
    seasonId = created.season.seasonId;
    expect(created.season.name).toBe(SEASON_NAME);
    expect(created.season.status).toBe("open");

    // The window rule reaches back (crew-scoreboard spec §2): with no closed seasons yet, this
    // season's own window starts Jan 1 UTC of THIS year — comfortably covering all 12 rounds
    // played moments ago in test 3 — with no per-round counting act anywhere. Al is the crew's
    // ONLY member here (Bo/Cy/Dee hold accounts and played every round, but joined no roster
    // until test 8), and a scoreboard row needs only ITS OWN golfer on the roster — unlike the
    // together-folds below, crewScoreboard counts a member's OWN in-window lines regardless of
    // roster size — so `standings.scoreboard` is EXACTLY Al's frozen row (plus his roster name),
    // the full upgrade of the provisional `rounds === 12` check this test used to make (crew-
    // scoreboard plan Task 4 Step 2). `standings.rounds` — the DERIVED "played together" list —
    // stays empty here: sharedRoundIds requires >=2 CURRENT roster members holding a line for the
    // same round (spec §3a/§3b) — it populates once Bo joins.
    const standings = await getSeasonStandingsDirect(httpUrl, al.tokens.idToken, crewId, seasonId);
    expect(standings.scoreboard).toEqual(expectedScoreboardRows(new Set<GolferId>([ids.al])));
    expect(standings.rounds).toEqual([]);
  });

  // TASK-3 FINDING (flagged for Task 4, which owns the new live oracles): under the
  // crew-scoreboard redesign, EVERY together-fold (ledger/headToHead/partners), not merely the
  // "played together" `rounds` list, is derived from `sharedRoundIds` — which is undefined
  // (empty) whenever fewer than 2 CURRENT roster members hold a line for the same round. With Al
  // ALONE on the roster (as this deck's steps 5-7 deliberately are), `getSeasonStandings` never
  // even FETCHES an archive — the frozen ledger/H2H numbers this test used to verify against a
  // solo-counted list are consequently unreachable here now; they first become verifiable once
  // Bo joins the roster in test 8 (both hold lines for every round → sharedRoundIds returns all
  // 12 → the together-folds run for real). This is a genuine, load-bearing behavior change from
  // the old counted-round model (where a lone member's own counted round DID populate a ledger
  // row) — not a gap in this reconciliation task's own derivation.
  test("5: with Al alone on the roster, the together-folds are honestly empty — 'played together' needs a second member", async () => {
    const { httpUrl } = loadWebEnv();
    const standings = await getSeasonStandingsDirect(httpUrl, al.tokens.idToken, crewId, seasonId);

    expect(standings.seasonId).toBe(seasonId);
    expect(standings.name).toBe(SEASON_NAME);
    expect(standings.status).toBe("open");

    // "Played together" needs >=2 CURRENT roster members (spec §3a) — Al is still alone, so
    // nothing together-shaped exists yet, even though he played all 12 rounds himself (test 4's
    // own scoreboard-row proof of that).
    expect(standings.rounds).toEqual([]);
    expect(standings.ledger).toEqual([]);
    expect(standings.headToHead).toEqual([]);
    expect(standings.partners).toEqual(EXPECTED_PARTNERS); // [] either way — no four-ball in the deck at all
  });

  // Test 6 (un-count/re-count round 1) is DELETED whole (crew-scoreboard plan Task 3, Step 5):
  // the counting apparatus it exercised is gone from standings' own derivation (a round is
  // shared or it isn't, purely by window + roster — nothing to un-count or re-count). Its window
  // replacement (closing a season and proving a round played after the close stays out, then
  // re-enters on reopen) lands in Task 4.

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
    expect(post.metrics.whsIndex?.value).toBe(pre.metrics.whsIndex?.value);
    expect(post.metrics.whsIndex?.differentialsUsed).toBe(pre.metrics.whsIndex?.differentialsUsed);

    // Rebuild parity must cover the holeResults-DERIVED metrics too — history/whsIndex equality
    // alone would pass a rebuild that dropped holeResults (whole-branch review, 2026-07-21).
    expect(post.metrics.bests).toEqual(pre.metrics.bests);
    expect(post.metrics.milestones).toEqual(pre.metrics.milestones);

    expect(post.metrics.whsIndex?.computedAtMs).not.toBe(pre.metrics.whsIndex?.computedAtMs);

    // Standings are computed on read from the DERIVED shared rounds — there is no season
    // projection for a rebuild to touch, and membership itself is untouched by a rebuild (it
    // lives on the crew, not the golfer projection a rebuild replays). Al is still the roster's
    // only member (test 5's own finding: "played together" needs a second member), so the
    // together-folds stay honestly empty through the rebuild too — the same law, not a special
    // case of it.
    const standings = await getSeasonStandingsDirect(httpUrl, al.tokens.idToken, crewId, seasonId);
    expect(standings.rounds).toEqual([]);
    expect(standings.ledger).toEqual([]);
    expect(standings.headToHead).toEqual([]);
    expect(standings.partners).toEqual(EXPECTED_PARTNERS);
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

    // The board now carries Bo's frozen row too (crew-scoreboard plan Task 4 Step 2) — the
    // aggregation-scope law reaching the scoreboard exactly as it reaches the ledger above.
    expect(standings.scoreboard).toEqual(expectedScoreboardRows(memberIds));

    // The deferred ⚠️ (task-3 review): `standings.rounds` — "played together" — is now POPULATED
    // with >=2 CURRENT roster members sharing a line on every one of the 12 deck rounds. Asserted
    // as an actual SET (not merely a length) against the roundIds test 3 minted, in the wire's
    // `{roundId, finalizedAt}` shape, newest-first by finalizedAt (getSeasonStandings.ts's own
    // sort) — a real ordering property, not just "some rounds came back."
    expect(standings.rounds).toHaveLength(SEASON_ROUNDS);
    expect([...standings.rounds.map((round) => round.roundId)].sort()).toEqual([...roundIds].sort());
    for (let i = 1; i < standings.rounds.length; i += 1) {
      expect(standings.rounds[i - 1]!.finalizedAt).toBeGreaterThanOrEqual(standings.rounds[i]!.finalizedAt);
    }

    // Additive analytics with Bo now scoped in (spec §5): still no four-ball → partners [].
    expect(standings.partners).toEqual(EXPECTED_PARTNERS);
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

    // Al alone again — "played together" needs >=2 CURRENT roster members (spec §3a/test 5's
    // own finding), so the together-folds go straight back to empty, not to Al's own frozen row
    // (nothing about a together-fold can name a lone member — that is what "together" means).
    const standingsAfterRemoval = await getSeasonStandingsDirect(httpUrl, al.tokens.idToken, crewId, seasonId);
    expect(standingsAfterRemoval.rounds).toEqual([]);
    expect(standingsAfterRemoval.ledger).toEqual([]);
    expect(standingsAfterRemoval.headToHead).toEqual([]);
    expect(standingsAfterRemoval.partners).toEqual(EXPECTED_PARTNERS);

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

    expect(standingsAfterRejoin.partners).toEqual(EXPECTED_PARTNERS);
  });

  test("9: all-time crew records fold every counted round across all seasons — closing the season awards its Stableford title, reopening empties it", async () => {
    test.setTimeout(120_000);
    const { httpUrl } = loadWebEnv();
    const frozen = frozenSeasonExpectation(ids);
    // The roster after 8b is {Al, Bo} again (Bo re-joined), and all 12 rounds are counted into the
    // one season. GET /crews/{crewId}/records folds ALL seasons' counted rounds deduped by roundId
    // (getCrewRecords.ts) — with a single season that is just the 12 rounds once.
    const records = await getCrewRecordsDirect(httpUrl, al.tokens.idToken, crewId);
    const memberIds = new Set<GolferId>([ids.al, ids.bo]);

    // rounds = distinct counted rounds all-time = the 12 of the one season.
    expect(records.rounds).toBe(SEASON_ROUNDS);

    // All-time ledger/head-to-head fold through the SAME roster-filtered aggregateSeason as the
    // season standings (getCrewRecords reuses getSeasonStandings' rosterFilteredContribution), so
    // over one season of all 12 rounds they equal the frozen expectation filtered to {Al, Bo}
    // exactly — byte-identical to step 8's own standings ledger/head-to-head.
    expect(records.ledger).toEqual(expectedStandingLines(frozen.ledger, memberIds));
    expect(records.headToHead).toEqual(expectedHeadToHead(frozen.headToHead, memberIds));

    // Partners: still no four-ball in the deck → [].
    expect(records.partners).toEqual(EXPECTED_PARTNERS);

    // Titles are a READ FOLD over CLOSED seasons ONLY (getCrewRecords.ts: `if (season.status !==
    // "closed") continue`) — nothing about a title is ever stored (close-season spec §1.3/§3). The
    // one season is still OPEN on every read above, so `titles` is [] here NOT because no close
    // route exists (the analytics arc's provisional reason, now retired by the close-season arc)
    // but because the season simply isn't closed yet. That is the assertion the analytics arc's
    // comment promised this arc would replace — the derivation below is the replacement.
    expect(records.titles).toEqual([]);

    // --- The crown, hand-derived from the FROZEN deck (the oracle discipline: derived here, never
    // read back off the system) --------------------------------------------------------------------
    // Roster at step 9 = {Al, Bo} (Bo re-joined in 8b; Cy/Dee held accounts all season but joined
    //   no roster) — the same `memberIds` every assertion above filters against.
    // A season's title is its Stableford POINTS leader(s) over the CURRENT-ROSTER-filtered ledger:
    //   getCrewRecords → stablefordTitle(seasonLedger), where seasonLedger is aggregateSeason over
    //   rosterFilteredContribution — the SAME fold `records.ledger` above already asserts. The
    //   roster-filtered Stableford points over all 12 counted rounds (crewSeasonDeck.ts FROZEN_LINE):
    //       Al 430, Bo 430   (Cy/Dee's 435 apiece are FILTERED OUT — neither is on the roster)
    //   maxPoints = 430 > 0, so a title IS awarded; Al and Bo TIE at 430, so BOTH are crowned
    //   (stablefordTitle returns every line at the max). The raw deck leaders are Cy/Dee at 435, but
    //   the roster filter never lets them into this ledger — the aggregation-scope law reaching the
    //   title itself.
    // stablefordTitle sorts its winners by golferId ASCENDING (analytics arc Task 4's pin), and
    //   getCrewRecords preserves that order into `golfers`, each `{ golferId, name }` with name from
    //   the roster's own CrewMember.name (Al→"Al", Bo→"Bo", asserted in steps 2/8/8b). golferIds are
    //   live-minted per run, so the pin is expressed via the deck handles + the same ascending sort,
    //   exactly like expectedStandingLines — not literal ids. The entry's seasonId/name are the one
    //   live-minted season's own (`seasonId` from step 4, SEASON_NAME).
    const closed = await closeSeasonDirect(httpUrl, al.tokens.idToken, crewId, seasonId);
    expect(closed.season.status).toBe("closed");

    const closedRecords = await getCrewRecordsDirect(httpUrl, al.tokens.idToken, crewId);
    const expectedTitles: CrewRecordsResponse["titles"] = [
      {
        seasonId,
        name: SEASON_NAME,
        golfers: [ids.al, ids.bo].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((id) => ({ golferId: id, name: nameOf(id) })),
      },
    ];
    expect(closedRecords.titles).toEqual(expectedTitles);

    // Closing is a read-time filter on `titles` ALONE — the counted rounds and the standings fold
    // are untouched, so everything else about the records is byte-identical to the open read above.
    expect(closedRecords.rounds).toBe(SEASON_ROUNDS);
    expect(closedRecords.ledger).toEqual(expectedStandingLines(frozen.ledger, memberIds));
    expect(closedRecords.headToHead).toEqual(expectedHeadToHead(frozen.headToHead, memberIds));
    expect(closedRecords.partners).toEqual(EXPECTED_PARTNERS);

    // Reopen — the crown simply stops appearing (reopening un-awards nothing durable; titles are a
    // read fold, spec §1.3). This also returns the season to `open`, so it ends this spec in exactly
    // the state it began (never closed), leaving reruns and every other suite with no residue.
    const reopened = await reopenSeasonDirect(httpUrl, al.tokens.idToken, crewId, seasonId);
    expect(reopened.season.status).toBe("open");

    const reopenedRecords = await getCrewRecordsDirect(httpUrl, al.tokens.idToken, crewId);
    expect(reopenedRecords.titles).toEqual([]);
  });

  test("10: the window on the wire — a gameless 13th round stays out at close, then ticks the scoreboard on reopen; the together-fold never moves", async () => {
    test.setTimeout(120_000);
    const { httpUrl } = loadWebEnv();
    const frozen = frozenSeasonExpectation(ids);
    // Roster is still {Al, Bo}: test 8b's re-join, unchanged by test 9's own close/reopen cycle
    // (closing/reopening touches ONLY `status`/`closedAtMs` — never membership).
    const memberIds = new Set<GolferId>([ids.al, ids.bo]);

    // "The Golden Dozen" closes AGAIN (organizer Al) — closedAtMs stamps NOW, strictly after all
    // 12 deck rounds (played moments ago, in test 3) and strictly before the round about to be
    // played below (crew-scoreboard plan Task 4 Step 3, spec §2's window-end rule live).
    const closed = await closeSeasonDirect(httpUrl, al.tokens.idToken, crewId, seasonId);
    expect(closed.season.status).toBe("closed");

    // A 13th round, shared by Al+Bo ONLY, with NO games — deliberately OUTSIDE the frozen deck
    // (crewSeasonDeck.ts's own machinery is untouched by this test; the round exists only to
    // prove the window, never to move a single frozen number). Join + score + finalize via the
    // same out-of-browser helpers test 3 already uses, minus addGameDirect entirely — a
    // gameless round is exactly what spec §3b's "contributes nothing to the together-fold" needs.
    const started = await startRoundDirect(httpUrl, al, { course, tee: "member", courseHandicap: 0 });
    expect(started.golferId).toBe(ids.al);
    const joined = await joinRoundDirect(httpUrl, bo, { code: started.joinCode, tee: "member", courseHandicap: 0 });
    expect(joined.golferId).toBe(ids.bo);

    const ops = createScoreOps("crew-r13");
    for (let hole = 1; hole <= HOLES; hole += 1) {
      await Promise.all([
        recordScoreDirect(httpUrl, started.roundId, started.token, { golferId: ids.al, hole, strokes: 4 }, ops),
        recordScoreDirect(httpUrl, started.roundId, started.token, { golferId: ids.bo, hole, strokes: 4 }, ops),
      ]);
    }
    await finalizeRoundDirect(httpUrl, started.roundId, started.token);

    // Closed standings: the window's end (closedAtMs, stamped above) is BEFORE this round's
    // played date, so it stays OUT — `rounds` is still the same 12 deck roundIds, and every
    // window-derived fold (the together-fold AND the scoreboard alike) reads byte-identical to
    // test 9's own closed read.
    const closedStandings = await getSeasonStandingsDirect(httpUrl, al.tokens.idToken, crewId, seasonId);
    expect(closedStandings.rounds).toHaveLength(SEASON_ROUNDS);
    expect([...closedStandings.rounds.map((round) => round.roundId)].sort()).toEqual([...roundIds].sort());
    expect(closedStandings.ledger).toEqual(expectedStandingLines(frozen.ledger, memberIds));
    expect(closedStandings.headToHead).toEqual(expectedHeadToHead(frozen.headToHead, memberIds));
    expect(closedStandings.partners).toEqual(EXPECTED_PARTNERS);
    // Full-row equality here leans on round 13 being ALL PARS: `index` is career-scoped (never
    // windowed), and a par round's 0.0 differential displaces nobody's lowest-4 — lower round
    // 13's scores and this closed-read assertion breaks on `index` even though the window held.
    expect(closedStandings.scoreboard).toEqual(expectedScoreboardRows(memberIds));

    // Reopen — the window opens back up (closedAtMs cleared), so the 13th round now falls inside
    // it: `rounds` grows to 13 (the round-13 roundId joins the set), and Al/Bo's own scoreboard
    // `rounds` tick to 13 right alongside it (crewScoreboard counts a member's OWN in-window
    // lines, roster size irrelevant — test 4's own rule). The ledger/head-to-head STILL don't
    // move: a gameless round contributes NOTHING to crewContribution (no games -> no lines, no
    // head-to-head entries) — the together-fold's own truth, not a special case carved out for
    // this test.
    const reopened = await reopenSeasonDirect(httpUrl, al.tokens.idToken, crewId, seasonId);
    expect(reopened.season.status).toBe("open");

    const reopenedStandings = await getSeasonStandingsDirect(httpUrl, al.tokens.idToken, crewId, seasonId);
    expect(reopenedStandings.rounds).toHaveLength(SEASON_ROUNDS + 1);
    expect(reopenedStandings.rounds.map((round) => round.roundId)).toContain(started.roundId);
    expect(reopenedStandings.ledger).toEqual(expectedStandingLines(frozen.ledger, memberIds));
    expect(reopenedStandings.headToHead).toEqual(expectedHeadToHead(frozen.headToHead, memberIds));
    expect(reopenedStandings.partners).toEqual(EXPECTED_PARTNERS);

    const reopenedAlRow = reopenedStandings.scoreboard.find((row) => row.golferId === ids.al);
    const reopenedBoRow = reopenedStandings.scoreboard.find((row) => row.golferId === ids.bo);
    expect(reopenedAlRow?.rounds).toBe(SEASON_ROUNDS + 1);
    expect(reopenedBoRow?.rounds).toBe(SEASON_ROUNDS + 1);

    // The season is left OPEN — nothing follows this test (crew-scoreboard plan Task 4 Step 3).
  });
});
