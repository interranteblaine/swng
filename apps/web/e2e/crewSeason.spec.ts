import { expect, test } from "@playwright/test";
import type { GetMyRecordResponse, PartnerStandingRecord, ScoreboardRow, SeasonStandingLine } from "@swng/contracts";
import { archiveGolferLine, crewScoreboard, golferId } from "@swng/domain";
import type { CrewId, GolferId, HeadToHeadRecord, RoundId, SeasonLedgerLine, StoredLine } from "@swng/domain";
import {
  addGameDirect,
  createCrewDirect,
  createScoreOps,
  createSeasonDirect,
  ensureCourse,
  finalizeRoundDirect,
  getCrewDirect,
  getMyRecordDirect,
  getSeasonStandingsDirect,
  invokeRebuild,
  joinCrewDirect,
  joinRoundDirect,
  listSeasonsDirect,
  loadWebEnv,
  mintAccountGolfer,
  mintCrewInviteDirect,
  pollUntil,
  recordScoreDirect,
  removeCrewMemberDirect,
  startRoundDirect,
  updateCrewDirect,
  updateSeasonDirect,
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
    expect(created.crew.members).toEqual([{ golferId: ids.al, name: "Al", role: "organizer" }]);

    // Every crew is born alive (createCrew.ts, spec 2026-07-22 "the season is the record" §2):
    // its FIRST season exists before anyone asks — named for the current calendar year, with
    // VISIBLE Jan 1 – Dec 31 dates, no derivation and no `status`. `year` is read live, NEVER a
    // literal — a hardcoded year would fail the moment the calendar rolls. It's the only season
    // on a just-created crew.
    const year = new Date().getUTCFullYear();
    const seasons = await listSeasonsDirect(httpUrl, al.tokens.idToken, crewId);
    expect(seasons.seasons).toHaveLength(1);
    expect(seasons.seasons[0]).toMatchObject({ name: String(year), startsAt: `${year}-01-01`, endsAt: `${year}-12-31` });
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
      const started = await startRoundDirect(httpUrl, al, { course, tee: "member", basis: { kind: "normally-shoots", overPar: 0 } });
      expect(started.golferId).toBe(ids.al); // as-self: the host seat is Al's account golfer, never a fresh id

      for (const account of [bo, cy, dee]) {
        const joined = await joinRoundDirect(httpUrl, account, { code: started.joinCode, tee: "member", basis: { kind: "normally-shoots", overPar: 0 } });
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

    // Spec 2026-07-22 "the season is the record" §1/§2: dates are CHOSEN and REQUIRED now, no
    // tiling rule — the CURRENT UTC year's own Jan 1 – Dec 31 window is what "reaches back"
    // means here, comfortably covering all 12 rounds played moments ago in test 3.
    const year = new Date().getUTCFullYear();
    const created = await createSeasonDirect(httpUrl, al.tokens.idToken, crewId, SEASON_NAME, `${year}-01-01`, `${year}-12-31`);
    seasonId = created.season.seasonId;
    expect(created.season.name).toBe(SEASON_NAME);
    expect(created.season).toMatchObject({ startsAt: `${year}-01-01`, endsAt: `${year}-12-31` });

    // Al is the crew's ONLY member here (Bo/Cy/Dee hold accounts and played every round, but
    // joined no roster until test 8), and a scoreboard row needs only ITS OWN golfer on the
    // roster — unlike the together-folds below, crewScoreboard counts a member's OWN in-window
    // lines regardless of roster size — so `standings.scoreboard` is EXACTLY Al's frozen row
    // (plus his roster name). `standings.rounds` — the DERIVED "played together" list — stays
    // empty here: sharedRoundIds requires >=2 CURRENT roster members holding a line for the
    // same round (spec §3a/§3b) — it populates once Bo joins.
    // The scoreboard reads the async golfer projection (DynamoDB Streams), unlike the
    // snapshot-fed together-folds — poll for projection catch-up before reading standings; this
    // pins the race, it never launders the values asserted below.
    await pollUntil(
      () => getMyRecordDirect(httpUrl, al.tokens.idToken),
      (record) => record.history.length >= SEASON_ROUNDS,
      120_000,
      "Al's record (scoreboard projection catch-up)",
    );

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
  // replacement — a season whose declared dates exclude the deck's rounds, then a live edit that
  // widens the window to include them — is THIS test (Task 4, spec 2026-07-22 §1/§2: editing the
  // end date IS the whole lifecycle now, no separate close/reopen).
  test("6: a season windowed entirely in the past holds zero rounds; widening its endsAt to the present re-scopes them in live", async () => {
    test.setTimeout(60_000);
    const { httpUrl } = loadWebEnv();

    // A fixed PAST literal year is the ONE place a hardcoded year is correct in this whole file
    // (task-4-brief.md's own carve-out): the point of this half is a window that EXCLUDES the
    // live "now" rounds test 3 just played, so it must fall before any real run of this suite —
    // unlike every other date in this file, it must NOT track `new Date().getUTCFullYear()`.
    const past = await createSeasonDirect(httpUrl, al.tokens.idToken, crewId, "Ancient History", "2020-01-01", "2020-12-31");
    const pastSeasonId = past.season.seasonId;
    expect(past.season).toMatchObject({ name: "Ancient History", startsAt: "2020-01-01", endsAt: "2020-12-31" });

    // Date exclusion, proven live: every one of Al's 12 rounds finalized moments ago in test 3,
    // well outside 2020 — crewScoreboard.ts still returns a row per roster member (Al alone,
    // here) but with zero in-window lines, so `rounds: 0` and neither best18 nor netPer18 (both
    // window-scoped). `index` is deliberately NOT asserted here — it folds the golfer's WHOLE
    // career regardless of window (scoreboard.ts's own rule), so it's real even on an empty
    // window; asserting it absent would be asserting something false about the model.
    const excluded = await getSeasonStandingsDirect(httpUrl, al.tokens.idToken, crewId, pastSeasonId);
    expect(excluded.scoreboard).toHaveLength(1);
    expect(excluded.scoreboard[0]).toMatchObject({ golferId: ids.al, name: "Al", rounds: 0 });
    expect(excluded.scoreboard[0]).not.toHaveProperty("best18");
    expect(excluded.scoreboard[0]).not.toHaveProperty("netPer18");
    // "Played together" and the together-folds need >=2 CURRENT roster members regardless of
    // window (test 5's own finding) — Al is still alone here, so these stay empty for that
    // reason too, not merely because the window excludes everything.
    expect(excluded.rounds).toEqual([]);
    expect(excluded.ledger).toEqual([]);
    expect(excluded.headToHead).toEqual([]);

    // Editing the window IS the whole lifecycle (spec §2, replacing the deleted close/reopen
    // pair): widen endsAt to the CURRENT UTC year's Dec 31 — read live, NEVER a literal, since a
    // hardcoded current year would empty the board the moment the calendar rolls — and the same
    // 12 rounds that were excluded above appear on the very next read, no re-creation needed.
    const year = new Date().getUTCFullYear();
    const widened = await updateSeasonDirect(httpUrl, al.tokens.idToken, crewId, pastSeasonId, { endsAt: `${year}-12-31` });
    expect(widened.season).toMatchObject({ name: "Ancient History", startsAt: "2020-01-01", endsAt: `${year}-12-31` });

    const included = await getSeasonStandingsDirect(httpUrl, al.tokens.idToken, crewId, pastSeasonId);
    expect(included.scoreboard).toHaveLength(1);
    expect(included.scoreboard[0]?.golferId).toBe(ids.al);
    expect(included.scoreboard[0]?.rounds).toBe(SEASON_ROUNDS);
    expect(included.scoreboard[0]?.best18).toBeDefined();
    expect(included.scoreboard[0]?.netPer18).toBeDefined();
    expect(included.scoreboard[0]?.index).toBeDefined();
    // Al is still the roster's only member (Bo doesn't join until test 8) — the together-folds
    // stay honestly empty through the widen too, the same law as above, not a special case of it.
    expect(included.rounds).toEqual([]);
    expect(included.ledger).toEqual([]);
    expect(included.headToHead).toEqual([]);
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
    // `{roundId, finalizedAt, courseName, createdAt?}` shape (grown by spec 2026-07-22 §3 so the
    // "Played together" list renders the canonical roundLabel), newest-first by finalizedAt
    // (getSeasonStandings.ts's own sort) — a real ordering property, not just "some rounds came back."
    expect(standings.rounds).toHaveLength(SEASON_ROUNDS);
    expect([...standings.rounds.map((round) => round.roundId)].sort()).toEqual([...roundIds].sort());
    for (let i = 1; i < standings.rounds.length; i += 1) {
      expect(standings.rounds[i - 1]!.finalizedAt).toBeGreaterThanOrEqual(standings.rounds[i]!.finalizedAt);
    }
    // The canonical-label inputs land live: every shared round carries the deck course's OWN name
    // (frozen into each golfer line at play time, echoed here for roundLabel to render as
    // "‹course› · ‹date›" instead of a bare locale date) — the Task 2 wire+server change, proven
    // over the wire against beta, not merely unit-mocked.
    expect(standings.rounds.every((round) => round.courseName === courseName)).toBe(true);

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

  // Test 9 (all-time crew records) is DELETED whole (spec 2026-07-22 "the season is the record"
  // §4): the All-time surface — GET /crews/{crewId}/records, its use case, and its route — is
  // gone outright, not merely title-less. A season can represent any span, including effectively
  // all of a crew's history, by stating wide dates, so a second surface aggregating "everything"
  // is redundant machinery; lifetime head-to-head is a wide-dated season's own games table now.
  // The window-pin tests that cover that path (a season created with both dates in the past, then
  // widened via updateSeasonDirect) are test 6 above, Task 4's own deliverable.

  // Sequenced LAST, deliberately: "The Saturday Boys" (test 2) is the only crew-name literal
  // this file asserts anywhere, so renaming it here — after every other beat, including the
  // roster mutations in 8/8b — can't disturb a single earlier assertion that depends on the
  // original name.
  test("9: Al renames the crew — PUT /crews/{crewId} lands on the wire, a fresh GET returns it", async () => {
    test.setTimeout(60_000);
    const { httpUrl } = loadWebEnv();

    const renamed = await updateCrewDirect(httpUrl, al.tokens.idToken, crewId, "The Saturday Regulars");
    expect(renamed.crew.name).toBe("The Saturday Regulars");
    // The roster itself is untouched by a rename — the crew-name-edit path is orthogonal to
    // membership (Al + Bo, restored by test 8b's own rejoin).
    expect(renamed.crew.members.map((member) => member.golferId).sort()).toEqual([ids.al, ids.bo].sort());

    // Not merely echoed by the mutation's own response — a SEPARATE GET proves it actually
    // landed server-side.
    const fetched = await getCrewDirect(httpUrl, al.tokens.idToken, crewId);
    expect(fetched.crew.name).toBe("The Saturday Regulars");
  });
});
