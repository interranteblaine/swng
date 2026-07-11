import { describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import { crewId, golferId } from "../ids.js";
import type { GolferId } from "../ids.js";
import type { GameConfigDraft } from "../scoring/game.js";
import { addMember, applyStandingGame } from "./crew.js";
import type { Crew, CrewMember, StandingGame } from "./crew.js";

const CREW = crewId("saturday-boys");
const A = golferId("ann");
const B = golferId("bo");
const C = golferId("cal");
const D = golferId("dee");

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

describe("applyStandingGame — survival rule: a game survives iff every referenced golferId is present", () => {
  const singles: GameConfigDraft = { kind: "singles-match", a: A, b: B };
  const skinsFour: GameConfigDraft = { kind: "skins", players: [A, B, C, D] };
  const stablefordThree: GameConfigDraft = { kind: "stableford", players: [A, B, C] };

  it("hand-pin: [singles(A,B), skins(A,B,C,D), stableford(A,B,C)] with {A,B,C} present -> [singles, stableford]", () => {
    const preset: StandingGame = { games: [singles, skinsFour, stablefordThree] };
    const present = new Set([A, B, C]);
    expect(applyStandingGame(preset, present)).toEqual([singles, stablefordThree]);
  });

  it("preserves preset order among surviving games regardless of which ones drop", () => {
    const preset: StandingGame = { games: [stablefordThree, singles, skinsFour] };
    const present = new Set([A, B, C]);
    expect(applyStandingGame(preset, present)).toEqual([stablefordThree, singles]);
  });

  it("keeps every game when every referenced golfer is present", () => {
    const preset: StandingGame = { games: [singles, skinsFour, stablefordThree] };
    const present = new Set([A, B, C, D]);
    expect(applyStandingGame(preset, present)).toEqual([singles, skinsFour, stablefordThree]);
  });

  it("drops every game when no referenced golfer is present", () => {
    const preset: StandingGame = { games: [singles, skinsFour, stablefordThree] };
    const present = new Set<GolferId>([]);
    expect(applyStandingGame(preset, present)).toEqual([]);
  });

  it("extracts stroke-play's referenced golfers from players[]", () => {
    const strokePlay: GameConfigDraft = { kind: "stroke-play", scoring: "gross", players: [A, B] };
    expect(applyStandingGame({ games: [strokePlay] }, new Set([A]))).toEqual([]);
    expect(applyStandingGame({ games: [strokePlay] }, new Set([A, B]))).toEqual([strokePlay]);
  });

  it("extracts fourball-match's referenced golfers from BOTH pairs (a and b)", () => {
    const fourball: GameConfigDraft = { kind: "fourball-match", a: [A, B], b: [C, D] };
    // Missing D (side b's second player) drops the whole game, not just half of it.
    expect(applyStandingGame({ games: [fourball] }, new Set([A, B, C]))).toEqual([]);
    expect(applyStandingGame({ games: [fourball] }, new Set([A, B, C, D]))).toEqual([fourball]);
  });

});
