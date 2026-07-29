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

  // task-1 (pre-prod hardening, wire-ingress length/count bounds): every user-supplied string
  // gets a .max() at the request boundary.
  it("rejects an over-long tee name", () => {
    expect(() =>
      parse(startRoundRequestSchema, {
        course,
        host: { tee: "x".repeat(41), courseHandicap: 10 },
      }),
    ).toThrow();
  });

  // Widened from the original [-10, 54] (fix wave, post-review): WHS Rule 6.1a's own formula
  // (Index × Slope/113 + (Rating − Par)) puts a legitimate max-index (54.0) player on a
  // max-slope (155) course's course handicap near 74 before the rating term — [-10, 54]
  // rejected real players. [-20, 100] is the new plausibility bound.
  it("rejects a courseHandicap outside [-20, 100]", () => {
    expect(() => parse(startRoundRequestSchema, { course, host: { tee: "white", courseHandicap: 101 } })).toThrow(ContractError);
    expect(() => parse(startRoundRequestSchema, { course, host: { tee: "white", courseHandicap: -21 } })).toThrow(ContractError);
  });

  it("accepts a courseHandicap at the [-20, 100] boundary", () => {
    expect(() => parse(startRoundRequestSchema, { course, host: { tee: "white", courseHandicap: 100 } })).not.toThrow();
    expect(() => parse(startRoundRequestSchema, { course, host: { tee: "white", courseHandicap: -20 } })).not.toThrow();
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
  // "AB2345" (not "ABC123"): task-1's regex bound excludes 0/O/1/I/L from the join-code
  // alphabet, and "1" isn't a character the real minting alphabet ever produces.
  it("accepts a valid join-round request", () => {
    const request = { code: "AB2345", tee: "white", courseHandicap: 2 };
    expect(parse(joinRoundRequestSchema, request)).toEqual(request);
  });

  it("rejects a code that isn't exactly 6 characters", () => {
    const request = { code: "ABC12", tee: "white", courseHandicap: 2 };
    expect(() => parse(joinRoundRequestSchema, request)).toThrow(ContractError);
  });

  it("rejects a non-integer courseHandicap", () => {
    const request = { code: "AB2345", tee: "white", courseHandicap: 2.5 };
    expect(() => parse(joinRoundRequestSchema, request)).toThrow(ContractError);
  });

  // task-1 (pre-prod hardening): the join-code alphabet excludes visually-ambiguous
  // characters (0/O/1/I/L) — see compositionRoot.ts's JOIN_CODE_ALPHABET, the real minting
  // alphabet this regex mirrors exactly.
  it("rejects a join code with a character outside the safe alphabet", () => {
    expect(() => parse(joinRoundRequestSchema, { code: "ABC0O1", tee: "White", courseHandicap: 10 })).toThrow(); // 0/O/1 are excluded from the join-code alphabet
  });

  it("rejects an over-long tee name", () => {
    expect(() => parse(joinRoundRequestSchema, { code: "AB2345", tee: "x".repeat(41), courseHandicap: 2 })).toThrow(ContractError);
  });

  // Widened from the original [-10, 54] — see startRoundRequestSchema's own comment above for
  // the WHS 6.1a derivation of [-20, 100].
  it("rejects a courseHandicap outside [-20, 100]", () => {
    expect(() => parse(joinRoundRequestSchema, { code: "AB2345", tee: "white", courseHandicap: 101 })).toThrow(ContractError);
    expect(() => parse(joinRoundRequestSchema, { code: "AB2345", tee: "white", courseHandicap: -21 })).toThrow(ContractError);
  });

  it("accepts a courseHandicap at the [-20, 100] boundary", () => {
    expect(() => parse(joinRoundRequestSchema, { code: "AB2345", tee: "white", courseHandicap: 100 })).not.toThrow();
    expect(() => parse(joinRoundRequestSchema, { code: "AB2345", tee: "white", courseHandicap: -20 })).not.toThrow();
  });

  // NOT `.strict()`: an old client still sending name / golferId strips silently.
  it("strips the deleted name / golferId fields rather than rejecting them", () => {
    const request = { code: "AB2345", name: "Bo", tee: "white", courseHandicap: 2, golferId: "g-1" };
    const parsed = parse(joinRoundRequestSchema, request);
    expect(parsed).not.toHaveProperty("name");
    expect(parsed).not.toHaveProperty("golferId");
    expect(parsed).toEqual({ code: "AB2345", tee: "white", courseHandicap: 2 });
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

  // task-1 (pre-prod hardening): a round has at most 18 holes.
  it("rejects hole 19 (above the 18-hole bound)", () => {
    const request = { ...base, hole: 19 };
    expect(() => parse(recordScoreRequestSchema, request)).toThrow(ContractError);
  });

  it("accepts hole 18 (the boundary)", () => {
    const request = { ...base, hole: 18 };
    expect(() => parse(recordScoreRequestSchema, request)).not.toThrow();
  });

  // round.ts's holeResultSchema also backs roundEventSchema's stored/fold arm (score-recorded) —
  // this bound is applied to a request-ingress-only copy (see commands.ts), never to the shared
  // schema, so an already-stored strokes count is never rejected on read.
  it("rejects a strokes count above 30", () => {
    const request = { ...base, hole: 5, result: { kind: "strokes", strokes: 31 } };
    expect(() => parse(recordScoreRequestSchema, request)).toThrow(ContractError);
  });

  it("rejects a strokes count of 0 (must be at least 1)", () => {
    const request = { ...base, hole: 5, result: { kind: "strokes", strokes: 0 } };
    expect(() => parse(recordScoreRequestSchema, request)).toThrow(ContractError);
  });

  it("accepts a strokes count of exactly 30 (the boundary)", () => {
    const request = { ...base, hole: 5, result: { kind: "strokes", strokes: 30 } };
    expect(() => parse(recordScoreRequestSchema, request)).not.toThrow();
  });
});

describe("setHandicapRequestSchema", () => {
  it("setHandicapRequestSchema: accepts a negative (plus) value, rejects a non-integer", () => {
    expect(setHandicapRequestSchema.parse({ golferId: "g1", courseHandicap: -2 })).toEqual({ golferId: "g1", courseHandicap: -2 });
    expect(() => setHandicapRequestSchema.parse({ golferId: "g1", courseHandicap: 12.4 })).toThrow();
  });

  // Widened from the original [-10, 54] — see startRoundRequestSchema's own comment (commands.ts)
  // for the WHS 6.1a derivation of [-20, 100].
  it("rejects a course-handicap outside [-20, 100]", () => {
    expect(() => parse(setHandicapRequestSchema, { golferId: "g", courseHandicap: 101 })).toThrow();
  });

  it("rejects a course-handicap below -20", () => {
    expect(() => parse(setHandicapRequestSchema, { golferId: "g", courseHandicap: -21 })).toThrow();
  });

  it("accepts a course-handicap at the [-20, 100] boundary", () => {
    expect(() => parse(setHandicapRequestSchema, { golferId: "g", courseHandicap: 100 })).not.toThrow();
    expect(() => parse(setHandicapRequestSchema, { golferId: "g", courseHandicap: -20 })).not.toThrow();
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

  // task-1 (pre-prod hardening): a per-game players array is bounded to 12 at the request
  // boundary. round.ts's gameConfigFields — the shared field-set object — is left unbounded
  // because it also backs roundEventSchema's stored/fold arm (game-added); this bound is
  // applied ONLY to the request-ingress copies below (see commands.ts's *ConfigInputSchema
  // overrides), never to a schema that parses an already-stored event.
  const players13 = Array.from({ length: 13 }, (_, index) => `p${index}`);
  const players12 = Array.from({ length: 12 }, (_, index) => `p${index}`);

  it.each([
    ["stroke-play", { kind: "stroke-play", scoring: "gross", players: players13 }],
    ["stableford", { kind: "stableford", players: players13 }],
    ["skins", { kind: "skins", scoring: "net", players: players13 }],
  ])("rejects a %s game with more than 12 players", (_kind, config) => {
    expect(() => parse(gameConfigInputSchema, config)).toThrow(ContractError);
  });

  it("accepts exactly 12 players (the boundary)", () => {
    expect(() => parse(gameConfigInputSchema, { kind: "skins", scoring: "net", players: players12 })).not.toThrow();
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
