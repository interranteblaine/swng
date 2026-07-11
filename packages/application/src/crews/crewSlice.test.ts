import { describe, expect, it } from "vitest";
import { addMember, crewId, golferId } from "@swng/domain";
import type { Crew, GolferId } from "@swng/domain";
import { ApplicationError } from "../errors.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import { createInMemoryCrewStore, createInMemoryGolferStore, createSequentialIds } from "../testing/fakes.js";
import { addCrewMember } from "./addCrewMember.js";
import { createCrew } from "./createCrew.js";
import { getCrew } from "./getCrew.js";
import { joinCrewByCode } from "./joinCrewByCode.js";
import { listMyCrews } from "./listMyCrews.js";
import { retryOnConflict } from "./retryOnConflict.js";
import { saveStandingGame } from "./saveStandingGame.js";

const setup = (crewStore: CrewStore = createInMemoryCrewStore(), golferStore: GolferStore = createInMemoryGolferStore()) => {
  const ids = createSequentialIds("c");
  return {
    crewStore,
    golferStore,
    ids,
    create: createCrew({ crewStore, golferStore, ids }),
    get: getCrew({ crewStore, golferStore }),
    list: listMyCrews({ crewStore, golferStore }),
    addMember: addCrewMember({ crewStore, golferStore, ids }),
    join: joinCrewByCode({ crewStore, golferStore }),
    saveStanding: saveStandingGame({ crewStore, golferStore }),
  };
};

// Seeds an account golfer directly on the store (mirrors getOrCreateGolfer's own shape) —
// the crew use cases resolve "who is calling" via golferStore.getBySub, so every test needs
// a real bound row before it can act as a crew member.
const seedAccountGolfer = async (golferStore: GolferStore, sub: string, name: string): Promise<GolferId> => {
  const id = golferId(`golfer-${sub}`);
  await golferStore.put({ id, name, handicap: {} }, undefined);
  // put() alone doesn't bind a sub (mirrors the port's own create-vs-claim split) — claim
  // does, and this is a fresh row so it always succeeds unconditionally.
  await golferStore.claim(id, sub, name);
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
    const crewA = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    const crewB = await ctx.create({ sub: "sub-ann" }, { name: "Wednesday Nine" });
    await ctx.addMember({ sub: "sub-ann" }, crewA.crew.crewId, { name: "Cal" });

    const listed = await ctx.list({ sub: "sub-ann" });
    expect([...listed.crews].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { crewId: crewA.crew.crewId, name: "Sunday Skins", memberCount: 2 },
      { crewId: crewB.crew.crewId, name: "Wednesday Nine", memberCount: 1 },
    ]);
  });
});

describe("addCrewMember", () => {
  it("mints a stable, unclaimed ghost golfer and seats it as a member", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });

    const added = await ctx.addMember({ sub: "sub-ann" }, created.crew.crewId, { name: "Cal" });

    const calMember = added.crew.members.find((member) => member.name === "Cal");
    expect(calMember).toMatchObject({ name: "Cal", role: "member", claimed: false });

    const stored = await ctx.golferStore.get(calMember!.golferId);
    expect(stored?.sub).toBeUndefined(); // unclaimed
    expect(stored?.golfer.name).toBe("Cal");
  });

  it("a non-member caller is rejected — not-a-member", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    await seedAccountGolfer(ctx.golferStore, "sub-stranger", "Stranger");

    await expect(ctx.addMember({ sub: "sub-stranger" }, created.crew.crewId, { name: "Cal" })).rejects.toMatchObject({ code: "not-a-member" });
  });

  it("the SAME ghost golferId recurs across two separate addCrewMember calls' resulting roster reads (stability check)", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });

    const added = await ctx.addMember({ sub: "sub-ann" }, created.crew.crewId, { name: "Cal" });
    const calId = added.crew.members.find((member) => member.name === "Cal")!.golferId;

    const fetched = await ctx.get({ sub: "sub-ann" }, created.crew.crewId);
    expect(fetched.crew.members.find((member) => member.name === "Cal")?.golferId).toBe(calId);
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

describe("saveStandingGame", () => {
  it("member-only: sets the preset wholesale and it round-trips through getCrew", async () => {
    const ctx = setup();
    const annId = await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const boId = await seedAccountGolfer(ctx.golferStore, "sub-bo", "Bo");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    await ctx.join({ sub: "sub-bo" }, { code: created.crew.joinCode });

    const standingGame = { tee: "white", games: [{ kind: "stableford" as const, players: [annId, boId] }] };
    const saved = await ctx.saveStanding({ sub: "sub-ann" }, created.crew.crewId, { standingGame });

    expect(saved.crew.standingGame).toEqual(standingGame);
    const fetched = await ctx.get({ sub: "sub-bo" }, created.crew.crewId);
    expect(fetched.crew.standingGame).toEqual(standingGame);
  });

  it("a non-member is rejected — not-a-member", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    await seedAccountGolfer(ctx.golferStore, "sub-stranger", "Stranger");

    await expect(ctx.saveStanding({ sub: "sub-stranger" }, created.crew.crewId, { standingGame: { games: [] } })).rejects.toMatchObject({
      code: "not-a-member",
    });
  });
});

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
    put: async (crew, joinCode, expectedRevision) => {
      putAttempts += 1;
      if (putAttempts <= failCount) throw new ApplicationError("crew-conflict", `synthetic conflict #${putAttempts}`);
      return inner.put(crew, joinCode, expectedRevision);
    },
  };
};

describe("crews/retryOnConflict", () => {
  it("retries once on a synthetic crew-conflict from the store, then succeeds", async () => {
    const inner = createInMemoryCrewStore();
    const golferStore = createInMemoryGolferStore();
    const annId = await seedAccountGolfer(golferStore, "sub-ann", "Ann");
    const created = await createCrew({ crewStore: inner, golferStore, ids: createSequentialIds("c") })({ sub: "sub-ann" }, { name: "Sunday Skins" });

    const flaky = createFlakyCrewStore(inner, 1);
    const result = await retryOnConflict(flaky, created.crew.crewId, (crew) => addMember(crew, { golferId: golferId("cal"), name: "Cal", role: "member" }));

    expect(result.crew.members.map((m) => m.golferId)).toEqual(expect.arrayContaining([annId, golferId("cal")]));
    // More than one put attempt is the proof the retry path actually ran.
    expect(flaky.putAttempts()).toBeGreaterThan(1);
  });

  it("gives up after bounded attempts and rethrows crew-conflict when the store never stops conflicting", async () => {
    const inner = createInMemoryCrewStore();
    const golferStore = createInMemoryGolferStore();
    await seedAccountGolfer(golferStore, "sub-ann", "Ann");
    const created = await createCrew({ crewStore: inner, golferStore, ids: createSequentialIds("c") })({ sub: "sub-ann" }, { name: "Sunday Skins" });

    const flaky = createFlakyCrewStore(inner, Number.POSITIVE_INFINITY);
    await expect(
      retryOnConflict(flaky, created.crew.crewId, (crew) => addMember(crew, { golferId: golferId("cal"), name: "Cal", role: "member" })),
    ).rejects.toMatchObject({ code: "crew-conflict" });
    expect(flaky.putAttempts()).toBeGreaterThan(1);
  });

  // A DIFFERENT error than the one the retry loop discriminates on (crew-conflict) — a
  // DomainError from a `mutate` that names a golferId already on the roster (domain's
  // addMember, crew/crew.ts) — propagates UNCAUGHT on the very first attempt, never retried
  // and never mistaken for a conflict to recover from.
  it("propagates a DomainError from `mutate` (e.g. duplicate-member) uncaught, without retrying", async () => {
    const inner = createInMemoryCrewStore();
    const golferStore = createInMemoryGolferStore();
    const annId = await seedAccountGolfer(golferStore, "sub-ann", "Ann");
    const created = await createCrew({ crewStore: inner, golferStore, ids: createSequentialIds("c") })({ sub: "sub-ann" }, { name: "Sunday Skins" });

    let mutateCalls = 0;
    await expect(
      retryOnConflict(inner, created.crew.crewId, (crew) => {
        mutateCalls += 1;
        // Ann is already a member — addMember throws DomainError("duplicate-member") here,
        // not ApplicationError("crew-conflict"), so retryOnConflict must NOT swallow it.
        return addMember(crew, { golferId: annId, name: "Ann", role: "member" });
      }),
    ).rejects.toMatchObject({ code: "duplicate-member" });
    expect(mutateCalls).toBe(1);
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
