import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Crew, CrewMember } from "@swng/domain";
import { addMember, crewId, golferId } from "@swng/domain";
import { createDynamoCrewStore } from "../createDynamoCrewStore.js";
import { crewGsi1pk, crewPk, memberSk } from "../keys.js";
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

    it("standingGame round-trips through put/get untouched", async () => {
      const store = newStore();
      const p1 = member("Ann");
      const p2 = member("Bo");
      const base = makeCrew("Standing Game Crew", [p1, p2]);
      const crew: Crew = { ...base, standingGame: { tee: "white", games: [{ kind: "skins", players: [p1.golferId, p2.golferId] }] } };

      await store.put(crew, newJoinCode(), undefined);

      expect((await store.get(crew.id))?.crew).toEqual(crew);
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
});
