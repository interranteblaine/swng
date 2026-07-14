import { describe, expect, it } from "vitest";
import { addMember, crewId, golferId } from "@swng/domain";
import type { Crew, GolferId } from "@swng/domain";
import { ApplicationError } from "../errors.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import { createInMemoryCrewStore, createInMemoryGolferStore, createSequentialIds, putAndBindGolfer } from "../testing/fakes.js";
import { addCrewMember } from "./addCrewMember.js";
import { createCrew } from "./createCrew.js";
import { getCrew } from "./getCrew.js";
import { joinCrewByCode } from "./joinCrewByCode.js";
import { listMyCrews } from "./listMyCrews.js";

const setup = (crewStore: CrewStore = createInMemoryCrewStore(), golferStore: GolferStore = createInMemoryGolferStore()) => {
  const ids = createSequentialIds("c");
  return {
    crewStore,
    golferStore,
    ids,
    create: createCrew({ crewStore, golferStore, ids }),
    get: getCrew({ crewStore, golferStore }),
    list: listMyCrews({ crewStore, golferStore }),
    addMember: addCrewMember({ crewStore, golferStore }),
    join: joinCrewByCode({ crewStore, golferStore }),
  };
};

// Seeds an account golfer directly on the store (the same put-then-bindSub shape ensureGolfer
// uses) — the crew use cases resolve "who is calling" via golferStore.getBySub, so every test
// needs a real bound row before it can act as a crew member.
const seedAccountGolfer = async (golferStore: GolferStore, sub: string, name: string): Promise<GolferId> => {
  const id = golferId(`golfer-${sub}`);
  await putAndBindGolfer(golferStore, id, sub, name);
  return id;
};

describe("createCrew", () => {
  it("seats the caller's own account golfer as organizer and mints a joinCode via the round join-code machinery", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");

    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });

    expect(created.crew.name).toBe("Sunday Skins");
    expect(created.crew.joinCode).toHaveLength(6);
    expect(created.crew.members).toEqual([{ golferId: golferId("golfer-sub-ann"), name: "Ann", role: "organizer", claimed: true }]);
  });

  it("a caller with no account golfer yet is rejected — golfer-required (wire honesty, not a flow)", async () => {
    const ctx = setup();
    await expect(ctx.create({ sub: "sub-nobody" }, { name: "Sunday Skins" })).rejects.toMatchObject({ code: "golfer-required" });
  });

  // Papercut 9 (M9 hardening): domain's validateCrewName (crew/crew.ts) — the wire's own
  // `.min(1)` doesn't trim, so a whitespace-only name would otherwise mint a blank-looking
  // crew. Checked before anything is minted/written: no join code drawn, no crew put.
  it("a whitespace-only name is rejected — invalid-crew-name, nothing minted", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");

    await expect(ctx.create({ sub: "sub-ann" }, { name: "   " })).rejects.toMatchObject({ code: "invalid-crew-name" });
    await expect(ctx.list({ sub: "sub-ann" })).resolves.toEqual({ crews: [] });
  });
});

// M9 hardening: the join-code mint loop (crews/createCrew.ts) skips codes an existing crew
// already holds instead of minting once and living with a permanent collision.
describe("createCrew — join-code collisions (M9 hardening)", () => {
  it("skips codes already in use, minting the first free one within the attempt budget", async () => {
    const crewStore = createInMemoryCrewStore();
    const golferStore = createInMemoryGolferStore();
    await seedAccountGolfer(golferStore, "sub-ann", "Ann");

    // Predict the first 5 codes createSequentialIds("c") would mint (a SEPARATE instance with
    // the SAME prefix — joinCodeFromCounter is a pure function of (prefix, counter), so it
    // reproduces the identical sequence a fresh "c"-prefixed generator will produce below),
    // and pre-seed the crew store with filler crews AT the first 4 of them — forcing the mint
    // loop to skip all 4 before landing on the 5th, uncollided one.
    const predictor = createSequentialIds("c");
    const predictedCodes = Array.from({ length: 5 }, () => predictor.newJoinCode());
    for (const [index, code] of predictedCodes.slice(0, 4).entries()) {
      const filler: Crew = { id: crewId(`filler-${index}`), name: `Filler ${index}`, members: [] };
      await crewStore.put(filler, code, undefined);
    }

    const ids = createSequentialIds("c"); // fresh instance, same prefix -> identical sequence
    const create = createCrew({ crewStore, golferStore, ids });

    const created = await create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    expect(created.crew.joinCode).toBe(predictedCodes[4]);
  });

  it("exhausting every attempt (5 collisions running) throws join-code-exhausted", async () => {
    const crewStore = createInMemoryCrewStore();
    const golferStore = createInMemoryGolferStore();
    await seedAccountGolfer(golferStore, "sub-ann", "Ann");

    const predictor = createSequentialIds("c");
    for (let index = 0; index < 5; index += 1) {
      const filler: Crew = { id: crewId(`filler-${index}`), name: `Filler ${index}`, members: [] };
      await crewStore.put(filler, predictor.newJoinCode(), undefined);
    }

    const ids = createSequentialIds("c");
    const create = createCrew({ crewStore, golferStore, ids });

    await expect(create({ sub: "sub-ann" }, { name: "Sunday Skins" })).rejects.toMatchObject({ code: "join-code-exhausted" });
  });
});

describe("getCrew", () => {
  it("member-only: the organizer can read their own crew", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });

    const fetched = await ctx.get({ sub: "sub-ann" }, created.crew.crewId);
    expect(fetched).toEqual(created);
  });

  it("a non-member is rejected — not-a-member", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    await seedAccountGolfer(ctx.golferStore, "sub-stranger", "Stranger");

    await expect(ctx.get({ sub: "sub-stranger" }, created.crew.crewId)).rejects.toMatchObject({ code: "not-a-member" });
  });

  it("a sub with NO account golfer at all is rejected — not-a-member, not golfer-required (a read, not a write)", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });

    await expect(ctx.get({ sub: "sub-nobody" }, created.crew.crewId)).rejects.toMatchObject({ code: "not-a-member" });
  });

  it("an unknown crewId is rejected — unknown-crew", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    await expect(ctx.get({ sub: "sub-ann" }, crewId("nope"))).rejects.toMatchObject({ code: "unknown-crew" });
  });
});

describe("listMyCrews", () => {
  it("returns an empty list for a sub with no account golfer — no error", async () => {
    const ctx = setup();
    await expect(ctx.list({ sub: "sub-nobody" })).resolves.toEqual({ crews: [] });
  });

  it("lists every crew the caller's golfer belongs to, with member counts", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const calId = await seedAccountGolfer(ctx.golferStore, "sub-cal", "Cal");
    const crewA = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    const crewB = await ctx.create({ sub: "sub-ann" }, { name: "Wednesday Nine" });
    await ctx.addMember({ sub: "sub-ann" }, crewA.crew.crewId, { golferId: calId });

    const listed = await ctx.list({ sub: "sub-ann" });
    expect([...listed.crews].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { crewId: crewA.crew.crewId, name: "Sunday Skins", memberCount: 2 },
      { crewId: crewB.crew.crewId, name: "Wednesday Nine", memberCount: 1 },
    ]);
  });
});

// De-ghost (architecture-realignment Task 9, spec §4 "membership: real accounts only"):
// addCrewMember adds an EXISTING account golfer by golferId and requires a bound sub — the M8
// ghost-minting-from-a-name path is gone.
describe("addCrewMember", () => {
  it("adds an existing account golfer (bound sub) to the roster by golferId", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const calId = await seedAccountGolfer(ctx.golferStore, "sub-cal", "Cal"); // a real account, not yet a member
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });

    const added = await ctx.addMember({ sub: "sub-ann" }, created.crew.crewId, { golferId: calId });

    // Name comes from the golfer's OWN record (never the wire), claimed:true since it has a sub.
    expect(added.crew.members.find((member) => member.golferId === calId)).toEqual({ golferId: calId, name: "Cal", role: "member", claimed: true });
  });

  it("a target golfer without a bound sub (a sub-less golfer) is rejected — ghost-not-addable, nothing added", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    // A golfer row with NO sub — a sub-less golfer (e.g. minted inside a round).
    const ghostId = golferId("ghost-cal");
    await ctx.golferStore.put({ id: ghostId, name: "Cal", handicap: {} }, undefined);

    await expect(ctx.addMember({ sub: "sub-ann" }, created.crew.crewId, { golferId: ghostId })).rejects.toMatchObject({ code: "ghost-not-addable" });
    const fetched = await ctx.get({ sub: "sub-ann" }, created.crew.crewId);
    expect(fetched.crew.members.some((member) => member.golferId === ghostId)).toBe(false);
  });

  it("a target golferId with no golfer row at all is rejected — ghost-not-addable", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });

    await expect(ctx.addMember({ sub: "sub-ann" }, created.crew.crewId, { golferId: golferId("nobody") })).rejects.toMatchObject({ code: "ghost-not-addable" });
  });

  it("a non-member caller is rejected — not-a-member (checked before the target)", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const calId = await seedAccountGolfer(ctx.golferStore, "sub-cal", "Cal");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    await seedAccountGolfer(ctx.golferStore, "sub-stranger", "Stranger");

    await expect(ctx.addMember({ sub: "sub-stranger" }, created.crew.crewId, { golferId: calId })).rejects.toMatchObject({ code: "not-a-member" });
  });
});

describe("joinCrewByCode", () => {
  it("adds the caller's own account golfer as a member (role member)", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    const boId = await seedAccountGolfer(ctx.golferStore, "sub-bo", "Bo");

    const joined = await ctx.join({ sub: "sub-bo" }, { code: created.crew.joinCode });

    expect(joined.crew.members).toEqual(expect.arrayContaining([{ golferId: boId, name: "Bo", role: "member", claimed: true }]));
  });

  it("re-joining with an already-a-member caller is idempotent — same crew returned, no duplicate roster entry", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    await seedAccountGolfer(ctx.golferStore, "sub-bo", "Bo");

    const first = await ctx.join({ sub: "sub-bo" }, { code: created.crew.joinCode });
    const second = await ctx.join({ sub: "sub-bo" }, { code: created.crew.joinCode });

    expect(second).toEqual(first);
    expect(second.crew.members).toHaveLength(2); // Ann + Bo, not Ann + Bo + Bo
  });

  it("a bad code is rejected — unknown-crew", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-bo", "Bo");
    await expect(ctx.join({ sub: "sub-bo" }, { code: "ZZZZZZ" })).rejects.toMatchObject({ code: "unknown-crew" });
  });

  it("a caller with no account golfer yet is rejected — golfer-required", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });

    await expect(ctx.join({ sub: "sub-nobody" }, { code: created.crew.joinCode })).rejects.toMatchObject({ code: "golfer-required" });
  });
});

// getCrewRecords (the M8 GET /crews/{crewId}/records use case) is GONE (architecture-realignment
// Task 9): the crew projection layer it read from is deleted. Season standings are computed on
// read now — see seasonSlice.test.ts (createSeason/listSeasons/appendCountedRound/
// removeCountedRound/getSeasonStandings/leaveCrew).

// A CrewStore decorator that fails its first `failCount` `put` calls with a synthetic
// "crew-conflict" before delegating to `inner` — mirrors courseSlice.test.ts's own
// createFlakyCourseStore harness exactly, kept local to this file for the same reason
// (single-test failure injection, not a reusable product-surface fake).
interface FlakyCrewStore extends CrewStore {
  readonly putAttempts: () => number;
}
const createFlakyCrewStore = (inner: CrewStore, failCount: number): FlakyCrewStore => {
  let putAttempts = 0;
  return {
    putAttempts: () => putAttempts,
    get: inner.get,
    findByJoinCode: inner.findByJoinCode,
    listByGolfer: inner.listByGolfer,
    putSeason: inner.putSeason,
    getSeason: inner.getSeason,
    listSeasons: inner.listSeasons,
    addCountedRound: inner.addCountedRound,
    removeCountedRound: inner.removeCountedRound,
    listCountedRounds: inner.listCountedRounds,
    countsRound: inner.countsRound,
    put: async (crew, joinCode, expectedRevision) => {
      putAttempts += 1;
      if (putAttempts <= failCount) throw new ApplicationError("crew-conflict", `synthetic conflict #${putAttempts}`);
      return inner.put(crew, joinCode, expectedRevision);
    },
  };
};

// The generic retry loop itself (bounded attempts, conflict-vs-non-conflict discrimination)
// is pinned once at its shared home, retryOnConflict.test.ts — these two mirror
// courseSlice.test.ts's own addTee flaky-store pair exactly, but through addCrewMember, to
// confirm the CREW-SPECIFIC wiring (crewStore's get/put shape, the joinCode capture,
// unknown-crew/crew-conflict codes) is actually correct, not just the abstract algorithm.
describe("addCrewMember conflict retry", () => {
  it("retries once on a synthetic crew-conflict from the store, then succeeds", async () => {
    const inner = createInMemoryCrewStore();
    const golferStore = createInMemoryGolferStore();
    await seedAccountGolfer(golferStore, "sub-ann", "Ann");
    const calId = await seedAccountGolfer(golferStore, "sub-cal", "Cal");
    const created = await createCrew({ crewStore: inner, golferStore, ids: createSequentialIds("c") })({ sub: "sub-ann" }, { name: "Sunday Skins" });

    const flaky = createFlakyCrewStore(inner, 1);
    const flakyCtx = setup(flaky, golferStore);
    const added = await flakyCtx.addMember({ sub: "sub-ann" }, created.crew.crewId, { golferId: calId });

    expect(added.crew.members.map((m) => m.name)).toEqual(expect.arrayContaining(["Ann", "Cal"]));
    // More than one put attempt is the proof the retry path actually ran, not that the first
    // attempt just happened to succeed.
    expect(flaky.putAttempts()).toBeGreaterThan(1);
  });

  it("gives up after bounded attempts and rethrows crew-conflict when the store never stops conflicting", async () => {
    const inner = createInMemoryCrewStore();
    const golferStore = createInMemoryGolferStore();
    await seedAccountGolfer(golferStore, "sub-ann", "Ann");
    const calId = await seedAccountGolfer(golferStore, "sub-cal", "Cal");
    const created = await createCrew({ crewStore: inner, golferStore, ids: createSequentialIds("c") })({ sub: "sub-ann" }, { name: "Sunday Skins" });

    const flaky = createFlakyCrewStore(inner, Number.POSITIVE_INFINITY);
    const flakyCtx = setup(flaky, golferStore);

    await expect(flakyCtx.addMember({ sub: "sub-ann" }, created.crew.crewId, { golferId: calId })).rejects.toMatchObject({ code: "crew-conflict" });
    expect(flaky.putAttempts()).toBeGreaterThan(1);
  });
});

// Exercises the domain crew type directly, pinning that addMember/Crew stay importable and
// usable from this layer the way the use cases above rely on (a compile-time-ish smoke test,
// cheap insurance against an accidental import-path drift).
describe("Crew (smoke)", () => {
  it("addMember builds a roster incrementally", () => {
    const empty: Crew = { id: crewId("c1"), name: "Empty", members: [] };
    const withAnn = addMember(empty, { golferId: golferId("ann"), name: "Ann", role: "organizer" });
    expect(withAnn.members).toHaveLength(1);
  });
});
