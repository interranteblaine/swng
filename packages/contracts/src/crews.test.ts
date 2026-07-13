import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { courseId, crewId, golferId, roundId } from "@swng/domain";
import { ContractError, parse } from "./parse.js";
import {
  addCrewMemberRequestSchema,
  appendCountedRoundRequestSchema,
  createCrewRequestSchema,
  createSeasonRequestSchema,
  createSeasonResponseSchema,
  crewViewSchema,
  getCrewRecordsResponseSchema,
  getCrewResponseSchema,
  joinCrewRequestSchema,
  listMyCrewsResponseSchema,
  listSeasonsResponseSchema,
  saveStandingGameRequestSchema,
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

describe("getCrewRecordsResponseSchema", () => {
  it("round-trips a populated season's ledger + head-to-head", () => {
    roundTrips(getCrewRecordsResponseSchema, {
      season: 2026,
      ledger: [
        { golferId: golferId("ann"), rounds: 3, wins: 2, losses: 1, halves: 0, points: 0, skins: 0 },
        { golferId: golferId("bo"), rounds: 3, wins: 1, losses: 2, halves: 0, points: 0, skins: 0 },
      ],
      headToHead: [{ a: golferId("ann"), b: golferId("bo"), aWins: 2, bWins: 1, halves: 0 }],
    });
  });

  it("round-trips an empty season (no finalized rounds yet)", () => {
    roundTrips(getCrewRecordsResponseSchema, { season: 2026, ledger: [], headToHead: [] });
  });
});

// Architecture-realignment Task 9: crew seasons + counted rounds + standings-on-read.
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

  it("seasonStandingsResponseSchema round-trips ledger (with name + member) + head-to-head + rounds", () => {
    roundTrips(seasonStandingsResponseSchema, {
      seasonId: "s-1",
      name: "2026",
      status: "closed",
      rounds: [{ roundId: roundId("round-1"), finalizedAt: 1_700_000_000_000, appendedBy: golferId("ann") }],
      ledger: [{ golferId: golferId("ann"), rounds: 1, wins: 1, losses: 0, halves: 0, points: 0, skins: 0, name: "Ann", member: true }],
      headToHead: [{ a: golferId("ann"), b: golferId("bo"), aWins: 1, bWins: 0, halves: 0 }],
    });
  });
});
