import { describe, expect, it } from "vitest";
import { addMember, crewId, golferId } from "@swng/domain";
import { createInMemoryCrewStore, createInMemoryGolferStore, putAndBindGolfer } from "../testing/fakes.js";
import { resolveSuppliedGolfer } from "./golferIdentity.js";

// Direct unit coverage of the shared claimed-golferId rule's three arms — the three real call
// sites (startRound/joinRound/addParticipant, each surface's own test files) assert this by
// BEHAVIOR through their own flows; this file pins the resolver's own logic in isolation,
// independent of any round/journal/broadcast machinery.
//
// A crew is a grouping/competition ONLY (owner ruling, spec §11a): the old co-membership
// consent arm is deleted — claimed-non-self is ALWAYS golfer-claimed, crew-mate or stranger
// alike. `createInMemoryCrewStore` is used ONLY to build a crew fixture proving that a real,
// verifiable crew relationship changes nothing about the outcome (arm 3's own pin below); it is
// never passed to `resolveSuppliedGolfer` itself, which no longer takes a crewStore dependency.
const setup = () => {
  const golferStore = createInMemoryGolferStore();
  const crewStore = createInMemoryCrewStore();
  return { golferStore, crewStore, resolve: resolveSuppliedGolfer({ golferStore }) };
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

  it("arm 3 — claimed by someone else, no sub at all: rejected — golfer-claimed", async () => {
    const ctx = setup();
    const claimed = golferId("claimed-1");
    await putAndBindGolfer(ctx.golferStore, claimed, "sub-ann", "Ann");

    await expect(ctx.resolve(claimed, {})).rejects.toMatchObject({ code: "golfer-claimed" });
  });

  it("arm 3 — claimed, a DIFFERENT sub supplied, no crew relationship at all: rejected — golfer-claimed", async () => {
    const ctx = setup();
    const claimed = golferId("claimed-1");
    await putAndBindGolfer(ctx.golferStore, claimed, "sub-ann", "Ann");

    await expect(ctx.resolve(claimed, { sub: "sub-stranger" })).rejects.toMatchObject({ code: "golfer-claimed" });
  });

  // THE explicit pin (task-G-T1-brief.md): the old co-membership arm let a signed-in caller
  // seat a claimed FELLOW CREW MEMBER on the crew relationship's own say-so. That consent path
  // is gone outright — a real, verifiable shared crew changes NOTHING about the outcome. This
  // builds the exact fixture the old passing co-membership test used (caller and target both on
  // one crew's roster) and asserts the OPPOSITE result.
  it("arm 3 — claimed by someone else, but caller and target share a real crew: STILL rejected — golfer-claimed (co-membership consent is deleted)", async () => {
    const ctx = setup();
    const target = golferId("target"); // the claimed golfer being seated
    const caller = golferId("caller"); // the signed-in caller seating them
    await putAndBindGolfer(ctx.golferStore, target, "sub-target", "Tara");
    await putAndBindGolfer(ctx.golferStore, caller, "sub-caller", "Cal");

    // Both are members of the SAME crew — under the old rule this alone was consent enough.
    const crew = addMember(
      addMember({ id: crewId("crew-1"), name: "Sunday Skins", members: [] }, { golferId: caller, name: "Cal", role: "organizer" }),
      { golferId: target, name: "Tara", role: "member" },
    );
    await ctx.crewStore.put(crew, "JOINCD", undefined);

    // ctx.sub is the CALLER's sub (not the target's) — no arm can allow this anymore.
    await expect(ctx.resolve(target, { sub: "sub-caller" })).rejects.toMatchObject({ code: "golfer-claimed" });
  });

  it("never mints — every arm above returns the SUPPLIED id verbatim, never a fresh one", async () => {
    const ctx = setup();
    const ghost = golferId("ghost-only-arm-reachable-here");
    const resolved = await ctx.resolve(ghost, {});
    expect(resolved).toBe(ghost); // identity, not just "a truthy golferId"
  });
});
