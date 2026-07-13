import { describe, expect, it } from "vitest";
import { fixtureLinks, golferId, roundId } from "@swng/domain";
import type { TokenClaims, TokenIssuer } from "../ports/tokenIssuer.js";
import {
  createCapturingBroadcast,
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
import { finalizeRound } from "./finalizeRound.js";
import { joinRound } from "./joinRound.js";
import { mintParticipantToken } from "./mintParticipantToken.js";
import { startRound } from "./startRound.js";

// Same local-fake idiom as terminateGame.test.ts/getShareLink.test.ts's own
// createTestTokenIssuer — verify() round-trips issue()'s own claims, which is exactly what
// "the new-device token actually works" means for this use case.
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
    journal,
    golferStore,
    tokens,
    start: startRound({ journal, store, broadcast, tokens, clock, ids, golferStore, crewStore, projectionStore, logger }),
    join: joinRound({ journal, store, broadcast, tokens, clock, ids, golferStore, crewStore, projectionStore, logger }),
    finalize: finalizeRound({ journal, snapshots, broadcast, clock, ids }),
    mint: mintParticipantToken({ journal, golferStore, tokens }),
  };
};

describe("mintParticipantToken — new-device re-mint", () => {
  it("a participant seated as-self gets a WORKING token — round-trips through the issuer's own verify", async () => {
    const ctx = setup();
    const annId = golferId("ann-account");
    await putAndBindGolfer(ctx.golferStore, annId, "sub-ann", "Ann");

    const host = await ctx.start(
      { card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 }, golferId: annId },
      { sub: "sub-ann" },
    );

    const minted = await ctx.mint({ sub: "sub-ann" }, host.roundId);

    expect(minted.roundId).toBe(host.roundId);
    expect(minted.golferId).toBe(annId);
    expect(ctx.tokens.verify(minted.token)).toEqual({ scope: "participant", roundId: host.roundId, golferId: annId });
  });

  it("a participant seated via joinRound (a DIFFERENT device than the one minting) also round-trips", async () => {
    const ctx = setup();
    const annId = golferId("ann-account");
    const boId = golferId("bo-account");
    await putAndBindGolfer(ctx.golferStore, annId, "sub-ann", "Ann");
    await putAndBindGolfer(ctx.golferStore, boId, "sub-bo", "Bo");

    const host = await ctx.start(
      { card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 }, golferId: annId },
      { sub: "sub-ann" },
    );
    await ctx.join({ code: host.joinCode, name: "Bo", tee: "white", courseHandicap: 12, golferId: boId }, { sub: "sub-bo" });

    // Bo's original join-time token is discarded here on purpose — this call simulates Bo
    // opening the round from a fresh device/browser that never held it.
    const minted = await ctx.mint({ sub: "sub-bo" }, host.roundId);

    expect(minted.golferId).toBe(boId);
    expect(ctx.tokens.verify(minted.token)).toEqual({ scope: "participant", roundId: host.roundId, golferId: boId });
  });

  it("throws not-a-participant 403 for a signed-in golfer who was never seated in this round", async () => {
    const ctx = setup();
    const annId = golferId("ann-account");
    const strangerId = golferId("stranger-account");
    await putAndBindGolfer(ctx.golferStore, annId, "sub-ann", "Ann");
    await putAndBindGolfer(ctx.golferStore, strangerId, "sub-stranger", "Stranger");

    const host = await ctx.start(
      { card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 }, golferId: annId },
      { sub: "sub-ann" },
    );

    await expect(ctx.mint({ sub: "sub-stranger" }, host.roundId)).rejects.toMatchObject({ code: "not-a-participant" });
  });

  it("throws not-a-participant 403 for a sub with no account golfer row at all", async () => {
    const ctx = setup();
    const annId = golferId("ann-account");
    await putAndBindGolfer(ctx.golferStore, annId, "sub-ann", "Ann");

    const host = await ctx.start(
      { card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 }, golferId: annId },
      { sub: "sub-ann" },
    );

    await expect(ctx.mint({ sub: "sub-never-signed-in" }, host.roundId)).rejects.toMatchObject({ code: "not-a-participant" });
  });

  it("throws round-final 409 for an actual participant once the round is finalized — nothing left to score", async () => {
    const ctx = setup();
    const annId = golferId("ann-account");
    await putAndBindGolfer(ctx.golferStore, annId, "sub-ann", "Ann");

    const host = await ctx.start(
      { card: fixtureLinks, host: { name: "Ann", tee: "white", courseHandicap: 8 }, golferId: annId },
      { sub: "sub-ann" },
    );
    await ctx.finalize({ roundId: host.roundId, golferId: annId });

    await expect(ctx.mint({ sub: "sub-ann" }, host.roundId)).rejects.toMatchObject({ code: "round-final" });
  });

  it("throws round-not-found 404 for a roundId that was never created", async () => {
    const ctx = setup();
    const annId = golferId("ann-account");
    await putAndBindGolfer(ctx.golferStore, annId, "sub-ann", "Ann");

    await expect(ctx.mint({ sub: "sub-ann" }, roundId("never-created"))).rejects.toMatchObject({ code: "round-not-found" });
  });

  it("checks the caller's OWN identity before the round even loads — no golfer row wins over an unknown round", async () => {
    const ctx = setup();
    // No golfer row is ever created for "sub-nobody" — an unknown roundId would otherwise
    // 404 first if the round were folded before the identity check.
    await expect(ctx.mint({ sub: "sub-nobody" }, roundId("also-never-created"))).rejects.toMatchObject({ code: "not-a-participant" });
  });
});
