import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Crew, CrewMember } from "@swng/domain";
import { addMember, crewId, golferId, roundId } from "@swng/domain";
import type { CountedRound, CrewSeason } from "@swng/application";
import { createDynamoCrewStore } from "../createDynamoCrewStore.js";
import { crewGsi1pk, crewPk, crewSk, memberSk } from "../keys.js";
import type { LocalDynamo } from "../testing/local.js";
import { startLocalDynamo } from "../testing/local.js";

// Contract suite (M8 Task 3), same idiom as courseStore.contract.test.ts/
// golferStore.contract.test.ts: proves createDynamoCrewStore against a real DynamoDB Local
// against the SAME spec the in-memory fake (application/testing/fakes.ts's
// createInMemoryCrewStore) satisfies — put's expectedRevision contract + MEMBER-item
// reconciliation, findByJoinCode's reused-gsi1 lookup, and listByGolfer's gsi2 + batch-get
// path. Not part of `pnpm validate`; run via `pnpm test:contract`.

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

const newJoinCode = () => randomUUID().slice(0, 6).toUpperCase();

describe("createDynamoCrewStore", () => {
  describe("put/get round-trip", () => {
    it("put (create) + get round-trip, including joinCode", async () => {
      const store = newStore();
      const organizer = member("Ann", "organizer");
      const crew = makeCrew("Saturday Regulars", [organizer]);
      const joinCode = newJoinCode();

      await store.put(crew, joinCode, undefined);

      expect(await store.get(crew.id)).toEqual({ crew, joinCode, revision: 1 });
    });

    it("get on an unknown crewId returns undefined", async () => {
      const store = newStore();
      expect(await store.get(crewId(randomUUID()))).toBeUndefined();
    });

    it("create-when-exists (expectedRevision undefined against an existing item) throws crew-conflict", async () => {
      const store = newStore();
      const crew = makeCrew("Wednesday Niners");
      await store.put(crew, newJoinCode(), undefined);

      await expect(store.put(crew, newJoinCode(), undefined)).rejects.toMatchObject({ code: "crew-conflict" });
    });

    it("stale-revision replace throws crew-conflict, and a correct-revision replace lands + bumps revision", async () => {
      const store = newStore();
      const crew = makeCrew("Pine Hollow Crew");
      const joinCode = newJoinCode();
      await store.put(crew, joinCode, undefined);

      // Stale: the item is at revision 1, not 2.
      await expect(store.put(crew, joinCode, 2)).rejects.toMatchObject({ code: "crew-conflict" });

      const renamed = { ...crew, name: "Pine Hollow GC Crew" };
      await store.put(renamed, joinCode, 1);

      expect(await store.get(crew.id)).toEqual({ crew: renamed, joinCode, revision: 2 });
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
      const joinCode = newJoinCode();

      // Seed the LEGACY shape directly with a raw PutCommand — never through the store API,
      // which can no longer even TYPE a standingGame field.
      await local.client.send(
        new PutCommand({
          TableName: local.coreTable,
          Item: {
            pk: crewPk(crew.id),
            sk: crewSk,
            revision: 1,
            joinCode,
            gsi1pk: crewGsi1pk,
            gsi1sk: joinCode,
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
      await store.put(found!.crew, joinCode, found!.revision);
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

      await store.put(crew, newJoinCode(), undefined);

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
      await store.put(crew, newJoinCode(), undefined);

      // Add c, remove b.
      const next: Crew = { ...crew, members: [a, c] };
      await store.put(next, newJoinCode(), 1);

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
      await store.put(crew, newJoinCode(), undefined);

      const promoted: CrewMember = { ...a, role: "organizer", name: "Ann Promoted" };
      const next: Crew = { ...crew, members: [promoted] };
      await store.put(next, newJoinCode(), 1);

      const raw = await local.client.send(new GetCommand({ TableName: local.coreTable, Key: { pk: crewPk(crew.id), sk: memberSk(a.golferId) } }));
      expect(raw.Item).toMatchObject({ name: "Ann Promoted", role: "organizer" });
    });
  });

  describe("findByJoinCode", () => {
    it("resolves a minted join code to its crewId", async () => {
      const store = newStore();
      const crew = makeCrew("Findable Crew");
      const joinCode = newJoinCode();
      await store.put(crew, joinCode, undefined);

      expect(await store.findByJoinCode(joinCode)).toBe(crew.id);
    });

    it("returns undefined for an unknown code", async () => {
      const store = newStore();
      expect(await store.findByJoinCode(`MISSING${randomUUID().slice(0, 4).toUpperCase()}`)).toBeUndefined();
    });

    it("the underlying gsi1 query is namespaced under crewGsi1pk, distinct from course search's partition", async () => {
      const store = newStore();
      const crew = makeCrew("Namespace Crew");
      const joinCode = newJoinCode();
      await store.put(crew, joinCode, undefined);

      const raw = await local.client.send(
        new QueryCommand({
          TableName: local.coreTable,
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :gsi1pk AND gsi1sk = :code",
          ExpressionAttributeValues: { ":gsi1pk": crewGsi1pk, ":code": joinCode },
        }),
      );
      expect(raw.Items).toHaveLength(1);
      expect(raw.Items?.[0]?.pk).toBe(crewPk(crew.id));
    });
  });

  describe("listByGolfer", () => {
    it("lists every crew a golfer belongs to, across crews, with name + memberCount", async () => {
      const store = newStore();
      const golfer = golferId(randomUUID());
      const shared = { golferId: golfer, name: "Dee", role: "member" as const };
      const crewA = makeCrew("Crew A", [member("Ann", "organizer"), shared]);
      const crewB = makeCrew("Crew B", [shared]);
      const crewC = makeCrew("Crew C", [member("Zed", "organizer")]); // golfer NOT a member
      await store.put(crewA, newJoinCode(), undefined);
      await store.put(crewB, newJoinCode(), undefined);
      await store.put(crewC, newJoinCode(), undefined);

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
      await store.put(crew, newJoinCode(), undefined);
      expect(await store.listByGolfer(golfer)).toEqual([{ crewId: crew.id, name: "Departure Crew", memberCount: 2 }]);

      await store.put({ ...crew, members: [stayer] }, newJoinCode(), 1);

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
        await store.put(crew, newJoinCode(), undefined);
        const season = newSeason("2026");

        await store.putSeason(crew.id, season);

        expect(await store.getSeason(crew.id, season.seasonId)).toEqual(season);
      });

      it("getSeason on an unknown seasonId returns undefined", async () => {
        const store = newStore();
        const crew = makeCrew("Absent Season Crew");
        await store.put(crew, newJoinCode(), undefined);

        expect(await store.getSeason(crew.id, randomUUID())).toBeUndefined();
      });

      it("putSeason is an unconditional upsert — a repeat put with the SAME seasonId renames/closes it in place", async () => {
        const store = newStore();
        const crew = makeCrew("Renaming Crew");
        await store.put(crew, newJoinCode(), undefined);
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
        await store.put(crew, newJoinCode(), undefined);
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
        await store.put(crew, newJoinCode(), undefined);

        expect(await store.listSeasons(crew.id)).toEqual([]);
      });
    });

    describe("addCountedRound / listCountedRounds", () => {
      it("addCountedRound + listCountedRounds round-trip", async () => {
        const store = newStore();
        const crew = makeCrew("Counting Crew");
        await store.put(crew, newJoinCode(), undefined);
        const season = newSeason("2026");
        await store.putSeason(crew.id, season);
        const entry = newCountedRound();

        await store.addCountedRound(crew.id, season.seasonId, entry);

        expect(await store.listCountedRounds(crew.id, season.seasonId)).toEqual([entry]);
      });

      it("a duplicate addCountedRound for the SAME roundId in the SAME season throws round-already-counted", async () => {
        const store = newStore();
        const crew = makeCrew("Duplicate Crew");
        await store.put(crew, newJoinCode(), undefined);
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
        await store.put(crew, newJoinCode(), undefined);
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
        await store.put(crew, newJoinCode(), undefined);
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
        await store.put(crew, newJoinCode(), undefined);
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
        await store.put(crew, newJoinCode(), undefined);
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
        await store.put(crewA, newJoinCode(), undefined);
        await store.put(crewB, newJoinCode(), undefined);
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
        await store.put(crew, newJoinCode(), undefined);
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
        await store.put(crew, newJoinCode(), undefined);
        const badSeason: CrewSeason = { seasonId: "X#ROUND#Y", name: "Bad Season", status: "open", createdAtMs: Date.now() };

        await expect(store.putSeason(crew.id, badSeason)).rejects.toThrow(/seasonId contains "#"/);

        // Verify nothing was written: getSeason returns undefined and listSeasons is empty.
        expect(await store.getSeason(crew.id, badSeason.seasonId)).toBeUndefined();
        expect(await store.listSeasons(crew.id)).toEqual([]);
      });

      it("addCountedRound rejects seasonId containing '#' with a plain Error and writes nothing", async () => {
        const store = newStore();
        const crew = makeCrew("Guard Crew 2");
        await store.put(crew, newJoinCode(), undefined);
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
