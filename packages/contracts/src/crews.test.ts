import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { crewId, golferId, roundId } from "@swng/domain";
import { ContractError, parse } from "./parse.js";
import {
  appendCountedRoundRequestSchema,
  createCrewRequestSchema,
  createSeasonRequestSchema,
  createSeasonResponseSchema,
  crewRecordsResponseSchema,
  crewViewSchema,
  getCrewResponseSchema,
  joinCrewRequestSchema,
  listMyCrewsResponseSchema,
  listSeasonsResponseSchema,
  mintCrewInviteResponseSchema,
  peekCrewInviteRequestSchema,
  peekCrewInviteResponseSchema,
  seasonStandingsResponseSchema,
  transferOrganizerRequestSchema,
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

// Crew membership (invited in, accountable out — spec §2): the permanent join code is GONE —
// mintCrewInviteResponseSchema/peekCrewInviteRequestSchema/peekCrewInviteResponseSchema/
// joinCrewRequestSchema (below) are the whole "in" wire surface now. addCrewMemberRequestSchema
// died with addCrewMember.ts — there is no add-by-id path left (spec §3).
describe("mintCrewInviteResponseSchema", () => {
  it("round-trips a minted invite (token + expiresAtMs)", () => {
    roundTrips(mintCrewInviteResponseSchema, { token: "signed-token-1", expiresAtMs: 1_700_000_000_000 });
  });
});

describe("peekCrewInviteRequestSchema / peekCrewInviteResponseSchema", () => {
  it("round-trips a peek request (bare token), rejects an extra field (.strict())", () => {
    roundTrips(peekCrewInviteRequestSchema, { token: "signed-token-1" });
    expect(() => parse(peekCrewInviteRequestSchema, { token: "signed-token-1", crewId: "sneaky" })).toThrow(ContractError);
  });

  it("round-trips the consent-screen preview (crewName + memberCount + inviterName)", () => {
    roundTrips(peekCrewInviteResponseSchema, { crewName: "Sunday Skins", memberCount: 8, inviterName: "Al" });
  });
});

describe("joinCrewRequestSchema", () => {
  it("round-trips a valid join-by-invite request (bare token)", () => {
    roundTrips(joinCrewRequestSchema, { token: "signed-token-1" });
  });

  it("rejects an extra field (.strict()) — e.g. a client proposing a code", () => {
    expect(() => parse(joinCrewRequestSchema, { token: "signed-token-1", code: "ABC123" })).toThrow(ContractError);
  });
});

describe("crewViewSchema (via getCrewResponseSchema)", () => {
  it("round-trips a crew with members carrying claimed true and false", () => {
    roundTrips(getCrewResponseSchema, {
      crew: {
        crewId: crewId("crew-1"),
        name: "Sunday Skins",
        members: [
          { golferId: golferId("ann"), name: "Ann", role: "organizer", claimed: true },
          { golferId: golferId("ghost-1"), name: "Cal", role: "member", claimed: false },
        ],
      },
    });
  });

  // crewViewSchema isn't `.strict()` (that discipline is request-bodies-only — this file's own
  // house-style comment above createCrewRequestSchema) — a legacy `joinCode` on the wire is
  // silently stripped, never round-tripped back out, proving the permanent join code really is
  // gone from this shape rather than merely unused.
  it("strips a legacy joinCode field rather than round-tripping it — the permanent join code is gone", () => {
    const parsed = parse(getCrewResponseSchema, {
      crew: { crewId: crewId("crew-1"), name: "Sunday Skins", joinCode: "ABC123", members: [] },
    });
    expect(parsed).not.toHaveProperty("crew.joinCode");
    expect(parsed.crew).not.toHaveProperty("joinCode");
  });
});

describe("crewViewSchema — round-trips directly", () => {
  it("round-trips a bare crew view", () => {
    roundTrips(crewViewSchema, { crewId: crewId("crew-1"), name: "Sunday Skins", members: [] });
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

  it("createSeasonResponseSchema / listSeasonsResponseSchema round-trip a season view — open (no closedAtMs) and closed (both bounds)", () => {
    const open = { seasonId: "s-1", name: "2026", status: "open" as const, createdAtMs: 1_700_000_000_000, startsAtMs: 1_700_000_000_000 };
    roundTrips(createSeasonResponseSchema, { season: open });
    roundTrips(listSeasonsResponseSchema, { seasons: [open] });

    // crew-scoreboard spec §2: closedAtMs is optional, present only once a season has closed.
    const closed = { ...open, seasonId: "s-2", status: "closed" as const, closedAtMs: 1_710_000_000_000 };
    roundTrips(createSeasonResponseSchema, { season: closed });
    roundTrips(listSeasonsResponseSchema, { seasons: [open, closed] });
  });

  it("seasonStandingsResponseSchema round-trips scoreboard + ledger (with name) + head-to-head + rounds, partners empty", () => {
    roundTrips(seasonStandingsResponseSchema, {
      seasonId: "s-1",
      name: "2026",
      status: "closed",
      startsAtMs: 1_690_000_000_000,
      closedAtMs: 1_700_000_000_000,
      scoreboard: [{ golferId: golferId("ann"), name: "Ann", rounds: 1 }],
      rounds: [{ roundId: roundId("round-1"), finalizedAt: 1_700_000_000_000 }],
      ledger: [{ golferId: golferId("ann"), rounds: 1, wins: 1, losses: 0, halves: 0, points: 0, skins: 0, name: "Ann" }],
      headToHead: [{ a: golferId("ann"), b: golferId("bo"), aWins: 1, bWins: 0, halves: 0 }],
      partners: [],
    });
  });

  // crew-scoreboard spec §4: an OPEN season carries no closedAtMs at all (optional, not null),
  // and a scoreboard row's every optional (best18/netPer18/index/indexDelta) round-trips both
  // present (a full row) and absent (rounds-only — the dash-arm case the web renders "—" for).
  it("seasonStandingsResponseSchema round-trips a full scoreboard row and a bare rounds-only row; partners grow alongside", () => {
    roundTrips(seasonStandingsResponseSchema, {
      seasonId: "s-1",
      name: "2026",
      status: "open",
      startsAtMs: 1_690_000_000_000,
      scoreboard: [
        { golferId: golferId("ann"), name: "Ann", rounds: 4, best18: { gross: 82, toPar: 10 }, netPer18: 1.2, index: 14.1, indexDelta: -0.4 },
        { golferId: golferId("bo"), name: "Bo", rounds: 0 },
      ],
      rounds: [],
      ledger: [],
      headToHead: [],
      partners: [{ a: golferId("ann"), b: golferId("bo"), nameA: "Ann", nameB: "Bo", wins: 3, losses: 1, halves: 0 }],
    });
  });

  it("rejects a response missing partners", () => {
    expect(() =>
      parse(seasonStandingsResponseSchema, {
        seasonId: "s-1",
        name: "2026",
        status: "open",
        startsAtMs: 1_690_000_000_000,
        scoreboard: [],
        rounds: [],
        ledger: [],
        headToHead: [],
      }),
    ).toThrow(ContractError);
  });

  it("rejects a response missing scoreboard", () => {
    expect(() =>
      parse(seasonStandingsResponseSchema, {
        seasonId: "s-1",
        name: "2026",
        status: "open",
        startsAtMs: 1_690_000_000_000,
        rounds: [],
        ledger: [],
        headToHead: [],
        partners: [],
      }),
    ).toThrow(ContractError);
  });

  it("rejects a response missing startsAtMs", () => {
    expect(() =>
      parse(seasonStandingsResponseSchema, {
        seasonId: "s-1",
        name: "2026",
        status: "open",
        scoreboard: [],
        rounds: [],
        ledger: [],
        headToHead: [],
        partners: [],
      }),
    ).toThrow(ContractError);
  });
});

// GET /crews/{crewId}/records (analytics spec 2026-07-21 §5): all-time — dedupe-by-roundId is an
// application concern; this schema just carries the shape.
describe("crewRecordsResponseSchema", () => {
  it("round-trips an all-time records payload with titles", () => {
    roundTrips(crewRecordsResponseSchema, {
      rounds: 12,
      ledger: [{ golferId: golferId("ann"), rounds: 12, wins: 5, losses: 5, halves: 2, points: 430, skins: 54, name: "Ann" }],
      headToHead: [{ a: golferId("ann"), b: golferId("bo"), aWins: 5, bWins: 5, halves: 2 }],
      partners: [{ a: golferId("ann"), b: golferId("bo"), nameA: "Ann", nameB: "Bo", wins: 3, losses: 1, halves: 0 }],
      titles: [{ seasonId: "s-2025", name: "2025", golfers: [{ golferId: golferId("ann"), name: "Ann" }] }],
    });
  });

  it("round-trips an empty all-time records payload — no rounds, no titles", () => {
    roundTrips(crewRecordsResponseSchema, { rounds: 0, ledger: [], headToHead: [], partners: [], titles: [] });
  });
});

// Crew membership (invited in, accountable out — spec §1): the organizer's authority.
// DELETE /crews/{crewId}/members/{golferId} (remove) takes no body (golferId in path) — no
// schema to test here; POST /crews/{crewId}/transfer's body is transferOrganizerRequestSchema.
describe("transferOrganizerRequestSchema", () => {
  it("round-trips a valid transfer request", () => {
    roundTrips(transferOrganizerRequestSchema, { golferId: golferId("bo") });
  });

  it("rejects a server-assigned extra field (.strict())", () => {
    expect(() => parse(transferOrganizerRequestSchema, { golferId: "bo", role: "organizer" })).toThrow(ContractError);
  });
});
