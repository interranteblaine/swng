import { describe, expect, it } from "vitest";
import { addMember, crewId, golferId } from "@swng/domain";
import { createInMemoryCrewStore, createInMemoryGolferStore } from "../testing/fakes.js";
import { resolveSuppliedGolfer } from "./golferIdentity.js";

// Direct unit coverage of the shared claimed-golferId rule's all FOUR arms (M8 plan) — the
// three real call sites (startRound/joinRound/addParticipant, each surface's own test files)
// assert this by BEHAVIOR through their own flows; this file pins the resolver's own logic
// in isolation, independent of any round/journal/broadcast machinery.
const setup = () => {
  const golferStore = createInMemoryGolferStore();
  const crewStore = createInMemoryCrewStore();
  return { golferStore, crewStore, resolve: resolveSuppliedGolfer({ golferStore, crewStore }) };
};

describe("resolveSuppliedGolfer", () => {
  it("arm 1 — unclaimed (no row at all): allowed, returns the id unchanged", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-1");
    await expect(ctx.resolve(ghost, {})).resolves.toBe(ghost);
  });

  it("arm 1 — unclaimed (a row exists but carries no sub): allowed", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-1");
    await ctx.golferStore.put({ id: ghost, name: "Cal", handicap: {} }, undefined);
    await expect(ctx.resolve(ghost, {})).resolves.toBe(ghost);
  });

  it("arm 2 — claimed AND the caller's own sub matches the bound sub: allowed (as-self)", async () => {
    const ctx = setup();
    const claimed = golferId("claimed-1");
    await ctx.golferStore.claim(claimed, "sub-ann", "Ann");

    await expect(ctx.resolve(claimed, { sub: "sub-ann" })).resolves.toBe(claimed);
  });

  it("arm 3 — claimed by someone else, but the target IS a member of the command's crew: allowed (standing consent)", async () => {
    const ctx = setup();
    const claimed = golferId("claimed-1");
    await ctx.golferStore.claim(claimed, "sub-ann", "Ann");

    const crew = addMember({ id: crewId("crew-1"), name: "Sunday Skins", members: [] }, { golferId: claimed, name: "Ann", role: "organizer" });
    await ctx.crewStore.put(crew, "JOINCD", undefined);

    // ctx.sub is a DIFFERENT sub (a fellow crew member seating Ann, not Ann herself) — only
    // the crew-consent arm can be what allows this.
    await expect(ctx.resolve(claimed, { sub: "sub-someone-else", crewId: crewId("crew-1") })).resolves.toBe(claimed);
  });

  it("arm 3 — crewId present but the target is NOT a member of that crew: falls through to rejected", async () => {
    const ctx = setup();
    const claimed = golferId("claimed-1");
    await ctx.golferStore.claim(claimed, "sub-ann", "Ann");

    const crew = addMember({ id: crewId("crew-1"), name: "Sunday Skins", members: [] }, { golferId: golferId("someone-else"), name: "Bo", role: "member" });
    await ctx.crewStore.put(crew, "JOINCD", undefined);

    await expect(ctx.resolve(claimed, { sub: "sub-stranger", crewId: crewId("crew-1") })).rejects.toMatchObject({ code: "golfer-claimed" });
  });

  it("arm 4 — claimed, no matching sub, no crewId at all: rejected — golfer-claimed", async () => {
    const ctx = setup();
    const claimed = golferId("claimed-1");
    await ctx.golferStore.claim(claimed, "sub-ann", "Ann");

    await expect(ctx.resolve(claimed, {})).rejects.toMatchObject({ code: "golfer-claimed" });
  });

  it("arm 4 — claimed, a DIFFERENT sub supplied, no crewId: rejected — golfer-claimed", async () => {
    const ctx = setup();
    const claimed = golferId("claimed-1");
    await ctx.golferStore.claim(claimed, "sub-ann", "Ann");

    await expect(ctx.resolve(claimed, { sub: "sub-stranger" })).rejects.toMatchObject({ code: "golfer-claimed" });
  });

  it("never mints — every arm above returns the SUPPLIED id verbatim, never a fresh one", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-only-arm-reachable-here");
    const resolved = await ctx.resolve(ghost, {});
    expect(resolved).toBe(ghost); // identity, not just "a truthy golferId"
  });
});
