import { describe, expect, it } from "vitest";
import { addMember, crewId, fixtureLinks, golferId } from "@swng/domain";
import type { ParticipantClaims, TokenClaims, TokenIssuer } from "../ports/tokenIssuer.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import {
  createCapturingBroadcast,
  createCapturingLogger,
  createFixedClock,
  createInMemoryCrewStore,
  createInMemoryGolferStore,
  createInMemoryJournal,
  createInMemoryProjectionStore,
  createInMemoryRoundStore,
  createInMemorySnapshotStore,
  createNullLogger,
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
  const snapshots = createInMemorySnapshotStore();
  const journal = createInMemoryJournal(snapshots);
  const store = createInMemoryRoundStore();
  const broadcast = createCapturingBroadcast();
  const tokens = createTestTokenIssuer();
  const clock = createFixedClock(1_000);
  const ids = createSequentialIds("t");
  const golferStore = createInMemoryGolferStore();
  const crewStore = createInMemoryCrewStore();
  const projectionStore = createInMemoryProjectionStore();
  const logger = createNullLogger();

  return {
    broadcast,
    golferStore,
    crewStore,
    projectionStore,
    start: startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, crewStore, projectionStore, logger }),
    finalize: finalizeRound({ journal, snapshots, broadcast, clock, ids }),
    addPlayer: addParticipant({ journal, broadcast, clock, ids, golferStore, crewStore, projectionStore, logger }),
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

  // Round-is-a-sealed-leaf narrowing: co-membership consent now derives from the CALLER's sub
  // (golferIdentity.ts), and a participant token carries none. So even a claimed golfer who is a
  // crew-mate of the round's host can NOT be seated through this surface — it rejects
  // golfer-claimed. (Seating a claimed crew-mate lives on startRound/joinRound, which carry an
  // optional AccountClaims.)
  it("a claimed crew-mate is NOT seatable through the participant-token surface — golfer-claimed (no sub for co-membership)", async () => {
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
      { card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 }, golferId: annId },
      { sub: "sub-ann" },
    );
    const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: annId };

    await expect(ctx.addPlayer(hostClaims, { name: "Bo", tee: "white", courseHandicap: 2, golferId: boId })).rejects.toMatchObject({
      code: "golfer-claimed",
    });
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

  // Presence (projection-realignment spec §5, Task 13): the added player gets a LIVE pointer
  // too — ghosts inherit presence for free, same as StartRound/JoinRound (roundSlice.test.ts's
  // own presence suite).
  it("writes a LIVE pointer for the added player, carrying the round's own courseName", async () => {
    const ctx = setup();
    const host = await ctx.start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };
    const ghost = golferId("ghost-1");

    await ctx.addPlayer(hostClaims, { name: "Bo", tee: "white", courseHandicap: 2, golferId: ghost });

    const live = await ctx.projectionStore.listLive(ghost);
    expect(live).toEqual([{ roundId: host.roundId, courseName: fixtureLinks.courseName, joinedAtMs: expect.any(Number) }]);
  });

  // Same binding resolution as StartRound/JoinRound's own pin (roundSlice.test.ts): a
  // discovery nicety must never block play.
  it("a putLive failure does NOT fail addParticipant — logged via logger.warn, add still succeeds", async () => {
    const snapshots = createInMemorySnapshotStore();
    const journal = createInMemoryJournal(snapshots);
    const store = createInMemoryRoundStore();
    const broadcast = createCapturingBroadcast();
    const tokens = createTestTokenIssuer();
    const clock = createFixedClock(1_000);
    const ids = createSequentialIds("t");
    const golferStore = createInMemoryGolferStore();
    const crewStore = createInMemoryCrewStore();
    const logger = createCapturingLogger();
    const throwingStore: ProjectionStore = {
      ...createInMemoryProjectionStore(),
      putLive: async () => {
        throw new Error("presence table unavailable");
      },
    };
    const start = startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, crewStore, projectionStore: throwingStore, logger });
    const addPlayer = addParticipant({ journal, broadcast, clock, ids, golferStore, crewStore, projectionStore: throwingStore, logger });

    const host = await start({ card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    const hostClaims: ParticipantClaims = { roundId: host.roundId, golferId: host.golferId };

    const result = await addPlayer(hostClaims, { name: "Bo", tee: "white", courseHandicap: 2 });

    expect(result.events).toHaveLength(1); // the add succeeded — presence's own failure never propagated
    expect(logger.warnings.some((entry) => entry.message === "presence-write-failed")).toBe(true);
  });
});
