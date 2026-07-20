import { describe, expect, it } from "vitest";
import type { CourseCard } from "@swng/domain";
import { ContractError, parse } from "./parse.js";
import {
  addGameRequestSchema,
  finalizeRoundResponseSchema,
  gameConfigInputSchema,
  joinRoundRequestSchema,
  recordScoreRequestSchema,
  setHandicapRequestSchema,
  startRoundRequestSchema,
} from "./commands.js";

const card: CourseCard = {
  courseName: "Test Links",
  teeSets: [
    {
      name: "white",
      rating: 71.2,
      slope: 128,
      holes: Array.from({ length: 9 }, (_, index) => ({ number: index + 1, par: 4, yardage: 380, strokeIndex: index + 1 })),
    },
  ],
};

describe("startRoundRequestSchema", () => {
  const course = { courseId: "course-1", cardId: "card-1" };

  // Course-cards spec §4: the request carries a REFERENCE (courseId + cardId), never a card — the
  // server resolves and freezes the lineage's current card itself. Accounts-only identity (spec
  // §3): the creator seat is always as-self from the caller's Bearer, so host carries only
  // tee/courseHandicap. No host.name (the golfer record's name is frozen into the event
  // server-side), no golferId, no players[].
  it("accepts a valid start-round request", () => {
    const request = { course, host: { tee: "white", courseHandicap: 8 } };
    expect(parse(startRoundRequestSchema, request)).toEqual(request);
  });

  it("rejects a non-integer courseHandicap", () => {
    const request = { course, host: { tee: "white", courseHandicap: 8.5 } };
    expect(() => parse(startRoundRequestSchema, request)).toThrow(ContractError);
  });

  // Course-cards spec invariant 4/5: the client can never author a card — the old `card:` shape
  // is GONE, not tolerated. A request still shaped the old way (a full card, no `course`
  // reference) is rejected as invalid, not silently accepted.
  it("rejects the old card: shape — a client can never author a card", () => {
    const request = { card, host: { tee: "white", courseHandicap: 8 } };
    expect(() => parse(startRoundRequestSchema, request)).toThrow(ContractError);
  });

  // The schema isn't `.strict()`, so an OLD client still sending the deleted identity fields
  // (host.name / golferId / players / crewId) isn't rejected — Zod's default strips the unknown
  // keys silently, leaving exactly the accounts-only shape.
  it("strips deleted/old-client fields (host.name, golferId, players, crewId) rather than rejecting them", () => {
    const request = {
      course,
      host: { name: "Ann", tee: "white", courseHandicap: 8 },
      golferId: "ann-1",
      players: [{ name: "Bo", tee: "white", courseHandicap: 2 }],
      crewId: "crew-1",
    };
    const parsed = parse(startRoundRequestSchema, request);
    expect(parsed).not.toHaveProperty("golferId");
    expect(parsed).not.toHaveProperty("players");
    expect(parsed).not.toHaveProperty("crewId");
    expect(parsed.host).not.toHaveProperty("name");
    expect(parsed).toEqual({ course, host: { tee: "white", courseHandicap: 8 } });
  });
});

describe("joinRoundRequestSchema", () => {
  // Accounts-only identity (spec §3): join is always as-self — only code + tee + courseHandicap.
  it("accepts a valid join-round request", () => {
    const request = { code: "ABC123", tee: "white", courseHandicap: 2 };
    expect(parse(joinRoundRequestSchema, request)).toEqual(request);
  });

  it("rejects a code that isn't exactly 6 characters", () => {
    const request = { code: "ABC12", tee: "white", courseHandicap: 2 };
    expect(() => parse(joinRoundRequestSchema, request)).toThrow(ContractError);
  });

  it("rejects a non-integer courseHandicap", () => {
    const request = { code: "ABC123", tee: "white", courseHandicap: 2.5 };
    expect(() => parse(joinRoundRequestSchema, request)).toThrow(ContractError);
  });

  // NOT `.strict()`: an old client still sending name / golferId strips silently.
  it("strips the deleted name / golferId fields rather than rejecting them", () => {
    const request = { code: "ABC123", name: "Bo", tee: "white", courseHandicap: 2, golferId: "g-1" };
    const parsed = parse(joinRoundRequestSchema, request);
    expect(parsed).not.toHaveProperty("name");
    expect(parsed).not.toHaveProperty("golferId");
    expect(parsed).toEqual({ code: "ABC123", tee: "white", courseHandicap: 2 });
  });
});

describe("recordScoreRequestSchema", () => {
  const base = {
    golferId: "ann",
    result: { kind: "strokes" as const, strokes: 4 },
    opId: "op-1",
    hlc: { wallMs: 1, counter: 0, deviceId: "device-1" },
  };

  it("accepts a valid record-score request", () => {
    const request = { ...base, hole: 5 };
    const parsed = parse(recordScoreRequestSchema, request);
    expect(parsed).toEqual(request);
  });

  it("rejects hole 0", () => {
    const request = { ...base, hole: 0 };
    expect(() => parse(recordScoreRequestSchema, request)).toThrow(ContractError);
  });
});

describe("setHandicapRequestSchema", () => {
  it("setHandicapRequestSchema: accepts a negative (plus) value, rejects a non-integer", () => {
    expect(setHandicapRequestSchema.parse({ golferId: "g1", courseHandicap: -2 })).toEqual({ golferId: "g1", courseHandicap: -2 });
    expect(() => setHandicapRequestSchema.parse({ golferId: "g1", courseHandicap: 12.4 })).toThrow();
  });
});

describe("addGameRequestSchema", () => {
  it("accepts a valid add-game request (config has no id)", () => {
    const request = { game: { kind: "stroke-play", scoring: "gross", players: ["ann", "bo"] } };
    expect(parse(addGameRequestSchema, request)).toEqual(request);
  });

  it("rejects a config that carries an id — the server assigns it, never the client", () => {
    const request = { game: { kind: "stroke-play", id: "sneaky", scoring: "gross", players: ["ann", "bo"] } };
    expect(() => parse(addGameRequestSchema, request)).toThrow(ContractError);
  });
});

describe("gameConfigInputSchema", () => {
  it("rejects every member if it carries an id (.strict())", () => {
    expect(() => parse(gameConfigInputSchema, { kind: "singles-match", id: "sneaky", a: "ann", b: "bo" })).toThrow(ContractError);
  });
});

describe("finalizeRoundResponseSchema", () => {
  // Task 2 review fix: handicappingEntrySchema previously only knew the "complete"/"incomplete"
  // arms of RoundArchive["handicapping"]'s union (domain/round/archive.ts) — an unrated golfer's
  // row (added alongside the "unrated" course-handicapping arm) was rejected by this
  // discriminatedUnion even though the server finalized fine, crashing the client's parse() on
  // any round containing an unrated golfer. All three kinds must round-trip through the wire.
  it("accepts a finalize response whose handicapping array mixes complete, unrated, and incomplete rows", () => {
    const response = {
      results: [{ kind: "stableford", id: "game-1", points: [] }],
      handicapping: [
        { golferId: "ann", kind: "complete", ags: 88, differential: 12.4 },
        { golferId: "bo", kind: "unrated", ags: 91 },
        { golferId: "cam", kind: "incomplete" },
      ],
    };
    expect(parse(finalizeRoundResponseSchema, response)).toEqual(response);
  });
});
