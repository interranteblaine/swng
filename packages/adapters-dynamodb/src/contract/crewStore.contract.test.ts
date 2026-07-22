import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Crew, CrewMember } from "@swng/domain";
import { addMember, crewId, golferId, roundId } from "@swng/domain";
import type { CrewSeason } from "@swng/application";
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

  // Seasons (realignment task-8-brief.md; chosen-dates model per spec 2026-07-22 "the season is
  // the record" §1): proves createDynamoCrewStore against the SAME spec createInMemoryCrewStore
  // (application/testing/fakes.ts) satisfies — upsert-by-seasonId, listSeasons' client-side
  // exclusion of orphaned legacy counted-round entries (the deleted counting apparatus' own item
  // shape, tolerated forever — crew-scoreboard spec §2b, the standingGame precedent). The
  // counting apparatus itself (addCountedRound/removeCountedRound/listCountedRounds, and the
  // countsRound tests that exercised them) is deleted whole with it.
  describe("seasons", () => {
    const newSeason = (name: string, startsAt = "2026-01-01", endsAt = "2026-12-31"): CrewSeason => ({
      seasonId: randomUUID(),
      name,
      createdAtMs: Date.now(),
      startsAt,
      endsAt,
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

      it("putSeason is an unconditional upsert — a repeat put with the SAME seasonId renames/re-dates it in place (editing IS the whole lifecycle now)", async () => {
        const store = newStore();
        const crew = makeCrew("Renaming Crew");
        await store.put(crew, undefined);
        const season = newSeason("2026 Season");
        await store.putSeason(crew.id, season);

        const edited: CrewSeason = { ...season, name: "2026 Season (final)", endsAt: "2026-06-30" };
        await store.putSeason(crew.id, edited);

        expect(await store.getSeason(crew.id, season.seasonId)).toEqual(edited);
        expect(await store.listSeasons(crew.id)).toEqual([edited]);
      });

      // Orphan tolerance (crew-scoreboard spec §2b, the standingGame precedent): the deleted
      // counting apparatus used to write items shaped "SEASON#<seasonId>#ROUND#<roundId>" —
      // seeded here with a raw PutCommand (never through the store API, which can no longer
      // even construct that sk) mirroring the legacy-date-strings test's own raw-insert idiom
      // below. Old beta data written before this arc looks exactly like this; listSeasons must
      // never resurface it as a "season," forever, with no migration.
      it("listSeasons EXCLUDES an orphaned legacy SEASON#<id>#ROUND#<id> item — the deleted counting apparatus' own shape", async () => {
        const store = newStore();
        const crew = makeCrew("Multi-Season Crew");
        await store.put(crew, undefined);
        const seasonA = newSeason("2025");
        const seasonB = newSeason("2026");
        await store.putSeason(crew.id, seasonA);
        await store.putSeason(crew.id, seasonB);

        await local.client.send(
          new PutCommand({
            TableName: local.coreTable,
            Item: {
              pk: crewPk(crew.id),
              sk: `${seasonSk(seasonA.seasonId)}#ROUND#${roundId(randomUUID())}`,
              entry: { roundId: roundId(randomUUID()), finalizedAtMs: Date.now(), appendedBy: golferId(randomUUID()), appendedAtMs: Date.now() },
            },
          }),
        );

        const found = await store.listSeasons(crew.id);

        expect(new Set(found.map((s) => s.seasonId))).toEqual(new Set([seasonA.seasonId, seasonB.seasonId]));
        expect(found).toHaveLength(2); // the orphaned item under seasonA is NOT a season
      });

      it("listSeasons returns [] for a crew with no seasons", async () => {
        const store = newStore();
        const crew = makeCrew("Seasonless Crew");
        await store.put(crew, undefined);

        expect(await store.listSeasons(crew.id)).toEqual([]);
      });
    });

    // Window bounds (spec 2026-07-22 §1): startsAt/endsAt are BOTH required and always carried
    // — no more open/closed distinction, no `status`, no `closedAtMs`. The legacy fold is a real
    // invariant beta storage depends on, so it's proven here against DynamoDB Local, not just
    // the in-memory fake.
    describe("season window bounds (spec 2026-07-22 §1)", () => {
      it("a season round-trips both startsAt and endsAt; a subsequent putSeason drops any legacy attrs", async () => {
        const store = newStore();
        const crew = makeCrew("Window Crew");
        await store.put(crew, undefined);
        const season = newSeason("2026");

        await store.putSeason(crew.id, season);

        const found = await store.getSeason(crew.id, season.seasonId);
        expect(found).toEqual(season);
        expect(found).not.toHaveProperty("status");
        expect(found).not.toHaveProperty("closedAtMs");
        expect(found).not.toHaveProperty("startsAtMs");
        expect(await store.listSeasons(crew.id)).toEqual([season]);
      });

      // Legacy fold: a raw legacy item (startsAtMs + closedAtMs + status, no date strings —
      // exactly the shape beta rows carried before this arc) reads back as its UTC start date
      // plus a Dec-31-of-that-year end, with `status`/`closedAtMs` ABSENT from the view — never
      // a migration.
      it("a raw legacy item (startsAtMs + closedAtMs + status, no date strings) reads as its UTC start date + Dec-31 end, with status/closedAtMs absent", async () => {
        const store = newStore();
        const crew = makeCrew("Legacy Season Crew");
        await store.put(crew, undefined);
        const seasonId = randomUUID();
        const startsAtMs = Date.UTC(2020, 5, 15); // June 15, 2020 (fixed, no wall-clock reads)
        const createdAtMs = startsAtMs;

        await local.client.send(
          new PutCommand({
            TableName: local.coreTable,
            Item: { pk: crewPk(crew.id), sk: seasonSk(seasonId), season: { seasonId, name: "2020", status: "open", createdAtMs, startsAtMs, closedAtMs: Date.UTC(2020, 10, 1) } },
          }),
        );

        const found = await store.getSeason(crew.id, seasonId);
        expect(found).toEqual({ seasonId, name: "2020", createdAtMs, startsAt: "2020-06-15", endsAt: "2020-12-31" });
        expect(found).not.toHaveProperty("status");
        expect(found).not.toHaveProperty("closedAtMs");

        const listed = await store.listSeasons(crew.id);
        expect(listed).toEqual([{ seasonId, name: "2020", createdAtMs, startsAt: "2020-06-15", endsAt: "2020-12-31" }]);
      });

      // The `?? createdAtMs` fallback (load-bearing per the plan): a pre-scoreboard row with
      // NEITHER startsAtMs NOR date strings — only createdAtMs — must still parse, falling all
      // the way back to createdAtMs for both the start date and the synthesized end year.
      it("a legacy item with NO startsAtMs at all falls back to createdAtMs for both dates", async () => {
        const store = newStore();
        const crew = makeCrew("Pre-Scoreboard Season Crew");
        await store.put(crew, undefined);
        const seasonId = randomUUID();
        const createdAtMs = Date.UTC(2019, 2, 3); // March 3, 2019

        await local.client.send(
          new PutCommand({
            TableName: local.coreTable,
            Item: { pk: crewPk(crew.id), sk: seasonSk(seasonId), season: { seasonId, name: "2019", status: "open", createdAtMs } },
          }),
        );

        const found = await store.getSeason(crew.id, seasonId);
        expect(found).toEqual({ seasonId, name: "2019", createdAtMs, startsAt: "2019-03-03", endsAt: "2019-12-31" });
      });

      // Whole-item-put proof (the port doc's own contract): an updateSeason/putSeason over a
      // legacy item is a WHOLE-item write, so the old startsAtMs/closedAtMs/status attributes
      // are gone from storage afterward — checked with a raw GetCommand, not the store's own
      // getSeason (which would tolerate either shape).
      it("an updateSeason-shaped putSeason over a legacy item drops the old attributes from storage", async () => {
        const store = newStore();
        const crew = makeCrew("Migrating Season Crew");
        await store.put(crew, undefined);
        const seasonId = randomUUID();
        const createdAtMs = Date.UTC(2021, 0, 1);

        await local.client.send(
          new PutCommand({
            TableName: local.coreTable,
            Item: { pk: crewPk(crew.id), sk: seasonSk(seasonId), season: { seasonId, name: "2021", status: "closed", createdAtMs, startsAtMs: createdAtMs, closedAtMs: Date.UTC(2021, 9, 1) } },
          }),
        );
        const rawBefore = await local.client.send(new GetCommand({ TableName: local.coreTable, Key: { pk: crewPk(crew.id), sk: seasonSk(seasonId) } }));
        expect(rawBefore.Item?.season).toHaveProperty("status");

        const read = await store.getSeason(crew.id, seasonId);
        await store.putSeason(crew.id, { ...read!, endsAt: "2021-11-30" });

        const raw = await local.client.send(new GetCommand({ TableName: local.coreTable, Key: { pk: crewPk(crew.id), sk: seasonSk(seasonId) } }));
        expect(raw.Item?.season).not.toHaveProperty("status");
        expect(raw.Item?.season).not.toHaveProperty("closedAtMs");
        expect(raw.Item?.season).not.toHaveProperty("startsAtMs");
        expect(await store.getSeason(crew.id, seasonId)).toEqual({ seasonId, name: "2021", createdAtMs, startsAt: "2021-01-01", endsAt: "2021-11-30" });
      });
    });

    describe("seasonId guard — # character forbidden", () => {
      it("putSeason rejects seasonId containing '#' with a plain Error and writes nothing", async () => {
        const store = newStore();
        const crew = makeCrew("Guard Crew");
        await store.put(crew, undefined);
        const badSeason: CrewSeason = { seasonId: "X#ROUND#Y", name: "Bad Season", createdAtMs: Date.now(), startsAt: "2026-01-01", endsAt: "2026-12-31" };

        await expect(store.putSeason(crew.id, badSeason)).rejects.toThrow(/seasonId contains "#"/);

        // Verify nothing was written: getSeason returns undefined and listSeasons is empty.
        expect(await store.getSeason(crew.id, badSeason.seasonId)).toBeUndefined();
        expect(await store.listSeasons(crew.id)).toEqual([]);
      });
    });
  });
});
