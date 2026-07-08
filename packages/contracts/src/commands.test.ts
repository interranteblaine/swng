import { describe, expect, it } from "vitest";
import type { CourseCard } from "@swng/domain";
import { ContractError, parse } from "./parse.js";
import {
  addGameRequestSchema,
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
