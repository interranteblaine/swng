import { describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import { crewId, golferId } from "../ids.js";
import { addMember, validateCrewName } from "./crew.js";
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
