import { describe, expect, it } from "vitest";
import type { CourseCard } from "@swng/domain";
import { golferId } from "@swng/domain";
import { ContractError, parse } from "./parse.js";
import {
  addGameRequestSchema,
  addParticipantRequestSchema,
  gameConfigInputSchema,
  joinRoundRequestSchema,
  recordScoreRequestSchema,
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
  it("accepts a valid start-round request", () => {
    const request = { card, host: { name: "Ann", tee: "white", courseHandicap: 8 } };
    expect(parse(startRoundRequestSchema, request)).toEqual(request);
  });

  it("rejects a non-integer courseHandicap", () => {
    const request = { card, host: { name: "Ann", tee: "white", courseHandicap: 8.5 } };
    expect(() => parse(startRoundRequestSchema, request)).toThrow(ContractError);
  });

  // As-self create (golferId) and an initial roster beyond the host (players) — both optional,
  // round-tripped together to pin that neither gets silently dropped nor disturbs the other.
  // No crewId: round-is-a-sealed-leaf, a round never tags itself with a crew.
  it("round-trips golferId and an initial players roster", () => {
    const request = {
      card,
      host: { name: "Ann", tee: "white", courseHandicap: 8 },
      golferId: golferId("ann-1"),
      players: [
        { name: "Bo", tee: "white", courseHandicap: 2, golferId: golferId("bo-1") },
        { name: "Cal", tee: "white", courseHandicap: 10 },
      ],
    };
    expect(parse(startRoundRequestSchema, request)).toEqual(request);
  });

  // An OLD client still sending a crewId (M8 wire) must not be rejected — the schema isn't
  // `.strict()`, so Zod's default strips the unknown key. The parsed request has no crewId.
  it("strips a stray crewId from an old-client body rather than rejecting it", () => {
    const request = { card, host: { name: "Ann", tee: "white", courseHandicap: 8 }, crewId: "crew-1" };
    const parsed = parse(startRoundRequestSchema, request);
    expect(parsed).not.toHaveProperty("crewId");
    expect(parsed).toMatchObject({ host: { name: "Ann" } });
  });

  // M8 close-out fix #4: StartRound appends 2 TransactWriteItems per event (EVT + OPID Put,
  // createDynamoEventJournal.ts) and DynamoDB caps a single transaction at 100 items — an
  // unbounded `players` array could grow the event batch (round-created + host-joined +
  // round-started + one participant-joined per player) past that cap and 500 instead of
  // giving the caller an honest 400. `.max(40)` stays comfortably clear (40 players is 86
  // items, well under 100) while being far beyond any realistic roster.
  it("rejects a players roster over the cap", () => {
    const request = {
      card,
      host: { name: "Ann", tee: "white", courseHandicap: 8 },
      players: Array.from({ length: 41 }, (_, i) => ({ name: `Player ${i}`, tee: "white", courseHandicap: 0 })),
    };
    expect(() => parse(startRoundRequestSchema, request)).toThrow(ContractError);
  });

  it("accepts a players roster right at the cap", () => {
    const request = {
      card,
      host: { name: "Ann", tee: "white", courseHandicap: 8 },
      players: Array.from({ length: 40 }, (_, i) => ({ name: `Player ${i}`, tee: "white", courseHandicap: 0 })),
    };
    expect(parse(startRoundRequestSchema, request)).toEqual(request);
  });
});

describe("joinRoundRequestSchema", () => {
  it("accepts a valid join-round request", () => {
    const request = { code: "ABC123", name: "Bo", tee: "white", courseHandicap: 2 };
    expect(parse(joinRoundRequestSchema, request)).toEqual(request);
  });

  it("rejects an empty name", () => {
    const request = { code: "ABC123", name: "", tee: "white", courseHandicap: 2 };
    expect(() => parse(joinRoundRequestSchema, request)).toThrow(ContractError);
  });

  it("rejects a code that isn't exactly 6 characters", () => {
    const request = { code: "ABC12", name: "Bo", tee: "white", courseHandicap: 2 };
    expect(() => parse(joinRoundRequestSchema, request)).toThrow(ContractError);
  });

  // Task 5b (ghost continuity, .superpowers/sdd/task-5b-brief.md): a joiner may present an
  // existing GolferId so the SAME ghost can recur across rounds. Round-tripping the whole
  // object (not just checking golferId is present) pins that the optional field neither gets
  // silently dropped nor mutates any of the other four.
  it("accepts a valid join-round request that supplies an existing golferId", () => {
    const request = { code: "ABC123", name: "Bo", tee: "white", courseHandicap: 2, golferId: "g-1" };
    expect(parse(joinRoundRequestSchema, request)).toEqual(request);
  });

  it("rejects an empty golferId when one is supplied", () => {
    const request = { code: "ABC123", name: "Bo", tee: "white", courseHandicap: 2, golferId: "" };
    expect(() => parse(joinRoundRequestSchema, request)).toThrow(ContractError);
  });
});

describe("addParticipantRequestSchema", () => {
  it("accepts a valid add-participant request with no golferId", () => {
    const request = { name: "Cal", tee: "white", courseHandicap: 10 };
    expect(parse(addParticipantRequestSchema, request)).toEqual(request);
  });

  it("round-trips a request supplying an existing golferId", () => {
    const request = { name: "Cal", tee: "white", courseHandicap: 10, golferId: golferId("ghost-1") };
    expect(parse(addParticipantRequestSchema, request)).toEqual(request);
  });

  it("rejects an empty name", () => {
    const request = { name: "", tee: "white", courseHandicap: 10 };
    expect(() => parse(addParticipantRequestSchema, request)).toThrow(ContractError);
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
