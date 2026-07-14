import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { crewId, golferId, roundId } from "@swng/domain";
import { ContractError, parse } from "./parse.js";
import {
  addCrewMemberRequestSchema,
  appendCountedRoundRequestSchema,
  createCrewRequestSchema,
  createSeasonRequestSchema,
  createSeasonResponseSchema,
  crewViewSchema,
  getCrewResponseSchema,
  joinCrewRequestSchema,
  listMyCrewsResponseSchema,
  listSeasonsResponseSchema,
  seasonStandingsResponseSchema,
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
  // De-ghost (architecture-realignment Task 9): a member is added by an EXISTING account
  // golfer's golferId, not a free-text name.
  it("round-trips a valid add-member request (by golferId)", () => {
    roundTrips(addCrewMemberRequestSchema, { golferId: golferId("cal-g") });
  });

  it("rejects an extra field (.strict()) — e.g. a client proposing a name", () => {
    expect(() => parse(addCrewMemberRequestSchema, { golferId: "cal-g", name: "Cal" })).toThrow(ContractError);
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

describe("crewViewSchema (via getCrewResponseSchema)", () => {
  it("round-trips a crew with members carrying claimed true and false", () => {
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

// Architecture-realignment Task 9/11: crew seasons + counted rounds + standings-on-read
// replaced GET /crews/{crewId}/records (and its own getCrewRecordsResponseSchema) entirely —
// seasonStandingsResponseSchema below is the one ledger/head-to-head wire shape left.
describe("season + standings schemas", () => {
  it("createSeasonRequestSchema rejects a server-assigned seasonId (.strict())", () => {
    roundTrips(createSeasonRequestSchema, { name: "Summer Cup" });
    expect(() => parse(createSeasonRequestSchema, { name: "Summer Cup", seasonId: "sneaky" })).toThrow(ContractError);
  });

  it("appendCountedRoundRequestSchema round-trips a roundId, rejects extras", () => {
    roundTrips(appendCountedRoundRequestSchema, { roundId: roundId("round-1") });
    expect(() => parse(appendCountedRoundRequestSchema, { roundId: "round-1", appendedBy: "sneaky" })).toThrow(ContractError);
  });

  it("createSeasonResponseSchema / listSeasonsResponseSchema round-trip a season view", () => {
    const season = { seasonId: "s-1", name: "2026", status: "open" as const, createdAtMs: 1_700_000_000_000 };
    roundTrips(createSeasonResponseSchema, { season });
    roundTrips(listSeasonsResponseSchema, { seasons: [season] });
  });

  it("seasonStandingsResponseSchema round-trips ledger (with name) + head-to-head + rounds", () => {
    roundTrips(seasonStandingsResponseSchema, {
      seasonId: "s-1",
      name: "2026",
      status: "closed",
      rounds: [{ roundId: roundId("round-1"), finalizedAt: 1_700_000_000_000, appendedBy: golferId("ann") }],
      ledger: [{ golferId: golferId("ann"), rounds: 1, wins: 1, losses: 0, halves: 0, points: 0, skins: 0, name: "Ann" }],
      headToHead: [{ a: golferId("ann"), b: golferId("bo"), aWins: 1, bWins: 0, halves: 0 }],
    });
  });
});
