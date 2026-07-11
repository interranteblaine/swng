import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { courseId, crewId, golferId } from "@swng/domain";
import { ContractError, parse } from "./parse.js";
import {
  addCrewMemberRequestSchema,
  createCrewRequestSchema,
  crewViewSchema,
  getCrewResponseSchema,
  joinCrewRequestSchema,
  listMyCrewsResponseSchema,
  saveStandingGameRequestSchema,
} from "./crews.js";

// parse(JSON.parse(JSON.stringify(x))) === x — the wire round-trip every schema here has to
// survive unchanged, same pattern as courses.test.ts / commands.test.ts.
const roundTrips = <S extends z.ZodType>(schema: S, value: z.infer<S>): void => {
  expect(parse(schema, JSON.parse(JSON.stringify(value)) as unknown)).toEqual(value);
};

describe("createCrewRequestSchema", () => {
  it("round-trips a valid create-crew request", () => {
    roundTrips(createCrewRequestSchema, { name: "Sunday Skins" });
  });

  it("rejects an empty name", () => {
    expect(() => parse(createCrewRequestSchema, { name: "" })).toThrow(ContractError);
  });

  it("rejects an extra field (.strict()) — e.g. a client proposing crewId", () => {
    expect(() => parse(createCrewRequestSchema, { name: "Sunday Skins", crewId: "sneaky" })).toThrow(ContractError);
  });
});

describe("addCrewMemberRequestSchema", () => {
  it("round-trips a valid add-member request", () => {
    roundTrips(addCrewMemberRequestSchema, { name: "Cal" });
  });

  it("rejects an extra field (.strict()) — e.g. a client proposing golferId", () => {
    expect(() => parse(addCrewMemberRequestSchema, { name: "Cal", golferId: "sneaky" })).toThrow(ContractError);
  });
});

describe("joinCrewRequestSchema", () => {
  it("round-trips a valid join-by-code request", () => {
    roundTrips(joinCrewRequestSchema, { code: "ABC123" });
  });

  it("rejects a code that isn't exactly 6 characters", () => {
    expect(() => parse(joinCrewRequestSchema, { code: "ABC12" })).toThrow(ContractError);
  });
});

describe("saveStandingGameRequestSchema", () => {
  it("round-trips a standing game with courseId/tee and a mixed set of id-less game configs", () => {
    roundTrips(saveStandingGameRequestSchema, {
      standingGame: {
        courseId: courseId("course-1"),
        tee: "white",
        games: [
          { kind: "stableford", players: [golferId("ann"), golferId("bo")] },
          { kind: "singles-match", a: golferId("ann"), b: golferId("bo") },
        ],
      },
    });
  });

  it("round-trips a bare standing game — no courseId/tee, no games yet", () => {
    roundTrips(saveStandingGameRequestSchema, { standingGame: { games: [] } });
  });

  it("rejects a game config carrying an id (.strict() reuse of gameConfigInputSchema) — the server assigns it", () => {
    expect(() =>
      parse(saveStandingGameRequestSchema, { standingGame: { games: [{ kind: "singles-match", id: "sneaky", a: "ann", b: "bo" }] } }),
    ).toThrow(ContractError);
  });

  it("rejects an extra top-level field (.strict())", () => {
    expect(() => parse(saveStandingGameRequestSchema, { standingGame: { games: [] }, crewId: "sneaky" })).toThrow(ContractError);
  });
});

describe("crewViewSchema (via getCrewResponseSchema)", () => {
  it("round-trips a crew with a mix of claimed/unclaimed members and no standing game", () => {
    roundTrips(getCrewResponseSchema, {
      crew: {
        crewId: crewId("crew-1"),
        name: "Sunday Skins",
        joinCode: "ABC123",
        members: [
          { golferId: golferId("ann"), name: "Ann", role: "organizer", claimed: true },
          { golferId: golferId("ghost-1"), name: "Cal", role: "member", claimed: false },
        ],
      },
    });
  });

  it("round-trips a crew carrying a standing game", () => {
    roundTrips(getCrewResponseSchema, {
      crew: {
        crewId: crewId("crew-1"),
        name: "Sunday Skins",
        joinCode: "ABC123",
        members: [{ golferId: golferId("ann"), name: "Ann", role: "organizer", claimed: true }],
        standingGame: { tee: "white", games: [{ kind: "skins", players: [golferId("ann"), golferId("bo")] }] },
      },
    });
  });
});

describe("crewViewSchema — round-trips directly", () => {
  it("round-trips a bare crew view", () => {
    roundTrips(crewViewSchema, { crewId: crewId("crew-1"), name: "Sunday Skins", joinCode: "ABC123", members: [] });
  });
});

describe("listMyCrewsResponseSchema", () => {
  it("round-trips a list of crew summaries", () => {
    roundTrips(listMyCrewsResponseSchema, {
      crews: [
        { crewId: crewId("crew-1"), name: "Sunday Skins", memberCount: 4 },
        { crewId: crewId("crew-2"), name: "Wednesday Nine", memberCount: 2 },
      ],
    });
  });

  it("round-trips an empty list", () => {
    roundTrips(listMyCrewsResponseSchema, { crews: [] });
  });
});
