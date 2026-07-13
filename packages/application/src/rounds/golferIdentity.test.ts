import { describe, expect, it } from "vitest";
import { addMember, crewId, golferId } from "@swng/domain";
import { createInMemoryCrewStore, createInMemoryGolferStore, putAndBindGolfer } from "../testing/fakes.js";
import { resolveSuppliedGolfer } from "./golferIdentity.js";

// Direct unit coverage of the shared claimed-golferId rule's four arms — the three real call
// sites (startRound/joinRound/addParticipant, each surface's own test files) assert this by
// BEHAVIOR through their own flows; this file pins the resolver's own logic in isolation,
// independent of any round/journal/broadcast machinery.
//
// Round-is-a-sealed-leaf: the crew-consent arm is CO-MEMBERSHIP now — the resolver derives the
// caller's OWN crews from their sub and allows the seat iff caller and target share one. There
// is no round crew tag to hand it anymore.
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
    await putAndBindGolfer(ctx.golferStore, claimed, "sub-ann", "Ann");

    await expect(ctx.resolve(claimed, { sub: "sub-ann" })).resolves.toBe(claimed);
  });

  it("arm 3 — claimed by someone else, but caller and target share a crew: allowed (co-membership)", async () => {
    const ctx = setup();
    const target = golferId("target"); // the claimed golfer being seated
    const caller = golferId("caller"); // the signed-in caller seating them
    await putAndBindGolfer(ctx.golferStore, target, "sub-target", "Tara");
    await putAndBindGolfer(ctx.golferStore, caller, "sub-caller", "Cal");

    // Both are members of the SAME crew — the crew relationship itself is the consent.
    const crew = addMember(
      addMember({ id: crewId("crew-1"), name: "Sunday Skins", members: [] }, { golferId: caller, name: "Cal", role: "organizer" }),
      { golferId: target, name: "Tara", role: "member" },
    );
    await ctx.crewStore.put(crew, "JOINCD", undefined);

    // ctx.sub is the CALLER's sub (not the target's) — only the co-membership arm can allow this.
    await expect(ctx.resolve(target, { sub: "sub-caller" })).resolves.toBe(target);
  });

  it("arm 3 — caller signed in but shares NO crew with the target: falls through to rejected", async () => {
    const ctx = setup();
    const target = golferId("target");
    const caller = golferId("caller");
    await putAndBindGolfer(ctx.golferStore, target, "sub-target", "Tara");
    await putAndBindGolfer(ctx.golferStore, caller, "sub-caller", "Cal");

    // Caller has a crew; target is in a DIFFERENT crew — no shared crewId, no consent.
    const callerCrew = addMember({ id: crewId("crew-caller"), name: "Caller Crew", members: [] }, { golferId: caller, name: "Cal", role: "organizer" });
    const targetCrew = addMember({ id: crewId("crew-target"), name: "Target Crew", members: [] }, { golferId: target, name: "Tara", role: "organizer" });
    await ctx.crewStore.put(callerCrew, "JOINCA", undefined);
    await ctx.crewStore.put(targetCrew, "JOINTA", undefined);

    await expect(ctx.resolve(target, { sub: "sub-caller" })).rejects.toMatchObject({ code: "golfer-claimed" });
  });

  it("arm 3 — a sub with no account golfer of its own has no crews to share: rejected", async () => {
    const ctx = setup();
    const target = golferId("target");
    await putAndBindGolfer(ctx.golferStore, target, "sub-target", "Tara");
    // The target IS in a crew, but the caller's sub resolves to no golfer, so there's nothing
    // to intersect against — co-membership can't be established.
    const crew = addMember({ id: crewId("crew-1"), name: "Sunday Skins", members: [] }, { golferId: target, name: "Tara", role: "organizer" });
    await ctx.crewStore.put(crew, "JOINCD", undefined);

    await expect(ctx.resolve(target, { sub: "sub-nobody" })).rejects.toMatchObject({ code: "golfer-claimed" });
  });

  it("arm 4 — claimed, no sub at all: rejected — golfer-claimed", async () => {
    const ctx = setup();
    const claimed = golferId("claimed-1");
    await putAndBindGolfer(ctx.golferStore, claimed, "sub-ann", "Ann");

    await expect(ctx.resolve(claimed, {})).rejects.toMatchObject({ code: "golfer-claimed" });
  });

  it("arm 4 — claimed, a DIFFERENT sub supplied with no shared crew: rejected — golfer-claimed", async () => {
    const ctx = setup();
    const claimed = golferId("claimed-1");
    await putAndBindGolfer(ctx.golferStore, claimed, "sub-ann", "Ann");

    await expect(ctx.resolve(claimed, { sub: "sub-stranger" })).rejects.toMatchObject({ code: "golfer-claimed" });
  });

  it("never mints — every arm above returns the SUPPLIED id verbatim, never a fresh one", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-only-arm-reachable-here");
    const resolved = await ctx.resolve(ghost, {});
    expect(resolved).toBe(ghost); // identity, not just "a truthy golferId"
  });
});
