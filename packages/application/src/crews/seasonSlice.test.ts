import { describe, expect, it } from "vitest";
import { deviceId, fixtureLinks18, gameId, golferId, opId, roundId } from "@swng/domain";
import type { GolferId, Participant, RoundArchive, RoundEvent } from "@swng/domain";
import type { AccountClaims } from "../ports/accountClaims.js";
import {
  createFixedClock,
  createInMemoryCrewStore,
  createInMemoryGolferStore,
  createInMemorySnapshotStore,
  createSequentialIds,
  createTestTokenIssuer,
  putAndBindGolfer,
} from "../testing/fakes.js";
import { appendCountedRound } from "./appendCountedRound.js";
import { createCrew } from "./createCrew.js";
import { createSeason } from "./createSeason.js";
import { getSeasonStandings } from "./getSeasonStandings.js";
import { joinCrewByInvite } from "./joinCrewByInvite.js";
import { leaveCrew } from "./leaveCrew.js";
import { listSeasons } from "./listSeasons.js";
import { mintCrewInvite } from "./mintCrewInvite.js";
import { removeCountedRound } from "./removeCountedRound.js";

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

const setup = () => {
  const crewStore = createInMemoryCrewStore();
  const golferStore = createInMemoryGolferStore();
  const snapshots = createInMemorySnapshotStore();
  const tokenIssuer = createTestTokenIssuer();
  const ids = createSequentialIds("t");
  const clock = createFixedClock(1_000);
  return {
    crewStore,
    golferStore,
    snapshots,
    create: createCrew({ crewStore, golferStore, ids }),
    // Crew membership (invited in, accountable out): the permanent join code is gone —
    // mint/join replace it. `mint` and `join` share this ctx's ONE tokenIssuer/clock, same as
    // every real caller shares ONE hmacTokenIssuer/system clock through compositionRoot.
    mint: mintCrewInvite({ crewStore, golferStore, tokenIssuer, clock }),
    join: joinCrewByInvite({ crewStore, golferStore, tokenIssuer, clock }),
    createSeason: createSeason({ crewStore, golferStore, ids, clock }),
    listSeasons: listSeasons({ crewStore, golferStore }),
    append: appendCountedRound({ crewStore, golferStore, snapshots, clock }),
    remove: removeCountedRound({ crewStore, golferStore }),
    standings: getSeasonStandings({ crewStore, golferStore, snapshots }),
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

    await expect(ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "   " })).rejects.toMatchObject({ code: "invalid-season-name" });
    await expect(ctx.listSeasons(asClaims("ann"), created.crew.crewId)).resolves.toEqual({ seasons: [] });
  });

  it("a name past 60 characters is rejected — invalid-season-name", async () => {
    const ctx = setup();
    await seedGolfer(ctx, "ann", "Ann");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });

    await expect(ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "x".repeat(61) })).rejects.toMatchObject({ code: "invalid-season-name" });
  });
});

describe("listSeasons", () => {
  it("returns a member's crew seasons newest-first by createdAtMs", async () => {
    const ctx = setup();
    await seedGolfer(ctx, "ann", "Ann");
    const created = await ctx.create(asClaims("ann"), { name: "Sunday Skins" });
    const first = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2025" });
    const second = await ctx.createSeason(asClaims("ann"), created.crew.crewId, { name: "2026" });

    const listed = await ctx.listSeasons(asClaims("ann"), created.crew.crewId);
    // createFixedClock advances 1ms per call, so `second` has the later createdAtMs → first out.
    expect(listed.seasons.map((s) => s.seasonId)).toEqual([second.season.seasonId, first.season.seasonId]);
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
    // Close the season directly (there is no close route in v1 — putSeason upsert).
    const season = await ctx.crewStore.getSeason(crewId, seasonId);
    await ctx.crewStore.putSeason(crewId, { ...season!, status: "closed" });

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
    const season = await ctx.crewStore.getSeason(crewId, seasonId);
    await ctx.crewStore.putSeason(crewId, { ...season!, status: "closed" });

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
});
