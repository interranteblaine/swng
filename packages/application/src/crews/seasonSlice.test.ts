import { describe, expect, it } from "vitest";
import { archiveGolferLine, crewScoreboard, deviceId, fixtureLinks18, gameId, golferId, opId, roundId } from "@swng/domain";
import type { GolferId, GolferRoundLine, Participant, RoundArchive, RoundEvent } from "@swng/domain";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
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
import type { InMemorySnapshotStore } from "../testing/fakes.js";
import { createCrew } from "./createCrew.js";
import { createSeason } from "./createSeason.js";
import { getSeasonStandings } from "./getSeasonStandings.js";
import { joinCrewByInvite } from "./joinCrewByInvite.js";
import { leaveCrew } from "./leaveCrew.js";
import { listSeasons } from "./listSeasons.js";
import { mintCrewInvite } from "./mintCrewInvite.js";
import { updateSeason } from "./updateSeason.js";

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
// recordPlayed below has real roster data to default `golferIds` from.
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

// Crew-scoreboard spec §3b: a "played together" round is DERIVED, never counted — it exists
// iff >=2 current roster members each hold their OWN golfer-projection line for it. This seeds
// both halves a real finalized round leaves behind: the archive (for the together-folds) and
// each named golfer's own line (for the derivation), via `archiveGolferLine` — the SAME domain
// function `projectArchive` itself calls, never a hand re-derivation of a GolferRoundLine's
// shape. `golferIds` defaults to every archive participant; pass a subset to model "only some
// of them are roster members" (a guest, or a member who simply wasn't in this round).
const recordPlayed = async (
  ctx: { readonly snapshots: InMemorySnapshotStore; readonly projectionStore: ProjectionStore },
  archive: RoundArchive,
  wallMs: number,
  golferIds?: readonly GolferId[],
  // The round's played instant — optional, matching the real line's `createdAtMs?`. When set it
  // seeds the line's createdAtMs (the canonical-label input the standings wire now carries); the
  // window fold reads `createdAtMs ?? finalizedAtMs`, so setting it to wallMs is behavior-neutral.
  createdAtMs?: number,
): Promise<void> => {
  ctx.snapshots.record(archive);
  const ids = golferIds ?? archive.participants.map((p) => p.golferId);
  for (const golfer of ids) {
    await ctx.projectionStore.putLine(golfer, { ...archiveGolferLine(archive, golfer), finalizedAtMs: wallMs, ...(createdAtMs !== undefined ? { createdAtMs } : {}) });
  }
};

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
    updateSeason: updateSeason({ crewStore, golferStore }),
    standings: getSeasonStandings({ crewStore, golferStore, snapshots, projectionStore }),
    leave: leaveCrew({ crewStore, golferStore }),
  };
};

const seedGolfer = async (ctx: ReturnType<typeof setup>, sub: string, name: string): Promise<GolferId> => {
  const id = golferId(`golfer-${sub}`);
  await putAndBindGolfer(ctx.golferStore, id, sub, name);
  return id;
};

const asClaims = (sub: string): AccountClaims => ({ sub });

// A wide, effectively-unbounded window (spec 2026-07-22 "the season is the record" §1: dates
// are now REQUIRED, never absent) — matches the old "startsAtMs: 0, no upper bound" fixture
// shape these tests' small wallMs fixtures (500/5_000/9_000/...) always fell inside.
const WIDE_WINDOW = { startsAt: "1970-01-01", endsAt: "2100-12-31" };

// A crew with Ann (organizer) + Bo (joined), plus one open (wide-dated) season. Returns
// everything a test needs to count rounds into it.
const crewWithSeason = async (ctx: ReturnType<typeof setup>) => {
  const ann = await seedGolfer(ctx, "ann", "Ann");
  const bo = await seedGolfer(ctx, "bo", "Bo");
  const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });
  const invite = await ctx.mint(asClaims("ann"), created.crew.crewId);
  await ctx.join(asClaims("bo"), { token: invite.token });
  const season = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2026", ...WIDE_WINDOW });
  return { ann, bo, crewId: created.crew.crewId, seasonId: season.season.seasonId };
};

describe("createCrew — auto-opened season window", () => {
  it("listSeasons yields exactly one season named for the year, with VISIBLE Jan 1 – Dec 31 dates and no status key (spec 2026-07-22 §2)", async () => {
    const crewStore = createInMemoryCrewStore();
    const golferStore = createInMemoryGolferStore();
    const now = Date.UTC(2026, 5, 15); // June 15, 2026 (fixed) — mid-year, so the year extraction is a real computation
    const create = createCrew({ crewStore, golferStore, ids: createSequentialIds("y"), clock: createFrozenClock(now) });
    await putAndBindGolfer(golferStore, golferId("golfer-ann"), "ann", "Ann");

    const created = await create(asClaims("ann"), { name: "Sunday Skins" });
    const seasons = await crewStore.listSeasons(created.crew.crewId);

    expect(seasons).toHaveLength(1);
    expect(seasons[0]).toEqual({ seasonId: seasons[0]!.seasonId, name: "2026", createdAtMs: now, startsAt: "2026-01-01", endsAt: "2026-12-31" });
    expect(seasons[0]).not.toHaveProperty("status");
    expect(seasons[0]).not.toHaveProperty("closedAtMs");
    expect(seasons[0]).not.toHaveProperty("startsAtMs");
  });
});

describe("createSeason", () => {
  it("a member creates a season with a server-minted id and its chosen dates, no status key", async () => {
    const ctx = setup();
    await seedGolfer(ctx, "ann", "Ann");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });

    const season = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "Summer Cup", startsAt: "2026-06-01", endsAt: "2026-08-31" });

    expect(season.season).toMatchObject({ name: "Summer Cup", startsAt: "2026-06-01", endsAt: "2026-08-31" });
    expect(season.season).not.toHaveProperty("status");
    expect(season.season.seasonId).not.toContain("#"); // opaque, server-minted (CrewStore's caller contract)
    expect(season.season.createdAtMs).toBeGreaterThan(0);
  });

  it("a non-member is rejected — not-a-member", async () => {
    const ctx = setup();
    await seedGolfer(ctx, "ann", "Ann");
    await seedGolfer(ctx, "stranger", "Stranger");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });

    await expect(ctx.createSeason(asClaims("stranger"), created.crew.crewId, { name: "2026", ...WIDE_WINDOW })).rejects.toMatchObject({ code: "not-a-member" });
  });

  it("a whitespace-only name is rejected — invalid-season-name, nothing created", async () => {
    const ctx = setup();
    await seedGolfer(ctx, "ann", "Ann");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });
    // createCrew auto-opens the crew's own first season (spec 2026-07-22 §2) — captured
    // BEFORE the rejected call so "nothing created" means exactly that, not "list is empty".
    const before = await ctx.listSeasons(asClaims("ann"), created.crew.crewId);

    await expect(ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "   ", ...WIDE_WINDOW })).rejects.toMatchObject({ code: "invalid-season-name" });
    await expect(ctx.listSeasons(asClaims("ann"), created.crew.crewId)).resolves.toEqual(before);
  });

  it("a name past 60 characters is rejected — invalid-season-name", async () => {
    const ctx = setup();
    await seedGolfer(ctx, "ann", "Ann");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });

    await expect(ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "x".repeat(61), ...WIDE_WINDOW })).rejects.toMatchObject({ code: "invalid-season-name" });
  });

  // Spec 2026-07-22 §1/§2 (review I5): the date guard closes a client-triggerable 500 — a bad
  // date must never reach storage.
  it("an inverted window (startsAt after endsAt) is rejected — invalid-season-window, nothing created", async () => {
    const ctx = setup();
    await seedGolfer(ctx, "ann", "Ann");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });
    const before = await ctx.listSeasons(asClaims("ann"), created.crew.crewId);

    await expect(ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2026", startsAt: "2026-12-31", endsAt: "2026-01-01" })).rejects.toMatchObject({
      code: "invalid-season-window",
    });
    await expect(ctx.listSeasons(asClaims("ann"), created.crew.crewId)).resolves.toEqual(before);
  });

  // A shape-valid but semantically-unreal date (Feb 30 rolls to Mar 2) — seasonWindowOf's own
  // round-trip check catches it, remapped here rather than left to throw a plain Error later.
  it("a shape-valid but unreal calendar date is rejected — invalid-season-window, nothing created", async () => {
    const ctx = setup();
    await seedGolfer(ctx, "ann", "Ann");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });
    const before = await ctx.listSeasons(asClaims("ann"), created.crew.crewId);

    await expect(ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2026", startsAt: "2026-01-01", endsAt: "2026-02-30" })).rejects.toMatchObject({
      code: "invalid-season-window",
    });
    await expect(ctx.listSeasons(asClaims("ann"), created.crew.crewId)).resolves.toEqual(before);
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
    const first = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2025", ...WIDE_WINDOW });
    const second = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2026", ...WIDE_WINDOW });

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

describe("getSeasonStandings", () => {
  it("folds the together-records over DERIVED shared rounds, newest-round-first — no counting act", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    await recordPlayed(ctx, singlesArchive("r1", 5_000, ann, bo, ann, {}), 5_000); // Ann beats Bo (no createdAtMs)
    await recordPlayed(ctx, singlesArchive("r2", 9_000, ann, bo, bo, {}), 9_000, undefined, 8_900); // Bo beats Ann; played 8_900

    const standings = await ctx.standings(asClaims("ann"), crewId, seasonId);

    expect(standings).toMatchObject({ seasonId, name: "2026", startsAt: WIDE_WINDOW.startsAt, endsAt: WIDE_WINDOW.endsAt });
    expect(standings.rounds.map((r) => r.roundId)).toEqual([roundId("r2"), roundId("r1")]); // newest-first
    // The canonical-label inputs ride the wire (spec 2026-07-22 §3): courseName (from the frozen
    // card) is REQUIRED; createdAt (the played instant) rides when the line carries one, and is
    // absent otherwise (r1 had no createdAtMs → renders as the bare course name).
    expect(standings.rounds[0]).toMatchObject({ roundId: roundId("r2"), courseName: "Fixture Links 18", createdAt: 8_900 });
    expect(standings.rounds[1]).toMatchObject({ roundId: roundId("r1"), courseName: "Fixture Links 18" });
    expect(standings.rounds[1]!.createdAt).toBeUndefined();
    expect(standings.ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ golferId: ann, wins: 1, losses: 1 }),
        expect.objectContaining({ golferId: bo, wins: 1, losses: 1 }),
      ]),
    );
    expect(standings.headToHead).toEqual([expect.objectContaining({ aWins: 1, bWins: 1, halves: 0 })]);
  });

  // Architecture-realignment Phase 3 correction (spec §11a, 2026-07-13, owner ruling), carried
  // into the crew-scoreboard redesign: a crew is a grouping/competition ONLY — standings
  // aggregate the CURRENT roster, full stop. A shared round derivation requires >=2 CURRENT
  // roster members to each hold their own line for it (spec §3a) — a guest never does, so a
  // round a member played against a guest is only "shared" (and only reaches the together-folds
  // at all) once a SECOND roster member's own line makes it so; that second member's presence
  // is what makes the round visible, and the guest's own row/pair still never appears.
  it("a participant NOT on the roster contributes no row, even once the round is shared via two real members", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    const guest = golferId("gus"); // never a crew member, never a golfer row
    const archive = stablefordArchive("r1", 5_000, [ann, bo, guest], { [ann]: 40, [bo]: 35, [guest]: 30 });
    // Only Ann and Bo (both roster members) get their own projection line — Gus never does, so
    // his own row is excluded from the ledger even though the round IS shared (Ann + Bo).
    await recordPlayed(ctx, archive, 5_000, [ann, bo]);

    const standings = await ctx.standings(asClaims("ann"), crewId, seasonId);
    expect(standings.rounds.map((r) => r.roundId)).toEqual([roundId("r1")]);
    expect(standings.ledger.find((line) => line.golferId === guest)).toBeUndefined();
    expect(standings.ledger.find((line) => line.golferId === ann)).toMatchObject({ points: 40 });
    expect(standings.ledger.find((line) => line.golferId === bo)).toMatchObject({ points: 35 });
  });

  // Compute-on-read reversibility, sharpened by the window redesign: "we played together" is
  // itself a CURRENT-roster fact now (sharedRoundIds requires >=2 CURRENT members), so a
  // departed member's shared round drops out of the played-together list ENTIRELY — not merely
  // their own ledger row — the instant only one roster member remains holding a line for it.
  // Rejoining restores everything, byte-identical (nothing was ever stored).
  it("a departed member's shared round drops out of standings entirely (not just their own row); rejoining restores it", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    await recordPlayed(ctx, singlesArchive("r1", 5_000, ann, bo, ann, {}), 5_000);

    const before = await ctx.standings(asClaims("ann"), crewId, seasonId);
    expect(before.rounds.map((r) => r.roundId)).toEqual([roundId("r1")]);
    expect(before.ledger.find((line) => line.golferId === bo)).toBeDefined();
    expect(before.headToHead).toHaveLength(1);

    await ctx.leave(asClaims("bo"), crewId);
    const afterLeave = await ctx.standings(asClaims("ann"), crewId, seasonId);
    expect(afterLeave.rounds).toEqual([]); // only Ann remains -> no longer >=2 current holders
    expect(afterLeave.ledger).toEqual([]); // the round itself is no longer "together" for anyone
    expect(afterLeave.headToHead).toEqual([]);

    const rejoinInvite = await ctx.mint(asClaims("ann"), crewId);
    await ctx.join(asClaims("bo"), { token: rejoinInvite.token });
    const afterRejoin = await ctx.standings(asClaims("ann"), crewId, seasonId);
    expect(afterRejoin.rounds.map((r) => r.roundId)).toEqual([roundId("r1")]); // restored
    expect(afterRejoin.ledger.find((line) => line.golferId === bo)).toBeDefined(); // restored
    expect(afterRejoin.headToHead).toHaveLength(1); // restored
  });

  it("names are sourced from the CURRENT roster, never the played round's own participant name", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    // The snapshot spells Ann "Ann From The Round" — irrelevant now; standings show whatever
    // the roster says, not whatever a round happened to carry.
    await recordPlayed(ctx, singlesArchive("r1", 5_000, ann, bo, ann, { [ann]: "Ann From The Round" }), 5_000);

    // Rename Ann on the roster directly — there is no rename-member use case yet, so this
    // mirrors the contract test's own "changed name/role" idiom (a direct store mutation).
    const found = await ctx.crewStore.get(crewId);
    const renamed = { ...found!.crew, members: found!.crew.members.map((member) => (member.golferId === ann ? { ...member, name: "Annie" } : member)) };
    await ctx.crewStore.put(renamed, found!.revision);

    const standings = await ctx.standings(asClaims("ann"), crewId, seasonId);
    expect(standings.ledger.find((line) => line.golferId === ann)?.name).toBe("Annie");
    expect(standings.scoreboard.find((row) => row.golferId === ann)?.name).toBe("Annie");
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

  // The scoreboard is REQUIRED (spec §3a) — every roster member gets a row, `rounds: 0`
  // included, even when nothing has ever been shared. Sorted golferId asc on a full tie
  // (netPer18 absent for both, rounds 0 for both — crewScoreboard's own total order).
  it("an empty season yields empty rounds/ledger/headToHead and a zero-row scoreboard for every member, not an error", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    const standings = await ctx.standings(asClaims("ann"), crewId, seasonId);
    expect(standings).toMatchObject({ rounds: [], ledger: [], headToHead: [] });
    expect(standings.scoreboard).toEqual([
      { golferId: ann, name: "Ann", rounds: 0 },
      { golferId: bo, name: "Bo", rounds: 0 },
    ]);
  });

  // Spec 2026-07-22 "the season is the record" §2's own core promise: editing the end date IS
  // the whole lifecycle — a season is [startsAt, endsAt], and a round played AFTER a narrowed
  // `endsAt` stays out of it, until a later updateSeason widens `endsAt` back out. There is no
  // close/reopen verb anymore — this is the SAME live re-scoping the crewSeason e2e's own
  // "window pins" exercise over the real wire (plan 2026-07-22, Task 4).
  it("a round played after the season's endsAt is narrowed stays out of both `rounds` and the scoreboard's own count; widening endsAt lets it back in", async () => {
    const day = 24 * 60 * 60 * 1000;
    const crewStore = createInMemoryCrewStore();
    const golferStore = createInMemoryGolferStore();
    const snapshots = createInMemorySnapshotStore();
    const projectionStore = createInMemoryProjectionStore();
    const tokenIssuer = createTestTokenIssuer();
    const ids = createSequentialIds("w");
    const create = createCrew({ crewStore, golferStore, ids, clock: createFrozenClock(0) });
    const mint = mintCrewInvite({ crewStore, golferStore, tokenIssuer, clock: createFrozenClock(0) });
    const join = joinCrewByInvite({ crewStore, golferStore, tokenIssuer, clock: createFrozenClock(0) });
    const update = updateSeason({ crewStore, golferStore });
    const standings = getSeasonStandings({ crewStore, golferStore, snapshots, projectionStore });

    const ann = golferId("golfer-ann");
    const bo = golferId("golfer-bo");
    await putAndBindGolfer(golferStore, ann, "ann", "Ann");
    await putAndBindGolfer(golferStore, bo, "bo", "Bo");
    const created = await create(asClaims("ann"), { name: "Sunday Skins" });
    const invite = await mint(asClaims("ann"), created.crew.crewId);
    await join(asClaims("bo"), { token: invite.token });
    const seasonId = (await crewStore.listSeasons(created.crew.crewId))[0]!.seasonId;

    await recordPlayed({ snapshots, projectionStore }, singlesArchive("r1", 5 * day, ann, bo, ann, {}), 5 * day); // day 5 — inside the narrowed window below

    await update(asClaims("ann"), created.crew.crewId, seasonId, { endsAt: "1970-01-10" }); // day 10 — narrows the window BEFORE day 20
    await recordPlayed({ snapshots, projectionStore }, singlesArchive("r2", 20 * day, ann, bo, bo, {}), 20 * day); // day 20 — after the narrowed endsAt

    const narrowed = await standings(asClaims("ann"), created.crew.crewId, seasonId);
    expect(narrowed.rounds.map((r) => r.roundId)).toEqual([roundId("r1")]); // r2 stays out
    expect(narrowed.scoreboard.find((row) => row.golferId === ann)?.rounds).toBe(1);

    await update(asClaims("ann"), created.crew.crewId, seasonId, { endsAt: "1970-01-31" }); // widened back out
    const widened = await standings(asClaims("ann"), created.crew.crewId, seasonId);
    expect(widened.rounds.map((r) => r.roundId).sort()).toEqual([roundId("r1"), roundId("r2")].sort());
    expect(widened.scoreboard.find((row) => row.golferId === ann)?.rounds).toBe(2);
  });
});

// Crew-scoreboard spec §3a: the per-member scoreboard SeasonPanel leads with — a reuse proof
// against the SAME domain fold scoreboard.test.ts already covers exhaustively, so this only pins
// the wiring (which lines, which window, roster names attached, served order untouched) rather
// than re-deriving netPer18/best18/index arithmetic a second time.
describe("getSeasonStandings — scoreboard", () => {
  it("scoreboard rows are exactly crewScoreboard(members, window) with roster names attached, in served order", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);

    // Ann: three rated 18-hole lines within the (open, unbounded) window -> netPer18 present.
    // Bo: none at all -> a zero row, sorted after Ann's real netPer18 (crewScoreboard's own
    // "absent last" rule).
    const annLine = (id: string, ms: number, ags: number, differential: number): GolferRoundLine & { finalizedAtMs: number } => ({
      roundId: roundId(id),
      courseName: "Casa Verde GC",
      tee: "white",
      holes: 18,
      par: 72,
      courseHandicap: 8,
      ags,
      differential,
      distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
      finalizedAtMs: ms,
    });
    const annLines = [annLine("a1", 1_000, 90, 12.0), annLine("a2", 2_000, 88, 10.0), annLine("a3", 3_000, 86, 8.0)];
    for (const line of annLines) await ctx.projectionStore.putLine(ann, line);

    const window = { startMs: 0 };
    const expected = crewScoreboard(
      [
        { golferId: ann, lines: annLines },
        { golferId: bo, lines: [] },
      ],
      window,
    ).map((row) => ({ ...row, name: row.golferId === ann ? "Ann" : "Bo" }));

    const standings = await ctx.standings(asClaims("ann"), crewId, seasonId);
    expect(standings.scoreboard).toEqual(expected);
  });

  // Partners keep folding the SAME shared-archive derivation ledger/headToHead use (spec §3b) —
  // this only pins that partners still arrive, sourced from the new derivation, now that the old
  // fixture's own most-improved/lowest-net superlative halves are gone with the superlatives
  // they fed.
  it("partners are carried from shared archives, roster names attached", async () => {
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
    const season = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2026", ...WIDE_WINDOW });

    // Two fourball rounds: (Ann,Bo) beat (Cal,Dee) both times — 2-0 for each pair.
    await recordPlayed(ctx, fourballArchive("r1", 5_000, [ann, bo], [cal, dee], "a"), 5_000);
    await recordPlayed(ctx, fourballArchive("r2", 9_000, [ann, bo], [cal, dee], "a"), 9_000);

    const standings = await ctx.standings(asClaims("ann"), created.crew.crewId, season.season.seasonId);

    expect(standings.partners).toEqual([
      { a: ann, b: bo, nameA: "Ann", nameB: "Bo", wins: 2, losses: 0, halves: 0 },
      { a: cal, b: dee, nameA: "Cal", nameB: "Dee", wins: 0, losses: 2, halves: 0 },
    ]);
  });
});

describe("leaveCrew", () => {
  it("removes the caller's own member item; the round drops out of the DERIVED standings entirely once only one roster member remains (members-only, compute-on-read)", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    await recordPlayed(ctx, singlesArchive("r1", 5_000, ann, bo, ann, {}), 5_000);

    const left = await ctx.leave(asClaims("bo"), crewId);

    expect(left).toEqual({ crewId });
    // Bo is off the roster now...
    const crew = await ctx.crewStore.get(crewId);
    expect(crew!.crew.members.some((member) => member.golferId === bo)).toBe(false);
    // ...and standings are derived fresh from the CURRENT roster: with only Ann left, r1 no
    // longer has >=2 current-member holders, so it drops out of standings entirely — a
    // members-only read-time filter, not stored membership history.
    const standings = await ctx.standings(asClaims("ann"), crewId, seasonId);
    expect(standings.rounds).toEqual([]);
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

// Spec 2026-07-22 "the season is the record" §2: editing the end date IS the whole lifecycle —
// updateSeason replaces the deleted close/reopen verb pair outright. Guard order mirrors the
// old closeSeason's exactly MINUS the closed-check — there is no closed state, so a season is
// always editable (asserted directly below: editing a season twice in a row never 409s).
describe("updateSeason", () => {
  it("a partial update ({endsAt} only) leaves the name and startsAt untouched", async () => {
    const ctx = setup();
    const { crewId, seasonId } = await crewWithSeason(ctx);

    const updated = await ctx.updateSeason(asClaims("ann"), crewId, seasonId, { endsAt: "2050-06-30" });

    expect(updated.season).toMatchObject({ seasonId, name: "2026", startsAt: WIDE_WINDOW.startsAt, endsAt: "2050-06-30" });
  });

  it("a season is always editable — no closed-check anywhere, back-to-back edits both succeed", async () => {
    const ctx = setup();
    const { crewId, seasonId } = await crewWithSeason(ctx);

    await expect(ctx.updateSeason(asClaims("ann"), crewId, seasonId, { name: "First edit" })).resolves.toMatchObject({ season: { name: "First edit" } });
    await expect(ctx.updateSeason(asClaims("ann"), crewId, seasonId, { name: "Second edit" })).resolves.toMatchObject({ season: { name: "Second edit" } });
  });

  it("a non-organizer member is rejected — not-organizer", async () => {
    const ctx = setup();
    const { crewId, seasonId } = await crewWithSeason(ctx); // Bo joined, Ann is organizer

    await expect(ctx.updateSeason(asClaims("bo"), crewId, seasonId, { name: "Nope" })).rejects.toMatchObject({ code: "not-organizer" });
  });

  it("a non-member is rejected — not-a-member", async () => {
    const ctx = setup();
    const { crewId, seasonId } = await crewWithSeason(ctx);
    await seedGolfer(ctx, "stranger", "Stranger");

    await expect(ctx.updateSeason(asClaims("stranger"), crewId, seasonId, { name: "Nope" })).rejects.toMatchObject({ code: "not-a-member" });
  });

  it("an unknown seasonId is rejected — season-not-found", async () => {
    const ctx = setup();
    const { crewId } = await crewWithSeason(ctx);

    await expect(ctx.updateSeason(asClaims("ann"), crewId, "no-such-season", { name: "Nope" })).rejects.toMatchObject({ code: "season-not-found" });
  });

  // The CANDIDATE (stored fields merged with the incoming ones) is what's validated — updating
  // only `startsAt` past the STORED `endsAt` is caught even though neither field alone looks
  // wrong in isolation.
  it("updating only startsAt past the stored endsAt is rejected — invalid-season-window", async () => {
    const ctx = setup();
    const { crewId, seasonId } = await crewWithSeason(ctx);
    await ctx.updateSeason(asClaims("ann"), crewId, seasonId, { endsAt: "2026-06-30" });

    await expect(ctx.updateSeason(asClaims("ann"), crewId, seasonId, { startsAt: "2026-12-01" })).rejects.toMatchObject({ code: "invalid-season-window" });
  });

  it("updating to a shape-valid but unreal calendar date is rejected — invalid-season-window", async () => {
    const ctx = setup();
    const { crewId, seasonId } = await crewWithSeason(ctx);

    await expect(ctx.updateSeason(asClaims("ann"), crewId, seasonId, { endsAt: "2026-02-30" })).rejects.toMatchObject({ code: "invalid-season-window" });
  });

  it("updating to a whitespace-only name is rejected — invalid-season-name", async () => {
    const ctx = setup();
    const { crewId, seasonId } = await crewWithSeason(ctx);

    await expect(ctx.updateSeason(asClaims("ann"), crewId, seasonId, { name: "   " })).rejects.toMatchObject({ code: "invalid-season-name" });
  });
});
