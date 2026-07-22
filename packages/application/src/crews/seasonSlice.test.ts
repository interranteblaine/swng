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
): Promise<void> => {
  ctx.snapshots.record(archive);
  const ids = golferIds ?? archive.participants.map((p) => p.golferId);
  for (const golfer of ids) {
    await ctx.projectionStore.putLine(golfer, { ...archiveGolferLine(archive, golfer), finalizedAtMs: wallMs });
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
    append: appendCountedRound({ crewStore, golferStore, snapshots, clock }),
    remove: removeCountedRound({ crewStore, golferStore }),
    close: closeSeason({ crewStore, golferStore, clock }),
    reopen: reopenSeason({ crewStore, golferStore }),
    standings: getSeasonStandings({ crewStore, golferStore, snapshots, projectionStore }),
    records: getCrewRecords({ crewStore, golferStore, snapshots, projectionStore }),
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
  it("folds the together-records over DERIVED shared rounds, newest-round-first — no counting act", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    await recordPlayed(ctx, singlesArchive("r1", 5_000, ann, bo, ann, {}), 5_000); // Ann beats Bo
    await recordPlayed(ctx, singlesArchive("r2", 9_000, ann, bo, bo, {}), 9_000); // Bo beats Ann

    const standings = await ctx.standings(asClaims("ann"), crewId, seasonId);

    expect(standings).toMatchObject({ seasonId, name: "2026", status: "open", startsAtMs: 0 });
    expect(standings.closedAtMs).toBeUndefined();
    expect(standings.rounds.map((r) => r.roundId)).toEqual([roundId("r2"), roundId("r1")]); // newest-first
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

  // The window redesign's own core promise: a season is [startsAtMs, closedAtMs ?? ∞], and a
  // round played AFTER a close stays out of it — until reopen widens the window back out. A
  // bespoke frozen-clock setup gives precise control over the boundary, unlike crewWithSeason's
  // shared ticking clock (fine everywhere else since an OPEN season's window has no upper bound
  // at all — spec §2).
  it("a round played after the season closes stays out of both `rounds` and the scoreboard's own count; reopening lets it back in", async () => {
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
    const close = closeSeason({ crewStore, golferStore, clock: createFrozenClock(10 * day) });
    const reopen = reopenSeason({ crewStore, golferStore });
    const standings = getSeasonStandings({ crewStore, golferStore, snapshots, projectionStore });

    const ann = golferId("golfer-ann");
    const bo = golferId("golfer-bo");
    await putAndBindGolfer(golferStore, ann, "ann", "Ann");
    await putAndBindGolfer(golferStore, bo, "bo", "Bo");
    const created = await create(asClaims("ann"), { name: "Sunday Skins" });
    const invite = await mint(asClaims("ann"), created.crew.crewId);
    await join(asClaims("bo"), { token: invite.token });
    const seasonId = (await crewStore.listSeasons(created.crew.crewId))[0]!.seasonId;

    await recordPlayed({ snapshots, projectionStore }, singlesArchive("r1", 5 * day, ann, bo, ann, {}), 5 * day); // before the close

    await close(asClaims("ann"), created.crew.crewId, seasonId);
    await recordPlayed({ snapshots, projectionStore }, singlesArchive("r2", 20 * day, ann, bo, bo, {}), 20 * day); // after the close

    const closed = await standings(asClaims("ann"), created.crew.crewId, seasonId);
    expect(closed.rounds.map((r) => r.roundId)).toEqual([roundId("r1")]); // r2 stays out
    expect(closed.scoreboard.find((row) => row.golferId === ann)?.rounds).toBe(1);

    await reopen(asClaims("ann"), created.crew.crewId, seasonId);
    const reopened = await standings(asClaims("ann"), created.crew.crewId, seasonId);
    expect(reopened.rounds.map((r) => r.roundId).sort()).toEqual([roundId("r1"), roundId("r2")].sort());
    expect(reopened.scoreboard.find((row) => row.golferId === ann)?.rounds).toBe(2);
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
  // "carries hand-pinned partners + mostImproved" fixture's mostImproved/lowestNet halves are
  // gone with the superlatives they fed.
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
    const season = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2026" });

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
  it("removes the caller's own member item; the OLD counted-round entry (a separate, still-standing legacy mechanism) is untouched, but the round drops out of the DERIVED standings entirely once only one roster member remains (members-only, compute-on-read)", async () => {
    const ctx = setup();
    const { ann, bo, crewId, seasonId } = await crewWithSeason(ctx);
    await recordPlayed(ctx, singlesArchive("r1", 5_000, ann, bo, ann, {}), 5_000);
    await ctx.append(asClaims("bo"), crewId, seasonId, { roundId: roundId("r1") }); // Bo appended it (legacy mechanism)

    const left = await ctx.leave(asClaims("bo"), crewId);

    expect(left).toEqual({ crewId });
    // Bo is off the roster now...
    const crew = await ctx.crewStore.get(crewId);
    expect(crew!.crew.members.some((member) => member.golferId === bo)).toBe(false);
    // ...the OLD counted-round entry is untouched (nothing about it is deleted; it simply feeds
    // nothing standings reads anymore)...
    expect(await ctx.crewStore.listCountedRounds(crewId, seasonId)).toHaveLength(1);
    // ...but standings are derived fresh from the CURRENT roster: with only Ann left, r1 no
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

// GET /crews/{crewId}/records (crew-scoreboard spec §3b): all-time, over every round the roster
// has ever shared.
describe("getCrewRecords", () => {
  it("all-time folds every round the roster has ever shared, once each, through the SAME roster-filter + aggregateSeason composition standings uses", async () => {
    const ctx = setup();
    const ann = await seedGolfer(ctx, "ann", "Ann");
    const bo = await seedGolfer(ctx, "bo", "Bo");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });
    const invite = await ctx.mint(asClaims("ann"), created.crew.crewId);
    await ctx.join(asClaims("bo"), { token: invite.token });

    await recordPlayed(ctx, singlesArchive("r1", 5_000, ann, bo, ann, {}), 5_000);

    const records = await ctx.records(asClaims("ann"), created.crew.crewId);

    expect(records.rounds).toBe(1);
    expect(records.ledger).toEqual(
      expect.arrayContaining([expect.objectContaining({ golferId: ann, rounds: 1, wins: 1 }), expect.objectContaining({ golferId: bo, rounds: 1, losses: 1 })]),
    );
    expect(records.headToHead).toEqual([expect.objectContaining({ aWins: 1, bWins: 0 })]);
  });

  it("titles: each CLOSED season's Stableford points leader, windowed to that season's own dates — an open season contributes no title", async () => {
    const ctx = setup();
    const ann = await seedGolfer(ctx, "ann", "Ann");
    const bo = await seedGolfer(ctx, "bo", "Bo");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });
    const invite = await ctx.mint(asClaims("ann"), created.crew.crewId);
    await ctx.join(asClaims("bo"), { token: invite.token });
    const closedSeason = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2025" });
    const openSeason = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2026" });

    // Directly stamp each season's own window — the closed season's is [0, 10_000), the open
    // one's starts right where it ends and never closes — so r1 (wallMs 5_000) falls inside the
    // closed season's window and r2 (wallMs 20_000) falls only inside the still-open one's.
    const closed = await ctx.crewStore.getSeason(created.crew.crewId, closedSeason.season.seasonId);
    await ctx.crewStore.putSeason(created.crew.crewId, { ...closed!, startsAtMs: 0, status: "closed", closedAtMs: 10_000 });
    const open = await ctx.crewStore.getSeason(created.crew.crewId, openSeason.season.seasonId);
    await ctx.crewStore.putSeason(created.crew.crewId, { ...open!, startsAtMs: 10_000 });

    await recordPlayed(ctx, stablefordArchive("r1", 5_000, [ann, bo], { [ann]: 40, [bo]: 30 }), 5_000);
    await recordPlayed(ctx, stablefordArchive("r2", 20_000, [ann, bo], { [ann]: 20, [bo]: 25 }), 20_000);

    const records = await ctx.records(asClaims("ann"), created.crew.crewId);

    expect(records.titles).toEqual([{ seasonId: closedSeason.season.seasonId, name: "2025", golfers: [{ golferId: ann, name: "Ann" }] }]);
  });

  // The conditional endMs spread (spec §3b): a LEGACY closed season (closed before this arc) has
  // no closedAtMs at all — its window must read as open-ended rather than crash or silently
  // exclude everything.
  it("a LEGACY closed season with no closedAtMs reads as an open-ended window, never a crash", async () => {
    const ctx = setup();
    const ann = await seedGolfer(ctx, "ann", "Ann");
    const bo = await seedGolfer(ctx, "bo", "Bo");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });
    const invite = await ctx.mint(asClaims("ann"), created.crew.crewId);
    await ctx.join(asClaims("bo"), { token: invite.token });
    const closedSeason = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2025" });

    // The legacy shape: status "closed", no closedAtMs.
    const stored = await ctx.crewStore.getSeason(created.crew.crewId, closedSeason.season.seasonId);
    await ctx.crewStore.putSeason(created.crew.crewId, { ...stored!, startsAtMs: 0, status: "closed" });

    // Played long after — nothing about the legacy season's own window excludes it.
    await recordPlayed(ctx, stablefordArchive("r1", 999_999, [ann, bo], { [ann]: 40, [bo]: 30 }), 999_999);

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

    const stored2024 = await ctx.crewStore.getSeason(created.crew.crewId, season2024.season.seasonId);
    await ctx.crewStore.putSeason(created.crew.crewId, { ...stored2024!, startsAtMs: 0, status: "closed", closedAtMs: 10_000 });
    const stored2025 = await ctx.crewStore.getSeason(created.crew.crewId, season2025.season.seasonId);
    await ctx.crewStore.putSeason(created.crew.crewId, { ...stored2025!, startsAtMs: 10_000, status: "closed", closedAtMs: 20_000 });

    await recordPlayed(ctx, stablefordArchive("r1", 5_000, [ann, bo], { [ann]: 40, [bo]: 30 }), 5_000); // in 2024's window, Ann wins
    await recordPlayed(ctx, stablefordArchive("r2", 15_000, [ann, bo], { [ann]: 20, [bo]: 35 }), 15_000); // in 2025's window, Bo wins

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
      // wallMs 500 — comfortably before whatever tiny clock reading ctx.close() below stamps
      // (the shared fixed clock starts at 1_000 and only advances), so the round stays inside
      // the closed season's own window regardless of how many prior calls ticked it forward.
      await recordPlayed(ctx, stablefordArchive("r1", 500, [ann, bo], { [ann]: 40, [bo]: 30 }), 500);

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
