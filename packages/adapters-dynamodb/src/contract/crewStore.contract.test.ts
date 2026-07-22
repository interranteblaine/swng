import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Crew, CrewMember } from "@swng/domain";
import { addMember, crewId, golferId, roundId } from "@swng/domain";
import type { CountedRound, CrewSeason } from "@swng/application";
import { createDynamoCrewStore } from "../createDynamoCrewStore.js";
import { crewPk, crewSk, memberSk, seasonSk } from "../keys.js";
import type { LocalDynamo } from "../testing/local.js";
import { startLocalDynamo } from "../testing/local.js";

// Contract suite (M8 Task 3; the permanent join code + its gsi1 partition died with crew
// membership's "invited in" rework — findByJoinCode is gone), same idiom as
// courseStore.contract.test.ts/golferStore.contract.test.ts: proves createDynamoCrewStore
// against a real DynamoDB Local against the SAME spec the in-memory fake
// (application/testing/fakes.ts's createInMemoryCrewStore) satisfies — put's expectedRevision
// contract + MEMBER-item reconciliation, and listByGolfer's gsi2 + batch-get path. Not part of
// `pnpm validate`; run via `pnpm test:contract`.

let local: LocalDynamo;

beforeAll(async () => {
  local = await startLocalDynamo();
}, 120_000);

afterAll(async () => {
  await local?.stop();
});

const newStore = () => createDynamoCrewStore({ client: local.client, tableName: local.coreTable });

const member = (name: string, role: CrewMember["role"] = "member"): CrewMember => ({ golferId: golferId(randomUUID()), name, role });

const makeCrew = (name: string, members: readonly CrewMember[] = []): Crew =>
  members.reduce((crew, m) => addMember(crew, m), { id: crewId(randomUUID()), name, members: [] } as Crew);

describe("createDynamoCrewStore", () => {
  describe("put/get round-trip", () => {
    it("put (create) + get round-trip", async () => {
      const store = newStore();
      const organizer = member("Ann", "organizer");
      const crew = makeCrew("Saturday Regulars", [organizer]);

      await store.put(crew, undefined);

      expect(await store.get(crew.id)).toEqual({ crew, revision: 1 });
    });

    it("get on an unknown crewId returns undefined", async () => {
      const store = newStore();
      expect(await store.get(crewId(randomUUID()))).toBeUndefined();
    });

    it("create-when-exists (expectedRevision undefined against an existing item) throws crew-conflict", async () => {
      const store = newStore();
      const crew = makeCrew("Wednesday Niners");
      await store.put(crew, undefined);

      await expect(store.put(crew, undefined)).rejects.toMatchObject({ code: "crew-conflict" });
    });

    it("stale-revision replace throws crew-conflict, and a correct-revision replace lands + bumps revision", async () => {
      const store = newStore();
      const crew = makeCrew("Pine Hollow Crew");
      await store.put(crew, undefined);

      // Stale: the item is at revision 1, not 2.
      await expect(store.put(crew, 2)).rejects.toMatchObject({ code: "crew-conflict" });

      const renamed = { ...crew, name: "Pine Hollow GC Crew" };
      await store.put(renamed, 1);

      expect(await store.get(crew.id)).toEqual({ crew: renamed, revision: 2 });
    });

    // A crew is a grouping/competition ONLY (owner ruling, spec §11a, 2026-07-13) — the old
    // "standing game" preset is deleted from the domain Crew type outright. Stored crew
    // documents on beta may still carry a `standingGame` attribute from before that ruling;
    // this proves the tolerate-and-ignore contract end to end against real DynamoDB: a legacy
    // document reads back clean (no such property survives `get`), and the very next `put` (a
    // whole-document write of that now-clean Crew) leaves no trace of it in storage either —
    // never a migration script.
    it("a legacy stored crew carrying a stray standingGame attribute reads back clean, and the next put drops it from storage too", async () => {
      const store = newStore();
      const crew = makeCrew("Legacy Crew", [member("Ann", "organizer")]);

      // Seed the LEGACY shape directly with a raw PutCommand — never through the store API,
      // which can no longer even TYPE a standingGame field (or a joinCode/gsi1pk/gsi1sk one —
      // crew membership, invited in — this test only still needs to cover standingGame).
      await local.client.send(
        new PutCommand({
          TableName: local.coreTable,
          Item: {
            pk: crewPk(crew.id),
            sk: crewSk,
            revision: 1,
            crew: { ...crew, standingGame: { tee: "white", games: [{ kind: "skins", players: [crew.members[0]!.golferId] }] } },
          },
        }),
      );

      const found = await store.get(crew.id);
      expect(found?.crew).toEqual(crew); // clean — no standingGame property survives the read
      expect(found?.crew).not.toHaveProperty("standingGame");

      // The next put is a WHOLE-DOCUMENT write of that now-clean Crew — the attribute is gone
      // from storage too, proven with a raw GetCommand (not the store's own `get`, which would
      // tolerate it either way).
      await store.put(found!.crew, found!.revision);
      const raw = await local.client.send(new GetCommand({ TableName: local.coreTable, Key: { pk: crewPk(crew.id), sk: crewSk } }));
      expect(raw.Item?.crew).not.toHaveProperty("standingGame");
    });
  });

  describe("MEMBER item reconciliation", () => {
    it("put writes one MEMBER item per roster member", async () => {
      const store = newStore();
      const a = member("Ann", "organizer");
      const b = member("Bo");
      const crew = makeCrew("Roster Crew", [a, b]);

      await store.put(crew, undefined);

      for (const m of [a, b]) {
        const raw = await local.client.send(new GetCommand({ TableName: local.coreTable, Key: { pk: crewPk(crew.id), sk: memberSk(m.golferId) } }));
        expect(raw.Item).toMatchObject({ name: m.name, role: m.role });
      }
    });

    it("adding a member on a later put adds its MEMBER item; removing one deletes it — other members untouched", async () => {
      const store = newStore();
      const a = member("Ann", "organizer");
      const b = member("Bo");
      const c = member("Cy");
      const crew = makeCrew("Churning Crew", [a, b]);
      await store.put(crew, undefined);

      // Add c, remove b.
      const next: Crew = { ...crew, members: [a, c] };
      await store.put(next, 1);

      const get = async (golferId: CrewMember["golferId"]) =>
        (await local.client.send(new GetCommand({ TableName: local.coreTable, Key: { pk: crewPk(crew.id), sk: memberSk(golferId) } }))).Item;

      expect(await get(a.golferId)).toBeDefined(); // untouched
      expect(await get(b.golferId)).toBeUndefined(); // removed
      expect(await get(c.golferId)).toBeDefined(); // added
    });

    it("a member's changed name/role is reflected in its MEMBER item on the next put", async () => {
      const store = newStore();
      const a = member("Ann", "member");
      const crew = makeCrew("Promotion Crew", [a]);
      await store.put(crew, undefined);

      const promoted: CrewMember = { ...a, role: "organizer", name: "Ann Promoted" };
      const next: Crew = { ...crew, members: [promoted] };
      await store.put(next, 1);

      const raw = await local.client.send(new GetCommand({ TableName: local.coreTable, Key: { pk: crewPk(crew.id), sk: memberSk(a.golferId) } }));
      expect(raw.Item).toMatchObject({ name: "Ann Promoted", role: "organizer" });
    });
  });

  // findByJoinCode (and the crew's own dedicated gsi1 partition it queried) is GONE — crew
  // membership, invited in: getting in is an expiring HMAC invite link now, never a
  // store-resident lookup (see createDynamoCrewStore.ts's own doc comment on CrewItem).

  describe("listByGolfer", () => {
    it("lists every crew a golfer belongs to, across crews, with name + memberCount", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const shared = { golferId: golfer, name: "Dee", role: "member" as const };
      const crewA = makeCrew("Crew A", [member("Ann", "organizer"), shared]);
      const crewB = makeCrew("Crew B", [shared]);
      const crewC = makeCrew("Crew C", [member("Zed", "organizer")]); // golfer NOT a member
      await store.put(crewA, undefined);
      await store.put(crewB, undefined);
      await store.put(crewC, undefined);

      const found = await store.listByGolfer(golfer);

      expect(new Set(found.map((f) => f.crewId))).toEqual(new Set([crewA.id, crewB.id]));
      expect(found.find((f) => f.crewId === crewA.id)).toEqual({ crewId: crewA.id, name: "Crew A", memberCount: 2 });
      expect(found.find((f) => f.crewId === crewB.id)).toEqual({ crewId: crewB.id, name: "Crew B", memberCount: 1 });
    });

    it("returns [] for a golfer on no crews", async () => {
      const store = newStore();
      expect(await store.listByGolfer(golferId(randomUUID()))).toEqual([]);
    });

    it("removing a member on a later put drops the crew from their listByGolfer result", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const leaving = { golferId: golfer, name: "Cal", role: "member" as const };
      const stayer = member("Ann", "organizer");
      const crew = makeCrew("Departure Crew", [stayer, leaving]);
      await store.put(crew, undefined);
      expect(await store.listByGolfer(golfer)).toEqual([{ crewId: crew.id, name: "Departure Crew", memberCount: 2 }]);

      await store.put({ ...crew, members: [stayer] }, 1);

      expect(await store.listByGolfer(golfer)).toEqual([]);
    });
  });

  // Seasons + counted rounds (realignment task-8-brief.md): proves createDynamoCrewStore
  // against the SAME spec createInMemoryCrewStore (application/testing/fakes.ts) satisfies —
  // upsert-by-seasonId, listSeasons' client-side exclusion of counted-round entries,
  // addCountedRound's attribute_not_exists(sk) collision → round-already-counted, the SAME
  // round counted in TWO seasons of one crew independently, remove-then-list, and countsRound's
  // any-season scope.
  describe("seasons + counted rounds", () => {
    const newSeason = (name: string, status: CrewSeason["status"] = "open"): CrewSeason => ({
      seasonId: randomUUID(),
      name,
      status,
      createdAtMs: Date.now(),
      startsAtMs: Date.now(),
    });

    const newCountedRound = (roundIdValue = roundId(randomUUID())): CountedRound => ({
      roundId: roundIdValue,
      finalizedAtMs: Date.now(),
      appendedBy: golferId(randomUUID()),
      appendedAtMs: Date.now(),
    });

    describe("putSeason / getSeason / listSeasons", () => {
      it("putSeason (create) + getSeason round-trip", async () => {
        const store = newStore();
        const crew = makeCrew("Season Crew");
        await store.put(crew, undefined);
        const season = newSeason("2026");

        await store.putSeason(crew.id, season);

        expect(await store.getSeason(crew.id, season.seasonId)).toEqual(season);
      });

      it("getSeason on an unknown seasonId returns undefined", async () => {
        const store = newStore();
        const crew = makeCrew("Absent Season Crew");
        await store.put(crew, undefined);

        expect(await store.getSeason(crew.id, randomUUID())).toBeUndefined();
      });

      it("putSeason is an unconditional upsert — a repeat put with the SAME seasonId renames/closes it in place", async () => {
        const store = newStore();
        const crew = makeCrew("Renaming Crew");
        await store.put(crew, undefined);
        const season = newSeason("2026 Season", "open");
        await store.putSeason(crew.id, season);

        const closed: CrewSeason = { ...season, name: "2026 Season (final)", status: "closed" };
        await store.putSeason(crew.id, closed);

        expect(await store.getSeason(crew.id, season.seasonId)).toEqual(closed);
        expect(await store.listSeasons(crew.id)).toEqual([closed]);
      });

      it("listSeasons returns every season for the crew and EXCLUDES counted-round entries", async () => {
        const store = newStore();
        const crew = makeCrew("Multi-Season Crew");
        await store.put(crew, undefined);
        const seasonA = newSeason("2025");
        const seasonB = newSeason("2026");
        await store.putSeason(crew.id, seasonA);
        await store.putSeason(crew.id, seasonB);
        await store.addCountedRound(crew.id, seasonA.seasonId, newCountedRound());
        await store.addCountedRound(crew.id, seasonA.seasonId, newCountedRound());

        const found = await store.listSeasons(crew.id);

        expect(new Set(found.map((s) => s.seasonId))).toEqual(new Set([seasonA.seasonId, seasonB.seasonId]));
        expect(found).toHaveLength(2); // the two counted-round entries under seasonA are NOT seasons
      });

      it("listSeasons returns [] for a crew with no seasons", async () => {
        const store = newStore();
        const crew = makeCrew("Seasonless Crew");
        await store.put(crew, undefined);

        expect(await store.listSeasons(crew.id)).toEqual([]);
      });
    });

    // Window bounds (crew-scoreboard spec §2): startsAtMs is required and always carried;
    // closedAtMs is optional and present ONLY once a season has been closed. The legacy fold and
    // the whole-item-put reopen guarantee are both real invariants beta storage depends on, so
    // they're proven here against DynamoDB Local, not just the in-memory fake.
    describe("season window bounds (crew-scoreboard spec §2)", () => {
      it("an OPEN season round-trips startsAtMs and carries NO closedAtMs at all", async () => {
        const store = newStore();
        const crew = makeCrew("Window Crew");
        await store.put(crew, undefined);
        const season = newSeason("2026");

        await store.putSeason(crew.id, season);

        const found = await store.getSeason(crew.id, season.seasonId);
        expect(found).toEqual(season);
        expect(found).not.toHaveProperty("closedAtMs");
        expect(await store.listSeasons(crew.id)).toEqual([season]);
      });

      it("a CLOSED season round-trips both startsAtMs and closedAtMs", async () => {
        const store = newStore();
        const crew = makeCrew("Closed Window Crew");
        await store.put(crew, undefined);
        const closed: CrewSeason = { ...newSeason("2026"), status: "closed", closedAtMs: Date.now() };

        await store.putSeason(crew.id, closed);

        expect(await store.getSeason(crew.id, closed.seasonId)).toEqual(closed);
        expect(await store.listSeasons(crew.id)).toEqual([closed]);
      });

      // Legacy fold: a season row written before startsAtMs existed (seeded directly with a raw
      // PutCommand, never through the store API — which can no longer even TYPE a CrewSeason
      // missing the field) reads back as startsAtMs === createdAtMs, no migration.
      it("a legacy season item with no stored startsAtMs reads back as startsAtMs === createdAtMs", async () => {
        const store = newStore();
        const crew = makeCrew("Legacy Season Crew");
        await store.put(crew, undefined);
        const seasonId = randomUUID();
        const createdAtMs = Date.now();

        await local.client.send(
          new PutCommand({
            TableName: local.coreTable,
            Item: { pk: crewPk(crew.id), sk: seasonSk(seasonId), season: { seasonId, name: "2020", status: "open", createdAtMs } },
          }),
        );

        const found = await store.getSeason(crew.id, seasonId);
        expect(found?.startsAtMs).toBe(createdAtMs);
        expect(found).toEqual({ seasonId, name: "2020", status: "open", createdAtMs, startsAtMs: createdAtMs });

        const listed = await store.listSeasons(crew.id);
        expect(listed).toEqual([{ seasonId, name: "2020", status: "open", createdAtMs, startsAtMs: createdAtMs }]);
      });

      // Whole-item-put proof (the port doc's own contract, reopenSeason.ts's reason for
      // existing): closing sets closedAtMs, reopening — putSeason called with a CrewSeason that
      // has NO closedAtMs property at all — must leave the field truly ABSENT in storage, not
      // present-but-undefined. Checked with a raw GetCommand, not the store's own getSeason
      // (which would tolerate either shape).
      it("close-then-reopen (a putSeason with no closedAtMs property) ends with closedAtMs truly ABSENT from storage", async () => {
        const store = newStore();
        const crew = makeCrew("Reopen Crew");
        await store.put(crew, undefined);
        const open = newSeason("2026");
        await store.putSeason(crew.id, open);

        const closed: CrewSeason = { ...open, status: "closed", closedAtMs: Date.now() };
        await store.putSeason(crew.id, closed);
        const rawClosed = await local.client.send(new GetCommand({ TableName: local.coreTable, Key: { pk: crewPk(crew.id), sk: seasonSk(open.seasonId) } }));
        expect(rawClosed.Item?.season).toHaveProperty("closedAtMs");

        // Reopen: the caller's own CrewSeason (mirroring reopenSeason.ts) carries no
        // closedAtMs property whatsoever.
        const reopened: CrewSeason = { seasonId: open.seasonId, name: open.name, status: "open", createdAtMs: open.createdAtMs, startsAtMs: open.startsAtMs };
        expect(reopened).not.toHaveProperty("closedAtMs");
        await store.putSeason(crew.id, reopened);

        const raw = await local.client.send(new GetCommand({ TableName: local.coreTable, Key: { pk: crewPk(crew.id), sk: seasonSk(open.seasonId) } }));
        expect(raw.Item?.season).not.toHaveProperty("closedAtMs");
        expect(await store.getSeason(crew.id, open.seasonId)).toEqual(reopened);
      });
    });

    describe("addCountedRound / listCountedRounds", () => {
      it("addCountedRound + listCountedRounds round-trip", async () => {
        const store = newStore();
        const crew = makeCrew("Counting Crew");
        await store.put(crew, undefined);
        const season = newSeason("2026");
        await store.putSeason(crew.id, season);
        const entry = newCountedRound();

        await store.addCountedRound(crew.id, season.seasonId, entry);

        expect(await store.listCountedRounds(crew.id, season.seasonId)).toEqual([entry]);
      });

      it("a duplicate addCountedRound for the SAME roundId in the SAME season throws round-already-counted", async () => {
        const store = newStore();
        const crew = makeCrew("Duplicate Crew");
        await store.put(crew, undefined);
        const season = newSeason("2026");
        await store.putSeason(crew.id, season);
        const entry = newCountedRound();
        await store.addCountedRound(crew.id, season.seasonId, entry);

        await expect(store.addCountedRound(crew.id, season.seasonId, newCountedRound(entry.roundId))).rejects.toMatchObject({
          code: "round-already-counted",
        });
        // Untouched by the failed second attempt.
        expect(await store.listCountedRounds(crew.id, season.seasonId)).toEqual([entry]);
      });

      it("the SAME round counted in TWO seasons of one crew is allowed — each season is its own lens", async () => {
        const store = newStore();
        const crew = makeCrew("Two-Season Crew");
        await store.put(crew, undefined);
        const seasonA = newSeason("2025");
        const seasonB = newSeason("2026");
        await store.putSeason(crew.id, seasonA);
        await store.putSeason(crew.id, seasonB);
        const shared = roundId(randomUUID());
        const entryA = newCountedRound(shared);
        const entryB = newCountedRound(shared);

        await store.addCountedRound(crew.id, seasonA.seasonId, entryA);
        await store.addCountedRound(crew.id, seasonB.seasonId, entryB);

        expect(await store.listCountedRounds(crew.id, seasonA.seasonId)).toEqual([entryA]);
        expect(await store.listCountedRounds(crew.id, seasonB.seasonId)).toEqual([entryB]);
      });

      it("listCountedRounds returns [] for a season with none, and scopes strictly to its own season", async () => {
        const store = newStore();
        const crew = makeCrew("Scoped Crew");
        await store.put(crew, undefined);
        const seasonA = newSeason("2025");
        const seasonB = newSeason("2026");
        await store.putSeason(crew.id, seasonA);
        await store.putSeason(crew.id, seasonB);
        await store.addCountedRound(crew.id, seasonA.seasonId, newCountedRound());

        expect(await store.listCountedRounds(crew.id, seasonB.seasonId)).toEqual([]);
      });

      it("removeCountedRound then listCountedRounds no longer shows it; removing an absent entry is a no-op", async () => {
        const store = newStore();
        const crew = makeCrew("Removal Crew");
        await store.put(crew, undefined);
        const season = newSeason("2026");
        await store.putSeason(crew.id, season);
        const keep = newCountedRound();
        const drop = newCountedRound();
        await store.addCountedRound(crew.id, season.seasonId, keep);
        await store.addCountedRound(crew.id, season.seasonId, drop);

        await store.removeCountedRound(crew.id, season.seasonId, drop.roundId);

        expect(await store.listCountedRounds(crew.id, season.seasonId)).toEqual([keep]);

        // Removing again (already gone) and removing a roundId that was never there: both no-ops.
        await expect(store.removeCountedRound(crew.id, season.seasonId, drop.roundId)).resolves.toBeUndefined();
        await expect(store.removeCountedRound(crew.id, season.seasonId, roundId(randomUUID()))).resolves.toBeUndefined();
        expect(await store.listCountedRounds(crew.id, season.seasonId)).toEqual([keep]);
      });
    });

    describe("countsRound", () => {
      it("is true when the round is counted in ANY season of the crew", async () => {
        const store = newStore();
        const crew = makeCrew("Counts Crew");
        await store.put(crew, undefined);
        const seasonA = newSeason("2025");
        const seasonB = newSeason("2026");
        await store.putSeason(crew.id, seasonA);
        await store.putSeason(crew.id, seasonB);
        const entry = newCountedRound();
        await store.addCountedRound(crew.id, seasonB.seasonId, entry);

        expect(await store.countsRound(crew.id, entry.roundId)).toBe(true);
      });

      it("is false for a round never counted in this crew, and false for one counted only in a DIFFERENT crew", async () => {
        const store = newStore();
        const crewA = makeCrew("Crew A");
        const crewB = makeCrew("Crew B");
        await store.put(crewA, undefined);
        await store.put(crewB, undefined);
        const season = newSeason("2026");
        await store.putSeason(crewB.id, season);
        const entry = newCountedRound();
        await store.addCountedRound(crewB.id, season.seasonId, entry);

        expect(await store.countsRound(crewA.id, entry.roundId)).toBe(false); // never counted anywhere in crewA
        expect(await store.countsRound(crewA.id, roundId(randomUUID()))).toBe(false); // an unrelated roundId entirely
      });

      it("is false after the ONLY counted entry for a round is removed", async () => {
        const store = newStore();
        const crew = makeCrew("Uncounts Crew");
        await store.put(crew, undefined);
        const season = newSeason("2026");
        await store.putSeason(crew.id, season);
        const entry = newCountedRound();
        await store.addCountedRound(crew.id, season.seasonId, entry);
        expect(await store.countsRound(crew.id, entry.roundId)).toBe(true);

        await store.removeCountedRound(crew.id, season.seasonId, entry.roundId);

        expect(await store.countsRound(crew.id, entry.roundId)).toBe(false);
      });
    });

    describe("seasonId guard — # character forbidden", () => {
      it("putSeason rejects seasonId containing '#' with a plain Error and writes nothing", async () => {
        const store = newStore();
        const crew = makeCrew("Guard Crew");
        await store.put(crew, undefined);
        const badSeason: CrewSeason = { seasonId: "X#ROUND#Y", name: "Bad Season", status: "open", createdAtMs: Date.now(), startsAtMs: Date.now() };

        await expect(store.putSeason(crew.id, badSeason)).rejects.toThrow(/seasonId contains "#"/);

        // Verify nothing was written: getSeason returns undefined and listSeasons is empty.
        expect(await store.getSeason(crew.id, badSeason.seasonId)).toBeUndefined();
        expect(await store.listSeasons(crew.id)).toEqual([]);
      });

      it("addCountedRound rejects seasonId containing '#' with a plain Error and writes nothing", async () => {
        const store = newStore();
        const crew = makeCrew("Guard Crew 2");
        await store.put(crew, undefined);
        const badSeasonId = "X#ROUND#Y";
        const entry = newCountedRound();

        await expect(store.addCountedRound(crew.id, badSeasonId, entry)).rejects.toThrow(/seasonId contains "#"/);

        // Verify nothing was written: listCountedRounds is empty and countsRound is false.
        expect(await store.listCountedRounds(crew.id, badSeasonId)).toEqual([]);
        expect(await store.countsRound(crew.id, entry.roundId)).toBe(false);
      });
    });
  });
});
