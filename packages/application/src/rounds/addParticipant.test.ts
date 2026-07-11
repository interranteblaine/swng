import { describe, expect, it } from "vitest";
import { addMember, crewId, fixtureLinks, golferId } from "@swng/domain";
import type { ParticipantClaims, TokenClaims, TokenIssuer } from "../ports/tokenIssuer.js";
import {
  createCapturingBroadcast,
  createFixedClock,
  createInMemoryCrewStore,
  createInMemoryGolferStore,
  createInMemoryJournal,
  createInMemoryRoundStore,
  createSequentialIds,
  putAndBindGolfer,
} from "../testing/fakes.js";
import { addParticipant } from "./addParticipant.js";
import { finalizeRound } from "./finalizeRound.js";
import { startRound } from "./startRound.js";

// Not part of the shared fakes — same local idiom as roundSlice.test.ts's own
// createTestTokenIssuer.
const createTestTokenIssuer = (): TokenIssuer => {
  const claimsByToken = new Map<string, TokenClaims>();
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
  const store = createInMemoryRoundStore();
  const broadcast = createCapturingBroadcast();
  const tokens = createTestTokenIssuer();
  const clock = createFixedClock(1_000);
  const ids = createSequentialIds("t");
  const golferStore = createInMemoryGolferStore();
  const crewStore = createInMemoryCrewStore();

  return {
    broadcast,
    golferStore,
    crewStore,
    start: startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, crewStore }),
    finalize: finalizeRound({ journal, store, broadcast, clock, ids }),
    addPlayer: addParticipant({ journal, broadcast, clock, ids, golferStore, crewStore }),
  };
};

describe("addParticipant", () => {
  it("an unclaimed golferId is seated as-is (arm 1)", async () => {
    const ctx = setup();
    const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };
    const ghost = golferId("ghost-1");

    const result = await ctx.addPlayer(hostClaims, { name: "Bo", tee: "white", courseHandicap: 2, golferId: ghost });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ kind: "participant-joined", participant: { golferId: ghost, name: "Bo" }, authorId: host.golferId });
  });

  it("with no golferId supplied, mints a fresh one", async () => {
    const ctx = setup();
    const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };

    const result = await ctx.addPlayer(hostClaims, { name: "Bo", tee: "white", courseHandicap: 2 });
    const joined = result.events[0];
    expect(joined?.kind).toBe("participant-joined");
    expect(joined && joined.kind === "participant-joined" ? joined.participant.golferId : undefined).not.toBe(host.golferId);
  });

  it("crew-consent (arm 3): a golfer claimed by someone ELSE but who IS a member of THIS round's crew is seated", async () => {
    const ctx = setup();
    const annId = golferId("ann-account");
    const boId = golferId("bo-account");
    await putAndBindGolfer(ctx.golferStore, annId, "sub-ann", "Ann");
    await putAndBindGolfer(ctx.golferStore, boId, "sub-bo", "Bo");
    const crew = addMember(
      addMember({ id: crewId("crew-1"), name: "Sunday Skins", members: [] }, { golferId: annId, name: "Ann", role: "organizer" }),
      { golferId: boId, name: "Bo", role: "member" },
    );
    await ctx.crewStore.put(crew, "JOINCD", undefined);

    const host = await ctx.start(
      { card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 }, golferId: annId, crewId: crewId("crew-1") },
      { sub: "sub-ann" },
    );
    const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: annId };

    const result = await ctx.addPlayer(hostClaims, { name: "Bo", tee: "white", courseHandicap: 2, golferId: boId });
    expect(result.events[0]).toMatchObject({ kind: "participant-joined", participant: { golferId: boId } });
  });

  it("a claimed golferId with no crew consent available is rejected — golfer-claimed (arm 4; as-self is structurally unreachable through this participant-token surface)", async () => {
    const ctx = setup();
    const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };
    const claimed = golferId("claimed-1");
    await putAndBindGolfer(ctx.golferStore, claimed, "sub-someone", "Someone");

    await expect(ctx.addPlayer(hostClaims, { name: "X", tee: "white", courseHandicap: 2, golferId: claimed })).rejects.toMatchObject({
      code: "golfer-claimed",
    });
  });

  it("a golferId already seated in this round is rejected — golfer-already-in-round", async () => {
    const ctx = setup();
    const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };

    await expect(ctx.addPlayer(hostClaims, { name: "Ann again", tee: "white", courseHandicap: 8, golferId: host.golferId })).rejects.toMatchObject({
      code: "golfer-already-in-round",
    });
  });

  it("a caller who never joined is rejected — not-a-participant", async () => {
    const ctx = setup();
    const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    const stranger: ParticipantClaims = { roundId: host.roundId, golferId: golferId("stranger") };

    await expect(ctx.addPlayer(stranger, { name: "Bo", tee: "white", courseHandicap: 2 })).rejects.toMatchObject({ code: "not-a-participant" });
  });

  it("an unknown tee is rejected — unknown-tee-set (DomainError propagates)", async () => {
    const ctx = setup();
    const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };

    await expect(ctx.addPlayer(hostClaims, { name: "Bo", tee: "gold", courseHandicap: 2 })).rejects.toMatchObject({ code: "unknown-tee-set" });
  });

  it("a finalized round rejects further adds — round-final", async () => {
    const ctx = setup();
    const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };
    await ctx.finalize(hostClaims);

    await expect(ctx.addPlayer(hostClaims, { name: "Bo", tee: "white", courseHandicap: 2 })).rejects.toMatchObject({ code: "round-final" });
  });
});
