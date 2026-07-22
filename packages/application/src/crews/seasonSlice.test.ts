import { describe, expect, it } from "vitest";
import { cellKey, deviceId, fixtureLinks18, gameId, golferId, golferMetrics, opId, roundId } from "@swng/domain";
import type { GolferId, GolferRoundLine, Participant, RoundArchive, RoundEvent, ScoreCell } from "@swng/domain";
import type { AccountClaims } from "../ports/accountClaims.js";
import {
  createFixedClock,
  createFrozenClock,
  createInMemoryCrewStore,
  createInMemoryGolferStore,
  createInMemoryProjectionStore,
  createInMemorySnapshotStore,
  createSequentialIds,
  createTestTokenIssuer,
  putAndBindGolfer,
} from "../testing/fakes.js";
import { appendCountedRound } from "./appendCountedRound.js";
import { closeSeason } from "./closeSeason.js";
import { createCrew } from "./createCrew.js";
import { createSeason } from "./createSeason.js";
import { getCrewRecords } from "./getCrewRecords.js";
import { getSeasonStandings } from "./getSeasonStandings.js";
import { joinCrewByInvite } from "./joinCrewByInvite.js";
import { leaveCrew } from "./leaveCrew.js";
import { listSeasons } from "./listSeasons.js";
import { mintCrewInvite } from "./mintCrewInvite.js";
import { removeCountedRound } from "./removeCountedRound.js";
import { reopenSeason } from "./reopenSeason.js";
import { yearStartUtcMs } from "./seasonStart.js";

// A finalized-round snapshot (RoundArchive) with a decided singles match — the smallest shape
// crewContribution produces a ledger line + head-to-head entry from. `names` lets a test give
// the SAME golferId a different display name across rounds (the standings name-recency pin).
const singlesArchive = (
  id: string,
  wallMs: number,
  a: GolferId,
  b: GolferId,
  winner: GolferId,
  names: Readonly<Record<string, string>>,
): RoundArchive => {
  const gid = gameId(`s-${id}`);
  const finalized: RoundEvent = { kind: "round-finalized", opId: opId(`f-${id}`), hlc: { wallMs, counter: 0, deviceId: deviceId("server") }, authorId: a };
  return {
    roundId: roundId(id),
    card: fixtureLinks18,
    participants: [a, b].map((g): Participant => ({ golferId: g, name: names[g] ?? g, tee: "white", courseHandicap: 8 })),
    games: [{ kind: "singles-match", id: gid, a, b }],
    cells: {},
    events: [finalized],
    results: [{ kind: "singles-match", id: gid, outcome: { winner, closing: "3&2" }, thru: 16 }],
    terminatedGameIds: [],
    handicapping: [],
  };
};

// A fourball-match archive (analytics spec 2026-07-21 §5's own partner-records fixture shape,
// mirrored from domain/crew/analytics.test.ts's buildResultArchive — kept local since it's a
// different layer's own test) — participants included (unlike that domain fixture) so
// appendCountedRound's did-not-play gate has real roster data to check against.
const fourballArchive = (
  id: string,
  wallMs: number,
  a: readonly [GolferId, GolferId],
  b: readonly [GolferId, GolferId],
  winner: "a" | "b",
): RoundArchive => {
  const gid = gameId(`fb-${id}`);
  const finalized: RoundEvent = { kind: "round-finalized", opId: opId(`f-${id}`), hlc: { wallMs, counter: 0, deviceId: deviceId("server") }, authorId: a[0] };
  return {
    roundId: roundId(id),
    card: fixtureLinks18,
    participants: [...a, ...b].map((g): Participant => ({ golferId: g, name: g, tee: "white", courseHandicap: 8 })),
    games: [{ kind: "fourball-match", id: gid, a, b }],
    cells: {},
    events: [finalized],
    results: [{ kind: "fourball-match", id: gid, outcome: { winner, closing: "2&1" }, thru: 17 }],
    terminatedGameIds: [],
    handicapping: [],
  };
};

// A stableford archive (for the season-title superlative) — points handed in directly, same
// "config-only, cells irrelevant" shape crewContribution actually reads.
const stablefordArchive = (id: string, wallMs: number, players: readonly GolferId[], points: Readonly<Record<string, number>>): RoundArchive => {
  const gid = gameId(`sf-${id}`);
  const finalized: RoundEvent = { kind: "round-finalized", opId: opId(`f-${id}`), hlc: { wallMs, counter: 0, deviceId: deviceId("server") }, authorId: players[0]! };
  return {
    roundId: roundId(id),
    card: fixtureLinks18,
    participants: players.map((g): Participant => ({ golferId: g, name: g, tee: "white", courseHandicap: 8 })),
    games: [{ kind: "stableford", id: gid, players }],
    cells: {},
    events: [finalized],
    results: [{ kind: "stableford", id: gid, points: players.map((g) => ({ golferId: g, points: points[g] ?? 0 })) }],
    terminatedGameIds: [],
    handicapping: [],
  };
};

// ---- netAverages fixture: a single-golfer solo round with an EXACT gross (mirrors domain/crew/
// analytics.test.ts's own roundOf/cellsForGross — kept local, a different layer's own test) — so
// getSeasonStandings' own "pick the global-minimum net average, group exact ties" reduction runs
// against a real archive, not just netAverages' already-domain-tested array.
const teeSet18 = fixtureLinks18.teeSets[0]!;
const scoreCell = (golfer: GolferId, hole: number, strokes: number): ScoreCell => ({
  result: { kind: "strokes", strokes },
  recordedBy: golfer,
  hlc: { wallMs: hole, counter: 0, deviceId: deviceId("d") },
  opId: opId(`op-${golfer}-${hole}`),
});
const cellsForGross = (golfer: GolferId, gross: number): Record<string, ScoreCell> => {
  const [first, ...rest] = teeSet18.holes;
  const restSum = rest.reduce((sum, h) => sum + h.par, 0);
  return Object.fromEntries([
    [cellKey(golfer, first!.number), scoreCell(golfer, first!.number, gross - restSum)],
    ...rest.map((h): [string, ScoreCell] => [cellKey(golfer, h.number), scoreCell(golfer, h.number, h.par)]),
  ]);
};
const soloArchive = (id: string, wallMs: number, golfer: GolferId, courseHandicap: number, gross: number): RoundArchive => ({
  roundId: roundId(id),
  card: fixtureLinks18,
  participants: [{ golferId: golfer, name: String(golfer), tee: teeSet18.name, courseHandicap }],
  games: [],
  cells: cellsForGross(golfer, gross),
  events: [{ kind: "round-finalized", opId: opId(`f-${id}`), hlc: { wallMs, counter: 0, deviceId: deviceId("server") }, authorId: golfer }],
  results: [],
  handicapping: [],
  terminatedGameIds: [],
});

const setup = () => {
  const crewStore = createInMemoryCrewStore();
  const golferStore = createInMemoryGolferStore();
  const snapshots = createInMemorySnapshotStore();
  const projectionStore = createInMemoryProjectionStore();
  const tokenIssuer = createTestTokenIssuer();
  const ids = createSequentialIds("t");
  const clock = createFixedClock(1_000);
  return {
    crewStore,
    golferStore,
    snapshots,
    projectionStore,
    create: createCrew({ crewStore, golferStore, ids, clock }),
    // Crew membership (invited in, accountable out): the permanent join code is gone —
    // mint/join replace it. `mint` and `join` share this ctx's ONE tokenIssuer/clock, same as
    // every real caller shares ONE hmacTokenIssuer/system clock through compositionRoot.
    mint: mintCrewInvite({ crewStore, golferStore, tokenIssuer, clock }),
    join: joinCrewByInvite({ crewStore, golferStore, tokenIssuer, clock }),
    createSeason: createSeason({ crewStore, golferStore, ids, clock }),
    listSeasons: listSeasons({ crewStore, golferStore }),
    append: appendCountedRound({ crewStore, golferStore, snapshots, clock }),
    remove: removeCountedRound({ crewStore, golferStore }),
    close: closeSeason({ crewStore, golferStore, clock }),
    reopen: reopenSeason({ crewStore, golferStore }),
    standings: getSeasonStandings({ crewStore, golferStore, snapshots, projectionStore }),
    records: getCrewRecords({ crewStore, golferStore, snapshots }),
    leave: leaveCrew({ crewStore, golferStore }),
  };
};

const seedGolfer = async (ctx: ReturnType<typeof setup>, sub: string, name: string): Promise<GolferId> => {
  const id = golferId(`golfer-${sub}`);
  await putAndBindGolfer(ctx.golferStore, id, sub, name);
  return id;
};

const asClaims = (sub: string): AccountClaims => ({ sub });

// A crew with Ann (organizer) + Bo (joined), plus one open season. Returns everything a test
// needs to count rounds into it.
const crewWithSeason = async (ctx: ReturnType<typeof setup>) => {
  const ann = await seedGolfer(ctx, "ann", "Ann");
  const bo = await seedGolfer(ctx, "bo", "Bo");
  const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });
  const invite = await ctx.mint(asClaims("ann"), created.crew.crewId);
  await ctx.join(asClaims("bo"), { token: invite.token });
  const season = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2026" });
  return { ann, bo, crewId: created.crew.crewId, seasonId: season.season.seasonId };
};

describe("createCrew — auto-opened season window", () => {
  it("listSeasons yields exactly one OPEN season named for the year, startsAtMs === yearStartUtcMs(now) asserted directly (the start rule's no-closed-seasons arm)", async () => {
    const crewStore = createInMemoryCrewStore();
    const golferStore = createInMemoryGolferStore();
    const now = Date.UTC(2026, 5, 15); // June 15, 2026 (fixed) — mid-year, so Jan 1 is a real computation
    const create = createCrew({ crewStore, golferStore, ids: createSequentialIds("y"), clock: createFrozenClock(now) });
    await putAndBindGolfer(golferStore, golferId("golfer-ann"), "ann", "Ann");

    const created = await create(asClaims("ann"), { name: "Sunday Skins" });
    const seasons = await crewStore.listSeasons(created.crew.crewId);

    expect(seasons).toHaveLength(1);
    expect(seasons[0]).toMatchObject({ name: "2026", status: "open" });
    expect(seasons[0]!.startsAtMs).toBe(yearStartUtcMs(now));
    // Pinned literal too, not just self-referential against the function under test.
    expect(seasons[0]!.startsAtMs).toBe(Date.UTC(2026, 0, 1));
  });
});

describe("createSeason", () => {
  it("a member creates an OPEN season with a server-minted id", async () => {
    const ctx = setup();
    await seedGolfer(ctx, "ann", "Ann");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });

    const season = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "Summer Cup" });

    expect(season.season).toMatchObject({ name: "Summer Cup", status: "open" });
    expect(season.season.seasonId).not.toContain("#"); // opaque, server-minted (CrewStore's caller contract)
    expect(season.season.createdAtMs).toBeGreaterThan(0);
  });

  it("a non-member is rejected — not-a-member", async () => {
    const ctx = setup();
    await seedGolfer(ctx, "ann", "Ann");
    await seedGolfer(ctx, "stranger", "Stranger");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });

    await expect(ctx.createSeason(asClaims("stranger"), created.crew.crewId, { name: "2026" })).rejects.toMatchObject({ code: "not-a-member" });
  });

  it("a whitespace-only name is rejected — invalid-season-name, nothing created", async () => {
    const ctx = setup();
    await seedGolfer(ctx, "ann", "Ann");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });
    // createCrew auto-opens the crew's own first season (crew-scoreboard spec §2) — captured
    // BEFORE the rejected call so "nothing created" means exactly that, not "list is empty".
    const before = await ctx.listSeasons(asClaims("ann"), created.crew.crewId);

    await expect(ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "   " })).rejects.toMatchObject({ code: "invalid-season-name" });
    await expect(ctx.listSeasons(asClaims("ann"), created.crew.crewId)).resolves.toEqual(before);
  });

  it("a name past 60 characters is rejected — invalid-season-name", async () => {
    const ctx = setup();
    await seedGolfer(ctx, "ann", "Ann");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });

    await expect(ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "x".repeat(61) })).rejects.toMatchObject({ code: "invalid-season-name" });
  });
});

describe("listSeasons", () => {
  it("returns a member's crew seasons newest-first by createdAtMs, including the crew's own auto-opened season", async () => {
    const ctx = setup();
    await seedGolfer(ctx, "ann", "Ann");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });
    // createCrew auto-opens the crew's own first season (crew-scoreboard spec §2) — the
    // OLDEST of the three by construction, so it sorts last below.
    const auto = await ctx.listSeasons(asClaims("ann"), created.crew.crewId);
    const autoSeasonId = auto.seasons[0]!.seasonId;
    const first = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2025" });
    const second = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2026" });

    const listed = await ctx.listSeasons(asClaims("ann"), created.crew.crewId);
    // createFixedClock advances 1ms per call, so `second` has the later createdAtMs → first out.
    expect(listed.seasons.map((s) => s.seasonId)).toEqual([second.season.seasonId, first.season.seasonId, autoSeasonId]);
  });

  it("a non-member is rejected — not-a-member", async () => {
    const ctx = setup();
    await seedGolfer(ctx, "ann", "Ann");
    await seedGolfer(ctx, "stranger", "Stranger");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });

    await expect(ctx.listSeasons(asClaims("stranger"), created.crew.crewId)).rejects.toMatchObject({ code: "not-a-member" });
  });
});

describe("appendCountedRound", () => {
  it("member ∧ played ∧ snapshot exists ∧ season open → entry written", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    ctx.snapshots.record(singlesArchive("r1", 5_000, ann, bo, ann, {}));

    const appended = await ctx.append(asClaims("ann"), crewId, seasonId, { roundId: roundId("r1") });

    expect(appended.round).toEqual({ roundId: roundId("r1"), finalizedAt: 5_000, appendedBy: ann });
    expect(await ctx.crewStore.listCountedRounds(crewId, seasonId)).toHaveLength(1);
  });

  it("a non-member is rejected — not-a-member", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    await seedGolfer(ctx, "stranger", "Stranger");
    ctx.snapshots.record(singlesArchive("r1", 5_000, ann, bo, ann, {}));

    await expect(ctx.append(asClaims("stranger"), crewId, seasonId, { roundId: roundId("r1") })).rejects.toMatchObject({ code: "not-a-member" });
  });

  it("an unknown seasonId is rejected — season-not-found", async () => {
    const ctx = setup();
    const { ann, bo, crewId } = await crewWithSeason(ctx);
    ctx.snapshots.record(singlesArchive("r1", 5_000, ann, bo, ann, {}));

    await expect(ctx.append(asClaims("ann"), crewId, "no-such-season", { roundId: roundId("r1") })).rejects.toMatchObject({ code: "season-not-found" });
  });

  it("a round with no snapshot yet is rejected — round-not-found (finish the round first)", async () => {
    const ctx = setup();
    const { crewId, seasonId } = await crewWithSeason(ctx);

    await expect(ctx.append(asClaims("ann"), crewId, seasonId, { roundId: roundId("never-finalized") })).rejects.toMatchObject({ code: "round-not-found" });
  });

  it("a member who did NOT play the round is rejected — did-not-play", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    const cy = await seedGolfer(ctx, "cy", "Cy");
    const invite = await ctx.mint(asClaims("ann"), crewId);
    await ctx.join(asClaims("cy"), { token: invite.token });
    // The round is Ann vs Bo — Cy is a member but wasn't in it.
    ctx.snapshots.record(singlesArchive("r1", 5_000, ann, bo, ann, {}));
    expect(cy).toBeDefined();

    await expect(ctx.append(asClaims("cy"), crewId, seasonId, { roundId: roundId("r1") })).rejects.toMatchObject({ code: "did-not-play" });
  });

  it("the SAME round appended twice into one season is rejected — round-already-counted", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    ctx.snapshots.record(singlesArchive("r1", 5_000, ann, bo, ann, {}));
    await ctx.append(asClaims("ann"), crewId, seasonId, { roundId: roundId("r1") });

    await expect(ctx.append(asClaims("ann"), crewId, seasonId, { roundId: roundId("r1") })).rejects.toMatchObject({ code: "round-already-counted" });
  });

  it("a CLOSED season rejects an append — season-closed", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    ctx.snapshots.record(singlesArchive("r1", 5_000, ann, bo, ann, {}));
    // Close via the organizer's own verb — end to end, now reachable (close-season arc).
    await ctx.close(asClaims("ann"), crewId, seasonId);

    await expect(ctx.append(asClaims("ann"), crewId, seasonId, { roundId: roundId("r1") })).rejects.toMatchObject({ code: "season-closed" });
  });
});

describe("removeCountedRound", () => {
  it("the appender may remove their own counted round", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    ctx.snapshots.record(singlesArchive("r1", 5_000, ann, bo, ann, {}));
    await ctx.append(asClaims("ann"), crewId, seasonId, { roundId: roundId("r1") });

    const removed = await ctx.remove(asClaims("ann"), crewId, seasonId, roundId("r1"));

    expect(removed).toEqual({ roundId: roundId("r1") });
    expect(await ctx.crewStore.listCountedRounds(crewId, seasonId)).toHaveLength(0);
  });

  it("a member who did NOT append it may not remove it — not-the-appender", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    // Both Ann and Bo played; Bo appends it, so Ann may not remove it.
    ctx.snapshots.record(singlesArchive("r1", 5_000, ann, bo, ann, {}));
    await ctx.append(asClaims("bo"), crewId, seasonId, { roundId: roundId("r1") });

    await expect(ctx.remove(asClaims("ann"), crewId, seasonId, roundId("r1"))).rejects.toMatchObject({ code: "not-the-appender" });
    expect(await ctx.crewStore.listCountedRounds(crewId, seasonId)).toHaveLength(1); // still there
  });

  it("removing a round that was never counted is an idempotent no-op success", async () => {
    const ctx = setup();
    const { crewId, seasonId } = await crewWithSeason(ctx);

    await expect(ctx.remove(asClaims("ann"), crewId, seasonId, roundId("never"))).resolves.toEqual({ roundId: roundId("never") });
  });

  it("a CLOSED season rejects a remove — season-closed", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    ctx.snapshots.record(singlesArchive("r1", 5_000, ann, bo, ann, {}));
    await ctx.append(asClaims("ann"), crewId, seasonId, { roundId: roundId("r1") });
    // Close via the organizer's own verb — end to end, now reachable (close-season arc).
    await ctx.close(asClaims("ann"), crewId, seasonId);

    await expect(ctx.remove(asClaims("ann"), crewId, seasonId, roundId("r1"))).rejects.toMatchObject({ code: "season-closed" });
  });
});

describe("getSeasonStandings", () => {
  it("folds the counted snapshots through crewContribution/aggregateSeason, newest-round-first", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    ctx.snapshots.record(singlesArchive("r1", 5_000, ann, bo, ann, {})); // Ann beats Bo
    ctx.snapshots.record(singlesArchive("r2", 9_000, ann, bo, bo, {})); // Bo beats Ann
    await ctx.append(asClaims("ann"), crewId, seasonId, { roundId: roundId("r1") });
    await ctx.append(asClaims("bo"), crewId, seasonId, { roundId: roundId("r2") });

    const standings = await ctx.standings(asClaims("ann"), crewId, seasonId);

    expect(standings).toMatchObject({ seasonId, name: "2026", status: "open" });
    expect(standings.rounds.map((r) => r.roundId)).toEqual([roundId("r2"), roundId("r1")]); // newest-first
    expect(standings.ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ golferId: ann, wins: 1, losses: 1 }),
        expect.objectContaining({ golferId: bo, wins: 1, losses: 1 }),
      ]),
    );
    expect(standings.headToHead).toEqual([expect.objectContaining({ aWins: 1, bWins: 1, halves: 0 })]);
  });

  // Architecture-realignment Phase 3 correction (spec §11a, 2026-07-13, owner ruling): a crew
  // is a grouping/competition ONLY — standings aggregate the CURRENT roster, full stop. A
  // golfer in a counted round who never made the roster contributes no row and no
  // head-to-head pair; a roster member's OWN row in that same round is untouched.
  it("a golfer in a counted round who is NOT on the roster yields no row for them and no head-to-head pair", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    const guest = golferId("gus"); // never a crew member, never a golfer row
    // Ann (member) played a round against a guest; Ann appends it.
    ctx.snapshots.record(singlesArchive("r1", 5_000, ann, guest, ann, { [guest]: "Gus the Guest" }));
    await ctx.append(asClaims("ann"), crewId, seasonId, { roundId: roundId("r1") });
    expect(bo).toBeDefined();

    const standings = await ctx.standings(asClaims("ann"), crewId, seasonId);
    expect(standings.ledger.find((line) => line.golferId === guest)).toBeUndefined();
    expect(standings.ledger.find((line) => line.golferId === ann)).toMatchObject({ wins: 1 }); // Ann's own row is untouched
    expect(standings.headToHead).toEqual([]); // the guest half of the pair can't stand alone
  });

  // Compute-on-read reversibility: nothing is stored, so a departed member's rows disappear on
  // the very next read and a re-added member's rows reappear on the read after THAT — no stale
  // membership history anywhere.
  it("a departed member's rows vanish from standings while their counted round stays listed; re-adding them restores the rows", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    ctx.snapshots.record(singlesArchive("r1", 5_000, ann, bo, ann, {}));
    await ctx.append(asClaims("ann"), crewId, seasonId, { roundId: roundId("r1") });

    const before = await ctx.standings(asClaims("ann"), crewId, seasonId);
    expect(before.ledger.find((line) => line.golferId === bo)).toBeDefined();
    expect(before.headToHead).toHaveLength(1);

    await ctx.leave(asClaims("bo"), crewId);
    const afterLeave = await ctx.standings(asClaims("ann"), crewId, seasonId);
    expect(afterLeave.rounds.map((r) => r.roundId)).toEqual([roundId("r1")]); // the round stays counted
    expect(afterLeave.ledger.find((line) => line.golferId === bo)).toBeUndefined(); // Bo's row vanished
    expect(afterLeave.ledger.find((line) => line.golferId === ann)).toBeDefined(); // Ann's own row remains
    expect(afterLeave.headToHead).toEqual([]); // Bo is half the pair now — the pair goes too

    const rejoinInvite = await ctx.mint(asClaims("ann"), crewId);
    await ctx.join(asClaims("bo"), { token: rejoinInvite.token });
    const afterRejoin = await ctx.standings(asClaims("ann"), crewId, seasonId);
    expect(afterRejoin.ledger.find((line) => line.golferId === bo)).toBeDefined(); // restored
    expect(afterRejoin.headToHead).toHaveLength(1); // restored
  });

  it("names are sourced from the CURRENT roster, never the counted snapshot's own participant name", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    // The snapshot spells Ann "Ann From The Round" — irrelevant now; standings show whatever
    // the roster says, not whatever a round happened to carry.
    ctx.snapshots.record(singlesArchive("r1", 5_000, ann, bo, ann, { [ann]: "Ann From The Round" }));
    await ctx.append(asClaims("ann"), crewId, seasonId, { roundId: roundId("r1") });

    // Rename Ann on the roster directly — there is no rename-member use case yet, so this
    // mirrors the contract test's own "changed name/role" idiom (a direct store mutation).
    const found = await ctx.crewStore.get(crewId);
    const renamed = { ...found!.crew, members: found!.crew.members.map((member) => (member.golferId === ann ? { ...member, name: "Annie" } : member)) };
    await ctx.crewStore.put(renamed, found!.revision);

    const standings = await ctx.standings(asClaims("ann"), crewId, seasonId);
    expect(standings.ledger.find((line) => line.golferId === ann)?.name).toBe("Annie");
  });

  it("an unknown seasonId is rejected — season-not-found", async () => {
    const ctx = setup();
    const { crewId } = await crewWithSeason(ctx);
    await expect(ctx.standings(asClaims("ann"), crewId, "no-such-season")).rejects.toMatchObject({ code: "season-not-found" });
  });

  it("a non-member is rejected — not-a-member", async () => {
    const ctx = setup();
    const { crewId, seasonId } = await crewWithSeason(ctx);
    await seedGolfer(ctx, "stranger", "Stranger");
    await expect(ctx.standings(asClaims("stranger"), crewId, seasonId)).rejects.toMatchObject({ code: "not-a-member" });
  });

  it("an empty season yields empty rounds/ledger/headToHead, not an error", async () => {
    const ctx = setup();
    const { crewId, seasonId } = await crewWithSeason(ctx);
    await expect(ctx.standings(asClaims("ann"), crewId, seasonId)).resolves.toMatchObject({ rounds: [], ledger: [], headToHead: [] });
  });
});

describe("leaveCrew", () => {
  it("removes the caller's own member item; their past counted rounds REMAIN counted, but their standings rows vanish (members-only, compute-on-read)", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    ctx.snapshots.record(singlesArchive("r1", 5_000, ann, bo, ann, {}));
    await ctx.append(asClaims("bo"), crewId, seasonId, { roundId: roundId("r1") }); // Bo appended it

    const left = await ctx.leave(asClaims("bo"), crewId);

    expect(left).toEqual({ crewId });
    // Bo is off the roster now...
    const crew = await ctx.crewStore.get(crewId);
    expect(crew!.crew.members.some((member) => member.golferId === bo)).toBe(false);
    // ...but the round Bo counted is still counted (nothing about a counted round is deleted),
    // and standings no longer show Bo's own row — a members-only read-time filter, not stored
    // membership history.
    expect(await ctx.crewStore.listCountedRounds(crewId, seasonId)).toHaveLength(1);
    const standings = await ctx.standings(asClaims("ann"), crewId, seasonId);
    expect(standings.rounds).toHaveLength(1);
    expect(standings.ledger.find((line) => line.golferId === bo)).toBeUndefined();
  });

  it("a non-member (or a sub with no account golfer) leaving is rejected — not-a-member", async () => {
    const ctx = setup();
    const { crewId } = await crewWithSeason(ctx);
    await seedGolfer(ctx, "stranger", "Stranger");
    await expect(ctx.leave(asClaims("stranger"), crewId)).rejects.toMatchObject({ code: "not-a-member" });
  });

  // Crew membership (invited in, accountable out — spec §1): the organizer's own leave-guard —
  // a crew always has exactly one organizer, so the organizer must transfer the role
  // (transferOrganizer, crewSlice.test.ts) before they can leave. The message names the way out.
  it("the organizer cannot leave — organizer-must-transfer, naming the way out", async () => {
    const ctx = setup();
    const { ann, crewId } = await crewWithSeason(ctx);

    await expect(ctx.leave(asClaims("ann"), crewId)).rejects.toMatchObject({ code: "organizer-must-transfer" });

    // Nothing changed — Ann is still on the roster, still organizer.
    const crew = await ctx.crewStore.get(crewId);
    expect(crew!.crew.members.find((member) => member.golferId === ann)).toMatchObject({ role: "organizer" });
  });
});

// Analytics spec 2026-07-21 §5: partner records + superlatives grow the SAME standings read,
// beside the existing ledger/head-to-head this file already covers above.
describe("getSeasonStandings — partners + superlatives", () => {
  it("carries hand-pinned partners + mostImproved from a two-archive fixture; lowestNet stays absent below the 3-round floor", async () => {
    const ctx = setup();
    const ann = await seedGolfer(ctx, "ann", "Ann");
    const bo = await seedGolfer(ctx, "bo", "Bo");
    const cal = await seedGolfer(ctx, "cal", "Cal");
    const dee = await seedGolfer(ctx, "dee", "Dee");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });
    for (const sub of ["bo", "cal", "dee"]) {
      const invite = await ctx.mint(asClaims("ann"), created.crew.crewId);
      await ctx.join(asClaims(sub), { token: invite.token });
    }
    const season = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2026" });

    // Two fourball rounds: (Ann,Bo) beat (Cal,Dee) both times — 2-0 for each pair.
    ctx.snapshots.record(fourballArchive("r1", 5_000, [ann, bo], [cal, dee], "a"));
    ctx.snapshots.record(fourballArchive("r2", 9_000, [ann, bo], [cal, dee], "a"));
    await ctx.append(asClaims("ann"), created.crew.crewId, season.season.seasonId, { roundId: roundId("r1") });
    await ctx.append(asClaims("ann"), created.crew.crewId, season.season.seasonId, { roundId: roundId("r2") });

    // Ann's own projection lines (independent of the two counted archives above — mostImproved
    // reads projectionStore, not snapshots): 3 early differentials (all <= r1's finalize time,
    // 5_000, so they alone form the "from" boundary) plus 3 much-better ones landing between the
    // two counted rounds (<= r2's finalize time, 9_000, so the "to" boundary folds all six) — a
    // real drop, computed by the SAME golferMetrics oracle the use case itself calls, never
    // hand-derived against the small-sample table. Bo/Cal/Dee get no projection lines at all.
    const annLine = (id: string, ms: number, differential: number): GolferRoundLine & { finalizedAtMs: number } => ({
      roundId: roundId(id),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      par: 72,
      courseHandicap: 8,
      ags: 72 + differential,
      differential,
      distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
      finalizedAtMs: ms,
    });
    const early = [annLine("e1", 1_000, 20.0), annLine("e2", 2_000, 19.0), annLine("e3", 3_000, 21.0)];
    const later = [annLine("l1", 6_000, 8.0), annLine("l2", 7_000, 9.0), annLine("l3", 7_500, 7.0)];
    for (const line of [...early, ...later]) await ctx.projectionStore.putLine(ann, line);

    const standings = await ctx.standings(asClaims("ann"), created.crew.crewId, season.season.seasonId);

    expect(standings.partners).toEqual([
      { a: ann, b: bo, nameA: "Ann", nameB: "Bo", wins: 2, losses: 0, halves: 0 },
      { a: cal, b: dee, nameA: "Cal", nameB: "Dee", wins: 0, losses: 2, halves: 0 },
    ]);
    // Only 2 counted rounds all season — netAverages' 3-round floor can never be met, so
    // lowestNet is ABSENT, not a zeroed/partial entry.
    expect(standings.superlatives.lowestNet).toBeUndefined();

    const expectedFrom = golferMetrics(early).swngIndex!.value;
    const expectedTo = golferMetrics([...early, ...later]).swngIndex!.value;
    expect(expectedTo).toBeLessThan(expectedFrom); // sanity: the fixture really is a drop
    expect(standings.superlatives.mostImproved).toEqual([{ golferId: ann, name: "Ann", from: expectedFrom, to: expectedTo }]);
  });

  it("a member with no lines yields no mostImproved entry, not a crash", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    ctx.snapshots.record(singlesArchive("r1", 5_000, ann, bo, ann, {}));
    await ctx.append(asClaims("ann"), crewId, seasonId, { roundId: roundId("r1") });
    // Neither Ann nor Bo has ANY projectionStore line — golferMetrics([]).swngIndex is
    // undefined at both boundaries for both members, so domain's mostImproved excludes both
    // (never a zeroed/thrown entry), and the superlative is omitted entirely.

    const standings = await ctx.standings(asClaims("ann"), crewId, seasonId);

    expect(standings.superlatives.mostImproved).toBeUndefined();
  });

  it("omits mostImproved entirely (no boundary fetches) when the season counts no rounds at all", async () => {
    const ctx = setup();
    const { crewId, seasonId } = await crewWithSeason(ctx);

    const standings = await ctx.standings(asClaims("ann"), crewId, seasonId);

    expect(standings.superlatives.mostImproved).toBeUndefined();
    expect(standings.superlatives.lowestNet).toBeUndefined();
  });

  it("picks the single lowest net average across the roster; an exact tie groups into one entry naming every tied golfer", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);

    // Ann: 3 rounds at CH 8, gross 90 each -> net 82 flat, average 82.0.
    for (const [i, id] of ["a1", "a2", "a3"].entries()) {
      ctx.snapshots.record(soloArchive(id, 1_000 * (i + 1), ann, 8, 90));
      await ctx.append(asClaims("ann"), crewId, seasonId, { roundId: roundId(id) });
    }
    // Bo: 3 rounds at CH 0, gross 82 each -> net 82 flat too — an exact tie with Ann.
    for (const [i, id] of ["b1", "b2", "b3"].entries()) {
      ctx.snapshots.record(soloArchive(id, 4_000 * (i + 1), bo, 0, 82));
      await ctx.append(asClaims("bo"), crewId, seasonId, { roundId: roundId(id) });
    }

    const standings = await ctx.standings(asClaims("ann"), crewId, seasonId);

    expect(standings.superlatives.lowestNet).toEqual({
      holes: 18,
      average: 82,
      rounds: 3,
      golfers: [
        { golferId: ann, name: "Ann" },
        { golferId: bo, name: "Bo" },
      ],
    });
  });
});

// GET /crews/{crewId}/records (analytics spec 2026-07-21 §5): all-time, deduped across seasons.
describe("getCrewRecords", () => {
  it("dedupes a round counted in two seasons of the same crew — rounds: 1, ledger/partners built from ONE contribution, not two", async () => {
    const ctx = setup();
    const ann = await seedGolfer(ctx, "ann", "Ann");
    const bo = await seedGolfer(ctx, "bo", "Bo");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });
    const invite = await ctx.mint(asClaims("ann"), created.crew.crewId);
    await ctx.join(asClaims("bo"), { token: invite.token });
    const seasonA = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2025" });
    const seasonB = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2026" });

    ctx.snapshots.record(singlesArchive("r1", 5_000, ann, bo, ann, {}));
    await ctx.append(asClaims("ann"), created.crew.crewId, seasonA.season.seasonId, { roundId: roundId("r1") });
    await ctx.append(asClaims("ann"), created.crew.crewId, seasonB.season.seasonId, { roundId: roundId("r1") });

    const records = await ctx.records(asClaims("ann"), created.crew.crewId);

    expect(records.rounds).toBe(1); // the SAME round counted twice contributes once
    expect(records.ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ golferId: ann, rounds: 1, wins: 1 }), // not 2
        expect.objectContaining({ golferId: bo, rounds: 1, losses: 1 }),
      ]),
    );
    expect(records.headToHead).toEqual([expect.objectContaining({ aWins: 1, bWins: 0 })]); // one entry, not two
  });

  it("titles: each CLOSED season's Stableford points leader, roster-filtered — an open season contributes no title", async () => {
    const ctx = setup();
    const ann = await seedGolfer(ctx, "ann", "Ann");
    const bo = await seedGolfer(ctx, "bo", "Bo");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });
    const invite = await ctx.mint(asClaims("ann"), created.crew.crewId);
    await ctx.join(asClaims("bo"), { token: invite.token });
    const closedSeason = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2025" });
    const openSeason = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2026" });

    ctx.snapshots.record(stablefordArchive("r1", 5_000, [ann, bo], { [ann]: 40, [bo]: 30 }));
    await ctx.append(asClaims("ann"), created.crew.crewId, closedSeason.season.seasonId, { roundId: roundId("r1") });
    ctx.snapshots.record(stablefordArchive("r2", 6_000, [ann, bo], { [ann]: 20, [bo]: 25 }));
    await ctx.append(asClaims("bo"), created.crew.crewId, openSeason.season.seasonId, { roundId: roundId("r2") });

    const closed = await ctx.crewStore.getSeason(created.crew.crewId, closedSeason.season.seasonId);
    await ctx.crewStore.putSeason(created.crew.crewId, { ...closed!, status: "closed" });

    const records = await ctx.records(asClaims("ann"), created.crew.crewId);

    expect(records.titles).toEqual([{ seasonId: closedSeason.season.seasonId, name: "2025", golfers: [{ golferId: ann, name: "Ann" }] }]);
  });

  it("titles read oldest-first — a timeline, not newest-first (spec §5's own example order: 'Bo '24 · Al '25', whole-branch review 2026-07-21 Finding 3)", async () => {
    const ctx = setup();
    const ann = await seedGolfer(ctx, "ann", "Ann");
    const bo = await seedGolfer(ctx, "bo", "Bo");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });
    const invite = await ctx.mint(asClaims("ann"), created.crew.crewId);
    await ctx.join(asClaims("bo"), { token: invite.token });

    // Created in chronological order — the fixed clock (createFixedClock) advances 1ms per
    // call, so season2024's createdAtMs < season2025's; getCrewRecords' own season listing
    // sorts newest-first for other purposes, so this pins that `titles` is built separately.
    const season2024 = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2024" });
    const season2025 = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2025" });

    ctx.snapshots.record(stablefordArchive("r1", 5_000, [ann, bo], { [ann]: 40, [bo]: 30 })); // Ann wins 2024
    await ctx.append(asClaims("ann"), created.crew.crewId, season2024.season.seasonId, { roundId: roundId("r1") });
    ctx.snapshots.record(stablefordArchive("r2", 6_000, [ann, bo], { [ann]: 20, [bo]: 35 })); // Bo wins 2025
    await ctx.append(asClaims("bo"), created.crew.crewId, season2025.season.seasonId, { roundId: roundId("r2") });

    const closed2024 = await ctx.crewStore.getSeason(created.crew.crewId, season2024.season.seasonId);
    await ctx.crewStore.putSeason(created.crew.crewId, { ...closed2024!, status: "closed" });
    const closed2025 = await ctx.crewStore.getSeason(created.crew.crewId, season2025.season.seasonId);
    await ctx.crewStore.putSeason(created.crew.crewId, { ...closed2025!, status: "closed" });

    const records = await ctx.records(asClaims("ann"), created.crew.crewId);

    expect(records.titles).toEqual([
      { seasonId: season2024.season.seasonId, name: "2024", golfers: [{ golferId: ann, name: "Ann" }] },
      { seasonId: season2025.season.seasonId, name: "2025", golfers: [{ golferId: bo, name: "Bo" }] },
    ]);
  });

  it("a non-member is rejected — not-a-member", async () => {
    const ctx = setup();
    const { crewId } = await crewWithSeason(ctx);
    await seedGolfer(ctx, "stranger", "Stranger");
    await expect(ctx.records(asClaims("stranger"), crewId)).rejects.toMatchObject({ code: "not-a-member" });
  });

  it("a fresh crew (only its own auto-opened season, nothing counted) yields an empty, non-throwing response", async () => {
    const ctx = setup();
    const ann = await seedGolfer(ctx, "ann", "Ann");
    const created = await ctx.create(asClaims("ann"), { name: "Solo Crew" });
    expect(ann).toBeDefined();

    await expect(ctx.records(asClaims("ann"), created.crew.crewId)).resolves.toEqual({
      rounds: 0,
      ledger: [],
      headToHead: [],
      partners: [],
      titles: [],
    });
  });
});

// Close-season spec (2026-07-21): the two verbs that flip CrewSeason.status. Nothing about a
// title is ever stored — closing/reopening just flips `status`, and getCrewRecords' own
// on-read title fold (already covered above) reacts.
describe("closeSeason / reopenSeason", () => {
  it(
    "organizer closes an open season → its Stableford title appears in getCrewRecords (reuses the existing " +
      "titles fixture arithmetic — Ann 40 pts beats Bo 30 pts); reopening makes the title vanish again",
    async () => {
      const ctx = setup();
      const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
      ctx.snapshots.record(stablefordArchive("r1", 5_000, [ann, bo], { [ann]: 40, [bo]: 30 }));
      await ctx.append(asClaims("ann"), crewId, seasonId, { roundId: roundId("r1") });

      const beforeClose = await ctx.records(asClaims("ann"), crewId);
      expect(beforeClose.titles).toEqual([]); // open season awards nothing yet

      const closed = await ctx.close(asClaims("ann"), crewId, seasonId);
      expect(closed.season).toMatchObject({ seasonId, status: "closed" });

      const afterClose = await ctx.records(asClaims("ann"), crewId);
      expect(afterClose.titles).toEqual([{ seasonId, name: "2026", golfers: [{ golferId: ann, name: "Ann" }] }]);

      const reopened = await ctx.reopen(asClaims("ann"), crewId, seasonId);
      expect(reopened.season).toMatchObject({ seasonId, status: "open" });

      const afterReopen = await ctx.records(asClaims("ann"), crewId);
      expect(afterReopen.titles).toEqual([]);
    },
  );

  it("closing an already-closed season is rejected — season-already-closed", async () => {
    const ctx = setup();
    const { crewId, seasonId } = await crewWithSeason(ctx);
    await ctx.close(asClaims("ann"), crewId, seasonId);

    await expect(ctx.close(asClaims("ann"), crewId, seasonId)).rejects.toMatchObject({ code: "season-already-closed" });
  });

  it("reopening an OPEN season is rejected — season-not-closed", async () => {
    const ctx = setup();
    const { crewId, seasonId } = await crewWithSeason(ctx);

    await expect(ctx.reopen(asClaims("ann"), crewId, seasonId)).rejects.toMatchObject({ code: "season-not-closed" });
  });

  it("a non-organizer member is rejected on both verbs — not-organizer", async () => {
    const ctx = setup();
    const { crewId, seasonId } = await crewWithSeason(ctx); // Bo joined, Ann is organizer

    await expect(ctx.close(asClaims("bo"), crewId, seasonId)).rejects.toMatchObject({ code: "not-organizer" });

    await ctx.close(asClaims("ann"), crewId, seasonId);
    await expect(ctx.reopen(asClaims("bo"), crewId, seasonId)).rejects.toMatchObject({ code: "not-organizer" });
  });

  it("a non-member is rejected on both verbs — not-a-member", async () => {
    const ctx = setup();
    const { crewId, seasonId } = await crewWithSeason(ctx);
    await seedGolfer(ctx, "stranger", "Stranger");

    await expect(ctx.close(asClaims("stranger"), crewId, seasonId)).rejects.toMatchObject({ code: "not-a-member" });
    await expect(ctx.reopen(asClaims("stranger"), crewId, seasonId)).rejects.toMatchObject({ code: "not-a-member" });
  });

  it("an unknown seasonId is rejected on both verbs — season-not-found", async () => {
    const ctx = setup();
    const { crewId } = await crewWithSeason(ctx);

    await expect(ctx.close(asClaims("ann"), crewId, "no-such-season")).rejects.toMatchObject({ code: "season-not-found" });
    await expect(ctx.reopen(asClaims("ann"), crewId, "no-such-season")).rejects.toMatchObject({ code: "season-not-found" });
  });

  it("closeSeason stamps closedAtMs to the exact clock reading, on both the returned and the stored season", async () => {
    const crewStore = createInMemoryCrewStore();
    const golferStore = createInMemoryGolferStore();
    const closeAt = Date.UTC(2026, 6, 1); // July 1, 2026 (fixed) — the ONE value close() should stamp
    const create = createCrew({ crewStore, golferStore, ids: createSequentialIds("w"), clock: createFrozenClock(Date.UTC(2026, 0, 15)) });
    const close = closeSeason({ crewStore, golferStore, clock: createFrozenClock(closeAt) });
    await putAndBindGolfer(golferStore, golferId("golfer-ann"), "ann", "Ann");
    const created = await create(asClaims("ann"), { name: "Sunday Skins" });
    const seasonId = (await crewStore.listSeasons(created.crew.crewId))[0]!.seasonId;

    const closed = await close(asClaims("ann"), created.crew.crewId, seasonId);

    expect(closed.season.closedAtMs).toBe(closeAt);
    const stored = await crewStore.getSeason(created.crew.crewId, seasonId);
    expect(stored?.closedAtMs).toBe(closeAt);
  });

  it("reopenSeason removes closedAtMs entirely — absent (not undefined) on both the returned and the stored season", async () => {
    const crewStore = createInMemoryCrewStore();
    const golferStore = createInMemoryGolferStore();
    const create = createCrew({ crewStore, golferStore, ids: createSequentialIds("w2"), clock: createFrozenClock(Date.UTC(2026, 0, 15)) });
    const close = closeSeason({ crewStore, golferStore, clock: createFrozenClock(Date.UTC(2026, 6, 1)) });
    const reopen = reopenSeason({ crewStore, golferStore });
    await putAndBindGolfer(golferStore, golferId("golfer-ann"), "ann", "Ann");
    const created = await create(asClaims("ann"), { name: "Sunday Skins" });
    const seasonId = (await crewStore.listSeasons(created.crew.crewId))[0]!.seasonId;
    await close(asClaims("ann"), created.crew.crewId, seasonId);

    const reopened = await reopen(asClaims("ann"), created.crew.crewId, seasonId);

    expect(reopened.season).not.toHaveProperty("closedAtMs");
    const stored = await crewStore.getSeason(created.crew.crewId, seasonId);
    expect(stored).not.toHaveProperty("closedAtMs");
  });
});
