import { describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import { crewId, golferId } from "../ids.js";
import { addMember, removeMember, transferOrganizer, validateCrewName } from "./crew.js";
import type { Crew, CrewMember } from "./crew.js";

const CREW = crewId("saturday-boys");
const A = golferId("ann");
const B = golferId("bo");

const emptyCrew: Crew = { id: CREW, name: "The Saturday Boys", members: [] };

describe("addMember", () => {
  it("adds the first member to an empty crew", () => {
    const member: CrewMember = { golferId: A, name: "Ann", role: "organizer" };
    const crew = addMember(emptyCrew, member);
    expect(crew.members).toEqual([member]);
  });

  it("does not mutate the input crew (pure)", () => {
    const member: CrewMember = { golferId: A, name: "Ann", role: "organizer" };
    addMember(emptyCrew, member);
    expect(emptyCrew.members).toEqual([]);
  });

  it("appends a second, distinct member, preserving join order", () => {
    const ann: CrewMember = { golferId: A, name: "Ann", role: "organizer" };
    const bo: CrewMember = { golferId: B, name: "Bo", role: "member" };
    const withAnn = addMember(emptyCrew, ann);
    const withBoth = addMember(withAnn, bo);
    expect(withBoth.members).toEqual([ann, bo]);
  });

  it("throws duplicate-member when the golferId is already present", () => {
    const ann: CrewMember = { golferId: A, name: "Ann", role: "organizer" };
    const withAnn = addMember(emptyCrew, ann);
    const again: CrewMember = { golferId: A, name: "Ann II", role: "member" };
    const attempt = () => addMember(withAnn, again);
    expect(attempt).toThrowError(DomainError);
    expect(attempt).toThrowError(expect.objectContaining({ code: "duplicate-member" }));
  });

  it("throws on an empty name", () => {
    const attempt = () => addMember(emptyCrew, { golferId: A, name: "", role: "organizer" });
    expect(attempt).toThrowError(expect.objectContaining({ code: "invalid-member-name" }));
  });

  it("throws on a whitespace-only name", () => {
    const attempt = () => addMember(emptyCrew, { golferId: A, name: "   ", role: "organizer" });
    expect(attempt).toThrowError(expect.objectContaining({ code: "invalid-member-name" }));
  });

  it("accepts a single-character name (min 1)", () => {
    const crew = addMember(emptyCrew, { golferId: A, name: "A", role: "organizer" });
    expect(crew.members[0]?.name).toBe("A");
  });
});

// Crew membership (invited in, accountable out — spec §1): the organizer's authority.
// removeMember/transferOrganizer are pure roster ops — identical revision-checked put idiom as
// addMember, no projection/season/standings code touched (standings aggregation scope does the
// rest at read time).
describe("removeMember", () => {
  const organizer: CrewMember = { golferId: A, name: "Ann", role: "organizer" };
  const member: CrewMember = { golferId: B, name: "Bo", role: "member" };
  const crew: Crew = { id: CREW, name: "The Saturday Boys", members: [organizer, member] };

  it("removes a non-organizer member", () => {
    const result = removeMember(crew, B);
    expect(result.members).toEqual([organizer]);
  });

  it("does not mutate the input crew (pure)", () => {
    removeMember(crew, B);
    expect(crew.members).toEqual([organizer, member]);
  });

  it("throws organizer-immovable when the target is the organizer", () => {
    const attempt = () => removeMember(crew, A);
    expect(attempt).toThrowError(DomainError);
    expect(attempt).toThrowError(expect.objectContaining({ code: "organizer-immovable" }));
  });

  it("throws not-a-member when the target golferId isn't on the roster", () => {
    const stranger = golferId("stranger");
    const attempt = () => removeMember(crew, stranger);
    expect(attempt).toThrowError(DomainError);
    expect(attempt).toThrowError(expect.objectContaining({ code: "not-a-member" }));
  });
});

describe("transferOrganizer", () => {
  const organizer: CrewMember = { golferId: A, name: "Ann", role: "organizer" };
  const memberB: CrewMember = { golferId: B, name: "Bo", role: "member" };
  const memberC: CrewMember = { golferId: golferId("cal"), name: "Cal", role: "member" };
  const crew: Crew = { id: CREW, name: "The Saturday Boys", members: [organizer, memberB, memberC] };

  it("flips the target to organizer and the old organizer to member, preserving member order", () => {
    const result = transferOrganizer(crew, B);
    expect(result.members.map((m) => m.golferId)).toEqual([A, B, memberC.golferId]); // order preserved
    expect(result.members).toEqual([
      { ...organizer, role: "member" },
      { ...memberB, role: "organizer" },
      memberC,
    ]);
  });

  it("results in exactly one organizer after transfer", () => {
    const result = transferOrganizer(crew, B);
    expect(result.members.filter((m) => m.role === "organizer")).toHaveLength(1);
  });

  it("does not mutate the input crew (pure)", () => {
    transferOrganizer(crew, B);
    expect(crew.members).toEqual([organizer, memberB, memberC]);
  });

  it("throws not-a-member when the target golferId isn't on the roster", () => {
    const stranger = golferId("stranger");
    const attempt = () => transferOrganizer(crew, stranger);
    expect(attempt).toThrowError(DomainError);
    expect(attempt).toThrowError(expect.objectContaining({ code: "not-a-member" }));
  });

  it("transferring to the current organizer is a harmless no-op (still exactly one organizer)", () => {
    const result = transferOrganizer(crew, A);
    expect(result.members).toEqual(crew.members);
  });
});

// Papercut 9 (M9 hardening): mirrors course.ts's validateCourseName exactly — trimmed,
// 1-60 characters. The wire's own `.min(1)` (contracts/crews.ts) never trims and has no upper
// bound; this is where the real invariant lives (domain is the honest layer).
describe("validateCrewName", () => {
  it("accepts an ordinary name", () => {
    expect(() => validateCrewName("Saturday Boys")).not.toThrow();
  });

  it("rejects an empty name", () => {
    const attempt = () => validateCrewName("");
    expect(attempt).toThrowError(DomainError);
    expect(attempt).toThrowError(expect.objectContaining({ code: "invalid-crew-name" }));
  });

  it("rejects a whitespace-only name (the wire's .min(1) doesn't trim; this does)", () => {
    const attempt = () => validateCrewName("   ");
    expect(attempt).toThrowError(expect.objectContaining({ code: "invalid-crew-name" }));
  });

  it("accepts a name at exactly the 60-character bound", () => {
    expect(() => validateCrewName("A".repeat(60))).not.toThrow();
  });

  it("rejects a name over the 60-character bound", () => {
    const attempt = () => validateCrewName("A".repeat(61));
    expect(attempt).toThrowError(expect.objectContaining({ code: "invalid-crew-name" }));
  });
});
