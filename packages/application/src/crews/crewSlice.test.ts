import { describe, expect, it } from "vitest";
import { addMember, crewId, golferId } from "@swng/domain";
import type { Crew, GolferId } from "@swng/domain";
import { ApplicationError } from "../errors.js";
import type { Clock } from "../ports/clock.js";
import type { CrewStore } from "../ports/crewStore.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { TokenIssuer } from "../ports/tokenIssuer.js";
import {
  createFixedClock,
  createFrozenClock,
  createInMemoryCrewStore,
  createInMemoryGolferStore,
  createSequentialIds,
  createTestTokenIssuer,
  putAndBindGolfer,
} from "../testing/fakes.js";
import { createCrew } from "./createCrew.js";
import { getCrew } from "./getCrew.js";
import { joinCrewByInvite } from "./joinCrewByInvite.js";
import { listMyCrews } from "./listMyCrews.js";
import { CREW_INVITE_TTL_MS, mintCrewInvite } from "./mintCrewInvite.js";
import { peekCrewInvite } from "./peekCrewInvite.js";
import { removeCrewMember } from "./removeCrewMember.js";
import { transferOrganizer } from "./transferOrganizer.js";

const setup = (
  crewStore: CrewStore = createInMemoryCrewStore(),
  golferStore: GolferStore = createInMemoryGolferStore(),
  tokenIssuer: TokenIssuer = createTestTokenIssuer(),
  clock: Clock = createFixedClock(1_000),
) => {
  const ids = createSequentialIds("c");
  return {
    crewStore,
    golferStore,
    tokenIssuer,
    clock,
    ids,
    create: createCrew({ crewStore, golferStore, ids, clock }),
    get: getCrew({ crewStore, golferStore }),
    list: listMyCrews({ crewStore, golferStore }),
    mint: mintCrewInvite({ crewStore, golferStore, tokenIssuer, clock }),
    peek: peekCrewInvite({ crewStore, tokenIssuer, clock }),
    join: joinCrewByInvite({ crewStore, golferStore, tokenIssuer, clock }),
    remove: removeCrewMember({ crewStore, golferStore }),
    transfer: transferOrganizer({ crewStore, golferStore }),
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
  it("seats the caller's own account golfer as organizer — no join code minted anymore (crew membership, invited in)", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");

    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });

    expect(created.crew.name).toBe("Sunday Skins");
    expect(created.crew).not.toHaveProperty("joinCode");
    expect(created.crew.members).toEqual([{ golferId: golferId("golfer-sub-ann"), name: "Ann", role: "organizer", claimed: true }]);
  });

  it("a caller with no account golfer yet is rejected — golfer-required (wire honesty, not a flow)", async () => {
    const ctx = setup();
    await expect(ctx.create({ sub: "sub-nobody" }, { name: "Sunday Skins" })).rejects.toMatchObject({ code: "golfer-required" });
  });

  // Papercut 9 (M9 hardening): domain's validateCrewName (crew/crew.ts) — the wire's own
  // `.min(1)` doesn't trim, so a whitespace-only name would otherwise mint a blank-looking
  // crew. Checked before anything is minted/written: no crew put.
  it("a whitespace-only name is rejected — invalid-crew-name, nothing minted", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");

    await expect(ctx.create({ sub: "sub-ann" }, { name: "   " })).rejects.toMatchObject({ code: "invalid-crew-name" });
    await expect(ctx.list({ sub: "sub-ann" })).resolves.toEqual({ crews: [] });
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
    await seedAccountGolfer(ctx.golferStore, "sub-cal", "Cal");
    const crewA = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    const crewB = await ctx.create({ sub: "sub-ann" }, { name: "Wednesday Nine" });
    const invite = await ctx.mint({ sub: "sub-ann" }, crewA.crew.crewId);
    await ctx.join({ sub: "sub-cal" }, { token: invite.token });

    const listed = await ctx.list({ sub: "sub-ann" });
    expect([...listed.crews].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { crewId: crewA.crew.crewId, name: "Sunday Skins", memberCount: 2 },
      { crewId: crewB.crew.crewId, name: "Wednesday Nine", memberCount: 1 },
    ]);
  });
});

// Crew membership (invited in, accountable out — spec §2): mintCrewInvite/peekCrewInvite/
// joinCrewByInvite replace addCrewMember/joinCrewByCode and the permanent join code they rode.
describe("mintCrewInvite", () => {
  it("any member (not just the organizer) mints a token stamped clock.now() + 7 days", async () => {
    const clock = createFrozenClock(1_000); // frozen, so the stamp is exactly predictable
    const ctx = setup(createInMemoryCrewStore(), createInMemoryGolferStore(), createTestTokenIssuer(), clock);
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    const boId = await seedAccountGolfer(ctx.golferStore, "sub-bo", "Bo");
    await ctx.join({ sub: "sub-bo" }, { token: (await ctx.mint({ sub: "sub-ann" }, created.crew.crewId)).token });
    expect(boId).toBeDefined();

    // Bo — an ordinary member, not the organizer — mints too (spec §1: "any member invites").
    const minted = await ctx.mint({ sub: "sub-bo" }, created.crew.crewId);

    expect(minted.expiresAtMs).toBe(1_000 + CREW_INVITE_TTL_MS);
    expect(typeof minted.token).toBe("string");
    expect(minted.token.length).toBeGreaterThan(0);
  });

  it("a non-member is rejected — not-a-member (requireCrewMember's own gate)", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    await seedAccountGolfer(ctx.golferStore, "sub-stranger", "Stranger");

    await expect(ctx.mint({ sub: "sub-stranger" }, created.crew.crewId)).rejects.toMatchObject({ code: "not-a-member" });
  });

  it("an unknown crewId is rejected — unknown-crew", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    await expect(ctx.mint({ sub: "sub-ann" }, crewId("nope"))).rejects.toMatchObject({ code: "unknown-crew" });
  });
});

describe("peekCrewInvite", () => {
  it("returns crewName + memberCount + inviterName for a live invite", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    const minted = await ctx.mint({ sub: "sub-ann" }, created.crew.crewId);

    const peeked = await ctx.peek({ token: minted.token });

    expect(peeked).toEqual({ crewName: "Sunday Skins", memberCount: 1, inviterName: "Ann" });
  });

  it("a tampered/unrecognized token is rejected — crew-invite-invalid", async () => {
    const ctx = setup();
    await expect(ctx.peek({ token: "not-a-real-token" })).rejects.toMatchObject({ code: "crew-invite-invalid" });
  });

  // Inviter-still-a-member is checked at BOTH peek and join (spec §2) — a removed member's
  // outstanding invites die with their membership, and peek never over-promises.
  it("crew-invite-invalid once the inviter has left the crew", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    await seedAccountGolfer(ctx.golferStore, "sub-bo", "Bo");
    await ctx.join({ sub: "sub-bo" }, { token: (await ctx.mint({ sub: "sub-ann" }, created.crew.crewId)).token });

    // Bo (now a member) mints his OWN invite, then leaves directly on the store (there is no
    // leaveCrew wiring in this file's ctx — crewSlice.test.ts owns createCrew/getCrew/
    // listMyCrews/mint/peek/join only; leaveCrew itself is pinned in seasonSlice.test.ts) — his
    // link should die with his membership.
    const bosInvite = await ctx.mint({ sub: "sub-bo" }, created.crew.crewId);
    const found = await ctx.crewStore.get(created.crew.crewId);
    await ctx.crewStore.put(
      { ...found!.crew, members: found!.crew.members.filter((m) => m.golferId !== golferId("golfer-sub-bo")) },
      found!.revision,
    );

    await expect(ctx.peek({ token: bosInvite.token })).rejects.toMatchObject({ code: "crew-invite-invalid" });
  });

  it("an expired invite is rejected — crew-invite-expired, distinct from crew-invite-invalid", async () => {
    const crewStore = createInMemoryCrewStore();
    const golferStore = createInMemoryGolferStore();
    const tokenIssuer = createTestTokenIssuer();
    await seedAccountGolfer(golferStore, "sub-ann", "Ann");
    const create = createCrew({ crewStore, golferStore, ids: createSequentialIds("c"), clock: createFixedClock(1_000) });
    const created = await create({ sub: "sub-ann" }, { name: "Sunday Skins" });

    // Minted against a clock frozen well BEFORE its own expiresAtMs...
    const mint = mintCrewInvite({ crewStore, golferStore, tokenIssuer, clock: createFrozenClock(1_000) });
    const minted = await mint({ sub: "sub-ann" }, created.crew.crewId);

    // ...peeked against a clock frozen AT-OR-PAST it (mirrors hmacTokenIssuer's own `<=` boundary).
    const peek = peekCrewInvite({ crewStore, tokenIssuer, clock: createFrozenClock(minted.expiresAtMs) });
    await expect(peek({ token: minted.token })).rejects.toMatchObject({ code: "crew-invite-expired" });
  });
});

describe("joinCrewByInvite", () => {
  it("adds the caller's own account golfer as a member (role member)", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    const boId = await seedAccountGolfer(ctx.golferStore, "sub-bo", "Bo");
    const minted = await ctx.mint({ sub: "sub-ann" }, created.crew.crewId);

    const joined = await ctx.join({ sub: "sub-bo" }, { token: minted.token });

    expect(joined.crew.members).toEqual(expect.arrayContaining([{ golferId: boId, name: "Bo", role: "member", claimed: true }]));
  });

  it("re-joining with an already-a-member caller is idempotent — same crew returned, no duplicate roster entry (no-op, spec §2)", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    await seedAccountGolfer(ctx.golferStore, "sub-bo", "Bo");
    const minted = await ctx.mint({ sub: "sub-ann" }, created.crew.crewId);

    const first = await ctx.join({ sub: "sub-bo" }, { token: minted.token });
    const second = await ctx.join({ sub: "sub-bo" }, { token: minted.token });

    expect(second).toEqual(first);
    expect(second.crew.members).toHaveLength(2); // Ann + Bo, not Ann + Bo + Bo
  });

  it("a tampered/unrecognized token is rejected — crew-invite-invalid", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-bo", "Bo");
    await expect(ctx.join({ sub: "sub-bo" }, { token: "not-a-real-token" })).rejects.toMatchObject({ code: "crew-invite-invalid" });
  });

  it("a caller with no account golfer yet is rejected — golfer-required", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    const minted = await ctx.mint({ sub: "sub-ann" }, created.crew.crewId);

    await expect(ctx.join({ sub: "sub-nobody" }, { token: minted.token })).rejects.toMatchObject({ code: "golfer-required" });
  });

  it("crew-invite-invalid once the inviter has left the crew — checked at join too, not just peek", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    await seedAccountGolfer(ctx.golferStore, "sub-bo", "Bo");
    await ctx.join({ sub: "sub-bo" }, { token: (await ctx.mint({ sub: "sub-ann" }, created.crew.crewId)).token });
    const bosInvite = await ctx.mint({ sub: "sub-bo" }, created.crew.crewId);

    const found = await ctx.crewStore.get(created.crew.crewId);
    await ctx.crewStore.put(
      { ...found!.crew, members: found!.crew.members.filter((m) => m.golferId !== golferId("golfer-sub-bo")) },
      found!.revision,
    );
    await seedAccountGolfer(ctx.golferStore, "sub-cy", "Cy");

    await expect(ctx.join({ sub: "sub-cy" }, { token: bosInvite.token })).rejects.toMatchObject({ code: "crew-invite-invalid" });
  });

  it("an expired invite is rejected — crew-invite-expired", async () => {
    const crewStore = createInMemoryCrewStore();
    const golferStore = createInMemoryGolferStore();
    const tokenIssuer = createTestTokenIssuer();
    await seedAccountGolfer(golferStore, "sub-ann", "Ann");
    const create = createCrew({ crewStore, golferStore, ids: createSequentialIds("c"), clock: createFixedClock(1_000) });
    const created = await create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    await seedAccountGolfer(golferStore, "sub-bo", "Bo");

    const mint = mintCrewInvite({ crewStore, golferStore, tokenIssuer, clock: createFrozenClock(1_000) });
    const minted = await mint({ sub: "sub-ann" }, created.crew.crewId);

    const join = joinCrewByInvite({ crewStore, golferStore, tokenIssuer, clock: createFrozenClock(minted.expiresAtMs) });
    await expect(join({ sub: "sub-bo" }, { token: minted.token })).rejects.toMatchObject({ code: "crew-invite-expired" });
  });
});

// Crew membership (invited in, accountable out — spec §1): the organizer's authority, half one
// (remove) — organizer-gated (requireCrewMember then a role check → ApplicationError
// "not-organizer"), then the domain roster op itself (crew.ts's removeMember: not-a-member for
// an absent target, organizer-immovable for the organizer). Semantically identical to leaveCrew
// (a pure roster op through the same revision-checked put) — no season/standings/projection code
// is exercised or touched by any test here.
describe("removeCrewMember", () => {
  it("the organizer removes an ordinary member — 200 path, updated crew returned", async () => {
    const ctx = setup();
    const annId = await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    const boId = await seedAccountGolfer(ctx.golferStore, "sub-bo", "Bo");
    await ctx.join({ sub: "sub-bo" }, { token: (await ctx.mint({ sub: "sub-ann" }, created.crew.crewId)).token });

    const result = await ctx.remove({ sub: "sub-ann" }, created.crew.crewId, boId);

    expect(result.crew.members).toEqual([{ golferId: annId, name: "Ann", role: "organizer", claimed: true }]);
    // Removal really landed in the store, not just the response shape.
    const stored = await ctx.crewStore.get(created.crew.crewId);
    expect(stored!.crew.members.map((m) => m.golferId)).toEqual([annId]);
  });

  it("an ordinary member attempting to remove someone is rejected — not-organizer", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    await seedAccountGolfer(ctx.golferStore, "sub-bo", "Bo");
    await ctx.join({ sub: "sub-bo" }, { token: (await ctx.mint({ sub: "sub-ann" }, created.crew.crewId)).token });
    const calId = await seedAccountGolfer(ctx.golferStore, "sub-cal", "Cal");
    await ctx.join({ sub: "sub-cal" }, { token: (await ctx.mint({ sub: "sub-ann" }, created.crew.crewId)).token });

    // Bo (an ordinary member) tries to remove Cal — rejected, even though Bo IS a crew member.
    await expect(ctx.remove({ sub: "sub-bo" }, created.crew.crewId, calId)).rejects.toMatchObject({ code: "not-organizer" });
  });

  it("a non-member caller is rejected — not-a-member (requireCrewMember's own gate, before the role check)", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    const boId = await seedAccountGolfer(ctx.golferStore, "sub-bo", "Bo");
    await ctx.join({ sub: "sub-bo" }, { token: (await ctx.mint({ sub: "sub-ann" }, created.crew.crewId)).token });
    await seedAccountGolfer(ctx.golferStore, "sub-stranger", "Stranger");

    await expect(ctx.remove({ sub: "sub-stranger" }, created.crew.crewId, boId)).rejects.toMatchObject({ code: "not-a-member" });
  });

  it("the organizer attempting to remove themselves is rejected — organizer-immovable (crew.ts's own invariant)", async () => {
    const ctx = setup();
    const annId = await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });

    await expect(ctx.remove({ sub: "sub-ann" }, created.crew.crewId, annId)).rejects.toMatchObject({ code: "organizer-immovable" });
  });

  it("removing an absent golferId is rejected — not-a-member (the domain roster op, not the caller-membership gate)", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });

    await expect(ctx.remove({ sub: "sub-ann" }, created.crew.crewId, golferId("never-joined"))).rejects.toMatchObject({ code: "not-a-member" });
  });
});

// Crew membership (invited in, accountable out — spec §1): the organizer's authority, half two
// (transfer) — same organizer gate as removeCrewMember, then crew.ts's own transferOrganizer (a
// role flip preserving exactly one organizer, order untouched).
describe("transferOrganizer", () => {
  it("the organizer transfers to a member — role flip, exactly one organizer, member order preserved", async () => {
    const ctx = setup();
    const annId = await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    const boId = await seedAccountGolfer(ctx.golferStore, "sub-bo", "Bo");
    await ctx.join({ sub: "sub-bo" }, { token: (await ctx.mint({ sub: "sub-ann" }, created.crew.crewId)).token });

    const result = await ctx.transfer({ sub: "sub-ann" }, created.crew.crewId, { golferId: boId });

    expect(result.crew.members.map((m) => m.golferId)).toEqual([annId, boId]); // order preserved
    expect(result.crew.members).toEqual([
      { golferId: annId, name: "Ann", role: "member", claimed: true },
      { golferId: boId, name: "Bo", role: "organizer", claimed: true },
    ]);
    expect(result.crew.members.filter((m) => m.role === "organizer")).toHaveLength(1);

    // The old organizer can no longer remove/transfer (not-organizer now); the new one can.
    await expect(ctx.remove({ sub: "sub-ann" }, created.crew.crewId, boId)).rejects.toMatchObject({ code: "not-organizer" });
  });

  it("an ordinary member attempting to transfer is rejected — not-organizer", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });
    await seedAccountGolfer(ctx.golferStore, "sub-bo", "Bo");
    await ctx.join({ sub: "sub-bo" }, { token: (await ctx.mint({ sub: "sub-ann" }, created.crew.crewId)).token });
    const calId = await seedAccountGolfer(ctx.golferStore, "sub-cal", "Cal");
    await ctx.join({ sub: "sub-cal" }, { token: (await ctx.mint({ sub: "sub-ann" }, created.crew.crewId)).token });

    await expect(ctx.transfer({ sub: "sub-bo" }, created.crew.crewId, { golferId: calId })).rejects.toMatchObject({ code: "not-organizer" });
  });

  it("transferring to a non-member is rejected — not-a-member (the domain roster op)", async () => {
    const ctx = setup();
    await seedAccountGolfer(ctx.golferStore, "sub-ann", "Ann");
    const created = await ctx.create({ sub: "sub-ann" }, { name: "Sunday Skins" });

    await expect(ctx.transfer({ sub: "sub-ann" }, created.crew.crewId, { golferId: golferId("never-joined") })).rejects.toMatchObject({
      code: "not-a-member",
    });
  });
});

// getCrewRecords (the M8 GET /crews/{crewId}/records use case) is GONE (architecture-realignment
// Task 9): the crew projection layer it read from is deleted. Season standings are computed on
// read now — see seasonSlice.test.ts (createSeason/listSeasons/getSeasonStandings/leaveCrew).

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
    listByGolfer: inner.listByGolfer,
    putSeason: inner.putSeason,
    getSeason: inner.getSeason,
    listSeasons: inner.listSeasons,
    countsRound: inner.countsRound,
    put: async (crew, expectedRevision) => {
      putAttempts += 1;
      if (putAttempts <= failCount) throw new ApplicationError("crew-conflict", `synthetic conflict #${putAttempts}`);
      return inner.put(crew, expectedRevision);
    },
  };
};

// The generic retry loop itself (bounded attempts, conflict-vs-non-conflict discrimination)
// is pinned once at its shared home, retryOnConflict.test.ts — these two mirror
// courseSlice.test.ts's own addTee flaky-store pair exactly, but through joinCrewByInvite (the
// M8-era addCrewMember these tests used to drive is gone), to confirm the CREW-SPECIFIC wiring
// (crewStore's get/put shape, unknown-crew/crew-conflict codes) is actually correct, not just
// the abstract algorithm.
describe("joinCrewByInvite conflict retry", () => {
  it("retries once on a synthetic crew-conflict from the store, then succeeds", async () => {
    const inner = createInMemoryCrewStore();
    const golferStore = createInMemoryGolferStore();
    const tokenIssuer = createTestTokenIssuer();
    const clock = createFixedClock(1_000);
    await seedAccountGolfer(golferStore, "sub-ann", "Ann");
    const calId = await seedAccountGolfer(golferStore, "sub-cal", "Cal");
    const created = await createCrew({ crewStore: inner, golferStore, ids: createSequentialIds("c"), clock })({ sub: "sub-ann" }, { name: "Sunday Skins" });
    const minted = await mintCrewInvite({ crewStore: inner, golferStore, tokenIssuer, clock })({ sub: "sub-ann" }, created.crew.crewId);

    const flaky = createFlakyCrewStore(inner, 1);
    const join = joinCrewByInvite({ crewStore: flaky, golferStore, tokenIssuer, clock });
    const joined = await join({ sub: "sub-cal" }, { token: minted.token });

    expect(joined.crew.members.map((m) => m.name)).toEqual(expect.arrayContaining(["Ann", "Cal"]));
    expect(calId).toBeDefined();
    // More than one put attempt is the proof the retry path actually ran, not that the first
    // attempt just happened to succeed.
    expect(flaky.putAttempts()).toBeGreaterThan(1);
  });

  it("gives up after bounded attempts and rethrows crew-conflict when the store never stops conflicting", async () => {
    const inner = createInMemoryCrewStore();
    const golferStore = createInMemoryGolferStore();
    const tokenIssuer = createTestTokenIssuer();
    const clock = createFixedClock(1_000);
    await seedAccountGolfer(golferStore, "sub-ann", "Ann");
    await seedAccountGolfer(golferStore, "sub-cal", "Cal");
    const created = await createCrew({ crewStore: inner, golferStore, ids: createSequentialIds("c"), clock })({ sub: "sub-ann" }, { name: "Sunday Skins" });
    const minted = await mintCrewInvite({ crewStore: inner, golferStore, tokenIssuer, clock })({ sub: "sub-ann" }, created.crew.crewId);

    const flaky = createFlakyCrewStore(inner, Number.POSITIVE_INFINITY);
    const join = joinCrewByInvite({ crewStore: flaky, golferStore, tokenIssuer, clock });

    await expect(join({ sub: "sub-cal" }, { token: minted.token })).rejects.toMatchObject({ code: "crew-conflict" });
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
