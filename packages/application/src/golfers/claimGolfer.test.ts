import { describe, expect, it } from "vitest";
import { addMember, crewId, fixtureLinks, golferId } from "@swng/domain";
import type { ParticipantClaims, TokenIssuer } from "../ports/tokenIssuer.js";
import { joinRound } from "../rounds/joinRound.js";
import { startRound } from "../rounds/startRound.js";
import {
  createCapturingBroadcast,
  createFixedClock,
  createInMemoryCrewStore,
  createInMemoryGolferStore,
  createInMemoryJournal,
  createInMemoryRoundStore,
  createSequentialIds,
} from "../testing/fakes.js";
import { claimGolfer } from "./claimGolfer.js";

// Not part of the shared fakes — same local idiom as roundSlice.test.ts's own
// createTestTokenIssuer (a real TokenIssuer adapter isn't needed here; startRound/joinRound
// just need SOMETHING that satisfies the port).
const createTestTokenIssuer = (): TokenIssuer => {
  const claimsByToken = new Map<string, ParticipantClaims>();
  let counter = 0;
  return {
    issue: (claims) => {
      const token = `token-${(counter += 1)}`;
      claimsByToken.set(token, claims);
      return token;
    },
    verify: (token) => claimsByToken.get(token),
  };
};

const setup = () => {
  const journal = createInMemoryJournal();
  const roundStore = createInMemoryRoundStore();
  const crewStore = createInMemoryCrewStore();
  const golferStore = createInMemoryGolferStore();
  const broadcast = createCapturingBroadcast();
  const tokens = createTestTokenIssuer();
  const clock = createFixedClock(1_000);
  const ids = createSequentialIds("t");

  return {
    golferStore,
    roundStore,
    crewStore,
    journal,
    start: startRound({ journal, store: roundStore, broadcast, tokens, clock, ids, golferStore, crewStore }),
    join: joinRound({ journal, store: roundStore, broadcast, tokens, clock, ids, golferStore, crewStore }),
    claim: claimGolfer({ golferStore, roundStore, journal, crewStore }),
  };
};

type Ctx = ReturnType<typeof setup>;

// Seeds a LIVE round with `ghost` seated as its host — via the real startRound use case, not
// hand-built events — and returns the round's own join code, the one proof token the round
// arm of claimGolfer's precheck accepts.
const seedRoundWithParticipant = async (ctx: Ctx, ghost: ReturnType<typeof golferId>, name = "Cal"): Promise<string> => {
  const started = await ctx.start({ card: fixtureLinks, host: { name, tee: "white", courseHandicap: 8 }, golferId: ghost });
  return started.joinCode;
};

// Seeds a crew with `ghost` on its roster directly — crewStore.put over domain's own
// addMember, the same direct-construction idiom golferIdentity.test.ts's "standing consent"
// arm already uses — no need to drive the full createCrew/addCrewMember flow (which requires
// its own account-golfer setup) just to prove membership.
const seedCrewWithMember = async (ctx: Ctx, ghost: ReturnType<typeof golferId>, code = "CREWCD"): Promise<string> => {
  const crew = addMember({ id: crewId("crew-1"), name: "Sunday Skins", members: [] }, { golferId: ghost, name: "Cal", role: "member" });
  await ctx.crewStore.put(crew, code, undefined);
  return code;
};

describe("claimGolfer — happy path (round-code proof)", () => {
  it("binds an unbound sub to an unclaimed ghost golferId, seeding a name from the claims, once a round join code proves membership", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-1");
    const code = await seedRoundWithParticipant(ctx, ghost);

    const claimed = await ctx.claim({ sub: "sub-1", email: "cal@example.com" }, { golferId: ghost, code });
    expect(claimed.golfer.golferId).toBe(ghost);
    expect(claimed.golfer.name).toBe("cal");

    const bound = await ctx.golferStore.getBySub("sub-1");
    expect(bound?.golfer.id).toBe(ghost);
  });
});

describe("claimGolfer — proof of context (M9 hardening)", () => {
  it("crew-code proof: a code resolving to a crew this golferId is a member of is accepted", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-1");
    const code = await seedCrewWithMember(ctx, ghost);

    const claimed = await ctx.claim({ sub: "sub-1", email: "cal@example.com" }, { golferId: ghost, code });
    expect(claimed.golfer.golferId).toBe(ghost);
  });

  it("a code resolving to a round that does NOT contain this golferId is rejected — claim-proof-required", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-1");
    const stranger = golferId("stranger-1");
    const code = await seedRoundWithParticipant(ctx, stranger); // proves stranger, not ghost

    await expect(ctx.claim({ sub: "sub-1" }, { golferId: ghost, code })).rejects.toMatchObject({ code: "claim-proof-required" });
  });

  it("a code resolving to a crew that does NOT contain this golferId is rejected — claim-proof-required", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-1");
    const stranger = golferId("stranger-1");
    const code = await seedCrewWithMember(ctx, stranger);

    await expect(ctx.claim({ sub: "sub-1" }, { golferId: ghost, code })).rejects.toMatchObject({ code: "claim-proof-required" });
  });

  it("a garbage code that resolves to no round or crew at all is rejected — claim-proof-required", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-1");

    await expect(ctx.claim({ sub: "sub-1" }, { golferId: ghost, code: "NOPE99" })).rejects.toMatchObject({ code: "claim-proof-required" });
  });

  it("proof is checked BEFORE collision arm 1 (golfer-already-claimed) — a wrong code never leaks that the golfer is already claimed", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-1");
    const code = await seedRoundWithParticipant(ctx, ghost);
    await ctx.claim({ sub: "sub-a" }, { golferId: ghost, code }); // sub-a claims it first, for real

    // sub-b supplies a WRONG code — must fail with claim-proof-required, NOT
    // golfer-already-claimed (which would leak that ghost IS claimed to a caller who never
    // proved they belong in ghost's round/crew).
    await expect(ctx.claim({ sub: "sub-b" }, { golferId: ghost, code: "WRONGC" })).rejects.toMatchObject({ code: "claim-proof-required" });

    // The first claimant's binding survives the rejected second attempt untouched.
    const bound = await ctx.golferStore.get(ghost);
    expect(bound?.sub).toBe("sub-a");
  });

  it("proof is checked BEFORE collision arm 2 (sub already bound elsewhere) — same ordering", async () => {
    const ctx = setup();
    const mine = golferId("ghost-mine");
    const other = golferId("ghost-other");
    const myCode = await seedRoundWithParticipant(ctx, mine);
    await ctx.claim({ sub: "sub-1" }, { golferId: mine, code: myCode }); // sub-1 is already bound to `mine`

    // A second claim attempt, WRONG code for `other` — must fail with claim-proof-required,
    // not golfer-already-claimed (arm 2 would otherwise fire here and leak that sub-1 has an
    // existing binding).
    await expect(ctx.claim({ sub: "sub-1" }, { golferId: other, code: "WRONGC" })).rejects.toMatchObject({ code: "claim-proof-required" });

    // sub-1's original binding is unchanged, and `other` was never touched.
    expect(await ctx.golferStore.get(other)).toBeUndefined();
    const stillMine = await ctx.golferStore.getBySub("sub-1");
    expect(stillMine?.golfer.id).toBe(mine);
  });

  it("once proof passes, collision arm 1 (golfer already claimed) still fires normally", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-1");
    const code = await seedRoundWithParticipant(ctx, ghost);
    await ctx.claim({ sub: "sub-a" }, { golferId: ghost, code });

    await expect(ctx.claim({ sub: "sub-b" }, { golferId: ghost, code })).rejects.toMatchObject({ code: "golfer-already-claimed" });

    const bound = await ctx.golferStore.get(ghost);
    expect(bound?.sub).toBe("sub-a");
  });

  it("once proof passes, collision arm 2 (sub already bound to another golfer) still fires normally", async () => {
    const ctx = setup();
    const mine = golferId("ghost-mine");
    const other = golferId("ghost-other");
    const myCode = await seedRoundWithParticipant(ctx, mine);
    const otherCode = await seedRoundWithParticipant(ctx, other, "Dee");
    await ctx.claim({ sub: "sub-1" }, { golferId: mine, code: myCode });

    // A VALID code for `other` this time — proof passes, so the rejection must be the real
    // golfer-already-claimed collision arm, not claim-proof-required.
    await expect(ctx.claim({ sub: "sub-1" }, { golferId: other, code: otherCode })).rejects.toMatchObject({ code: "golfer-already-claimed" });

    expect(await ctx.golferStore.get(other)).toBeUndefined();
    const stillMine = await ctx.golferStore.getBySub("sub-1");
    expect(stillMine?.golfer.id).toBe(mine);
  });
});

// Papercut 5 (M8 plan): ClaimGolferRequest.name is used ONLY when the claim lazily CREATES
// the golfer row — a claim binding an EXISTING (already-ghosted) row never renames it, no
// matter what name is supplied. Both arms pinned directly (golferStore.ts's port doc already
// states the invariant; this is application's own behavioral proof of it) — now over a
// proof-passing claim, since proof is required to reach either branch at all.
describe("claimGolfer — the optional `name` field (papercut 5), once proof passes", () => {
  it("seeds a FRESH row's name from the request when the claim creates it", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-1");
    const code = await seedRoundWithParticipant(ctx, ghost);

    const claimed = await ctx.claim({ sub: "sub-1", email: "cal@example.com" }, { golferId: ghost, name: "Cal Custom", code });
    expect(claimed.golfer.name).toBe("Cal Custom"); // NOT the claims-derived default ("cal")
  });

  it("falls back to the claims-derived default name when the create branch gets no name", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-1");
    const code = await seedRoundWithParticipant(ctx, ghost);

    const claimed = await ctx.claim({ sub: "sub-1", email: "cal@example.com" }, { golferId: ghost, code });
    expect(claimed.golfer.name).toBe("cal");
  });

  it("NEVER renames an EXISTING (already-ghosted, unclaimed) row, even when a name is supplied", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-1");
    const code = await seedRoundWithParticipant(ctx, ghost);
    // Golfer items are lazy (golferStore.ts's port doc) — startRound never creates one just
    // because a participant-joined names this golferId. This directly seeds a row with an
    // established name from "prior round play", unclaimed, before this claim ever runs.
    await ctx.golferStore.put({ id: ghost, name: "Cal From The Round", handicap: {} }, undefined);

    const claimed = await ctx.claim({ sub: "sub-1", email: "cal@example.com" }, { golferId: ghost, name: "A Totally Different Name", code });

    expect(claimed.golfer.name).toBe("Cal From The Round"); // unchanged — never renamed
  });
});
