import { describe, expect, it } from "vitest";
import type { CourseCard } from "@swng/domain";
import { ContractError, parse } from "./parse.js";
import {
  MAX_STROKES,
  addGameRequestSchema,
  finalizeRoundResponseSchema,
  gameConfigInputSchema,
  joinRoundRequestSchema,
  recordScoreRequestSchema,
  setStrokesRequestSchema,
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
  // §3): the creator seat is always as-self from the caller's Bearer, so host carries only a tee.
  // No host.name (the golfer record's name is frozen into the event server-side), no golferId, no
  // players[], and — spec 2026-07-30 §9 — no question about the creator's game: strokes start at 0
  // and are typed onto the roster.
  it("accepts a valid start-round request", () => {
    const request = { course, host: { tee: "white" } };
    expect(parse(startRoundRequestSchema, request)).toEqual(request);
  });

  // task-1 (pre-prod hardening, wire-ingress length/count bounds): every user-supplied string
  // gets a .max() at the request boundary.
  it("rejects an over-long tee name", () => {
    expect(() => parse(startRoundRequestSchema, { course, host: { tee: "x".repeat(41) } })).toThrow();
  });

  // Course-cards spec invariant 4/5: the client can never author a card — the old `card:` shape
  // is GONE, not tolerated. A request still shaped the old way (a full card, no `course`
  // reference) is rejected as invalid, not silently accepted.
  it("rejects the old card: shape — a client can never author a card", () => {
    const request = { card, host: { tee: "white" } };
    expect(() => parse(startRoundRequestSchema, request)).toThrow(ContractError);
  });

  // The schema isn't `.strict()`, so an OLD client still sending the deleted identity fields
  // (host.name / host.basis / golferId / players / crewId) isn't rejected — Zod's default strips
  // the unknown keys silently, leaving exactly the accounts-only shape.
  it("strips deleted/old-client fields (host.name, host.basis, golferId, players, crewId) rather than rejecting them", () => {
    const request = {
      course,
      host: { name: "Ann", tee: "white", basis: { kind: "normally-shoots", overPar: 8 } },
      golferId: "ann-1",
      players: [{ name: "Bo", tee: "white" }],
      crewId: "crew-1",
    };
    const parsed = parse(startRoundRequestSchema, request);
    expect(parsed).not.toHaveProperty("golferId");
    expect(parsed).not.toHaveProperty("players");
    expect(parsed).not.toHaveProperty("crewId");
    expect(parsed.host).not.toHaveProperty("name");
    expect(parsed.host).not.toHaveProperty("basis");
    expect(parsed).toEqual({ course, host: { tee: "white" } });
  });
});

describe("joinRoundRequestSchema", () => {
  // Accounts-only identity (spec §3): join is always as-self — and, spec 2026-07-30 §9, it asks
  // nothing about your game either, so the whole request is code + tee.
  // "AB2345" (not "ABC123"): task-1's regex bound excludes 0/O/1/I/L from the join-code
  // alphabet, and "1" isn't a character the real minting alphabet ever produces.
  it("accepts a valid join-round request", () => {
    const request = { code: "AB2345", tee: "white" };
    expect(parse(joinRoundRequestSchema, request)).toEqual(request);
  });

  it("rejects a code that isn't exactly 6 characters", () => {
    expect(() => parse(joinRoundRequestSchema, { code: "ABC12", tee: "white" })).toThrow(ContractError);
  });

  // task-1 (pre-prod hardening): the join-code alphabet excludes visually-ambiguous
  // characters (0/O/1/I/L) — see compositionRoot.ts's JOIN_CODE_ALPHABET, the real minting
  // alphabet this regex mirrors exactly.
  it("rejects a join code with a character outside the safe alphabet", () => {
    expect(() => parse(joinRoundRequestSchema, { code: "ABC0O1", tee: "White" })).toThrow(); // 0/O/1 are excluded from the join-code alphabet
  });

  it("rejects an over-long tee name", () => {
    expect(() => parse(joinRoundRequestSchema, { code: "AB2345", tee: "x".repeat(41) })).toThrow(ContractError);
  });

  // NOT `.strict()`: an old client still sending name / golferId / basis strips silently.
  it("strips the deleted name / golferId / basis fields rather than rejecting them", () => {
    const request = { code: "AB2345", name: "Bo", tee: "white", basis: { kind: "normally-shoots", overPar: 2 }, golferId: "g-1" };
    const parsed = parse(joinRoundRequestSchema, request);
    expect(parsed).not.toHaveProperty("name");
    expect(parsed).not.toHaveProperty("golferId");
    expect(parsed).not.toHaveProperty("basis");
    expect(parsed).toEqual({ code: "AB2345", tee: "white" });
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

  // task-1's placement rule (commands.ts's own comment) also applies to `strokes` itself:
  // fractional stroke counts are nonsense on a scorecard — `.int()` on the request-ingress copy
  // rejects them without touching the stored/fold schema (round.ts), same split as the bound above.
  it("rejects a fractional strokes count", () => {
    const request = { ...base, hole: 5, result: { kind: "strokes", strokes: 4.5 } };
    expect(() => parse(recordScoreRequestSchema, request)).toThrow(ContractError);
  });

  // There is no "conceded" arm (task-1, spec §7) — a gimme is recorded as a plain `strokes` cell.
  it("rejects a conceded result outright", () => {
    const request = { ...base, hole: 5, result: { kind: "conceded", strokes: 4 } };
    expect(() => parse(recordScoreRequestSchema, request)).toThrow(ContractError);
  });
});

describe("setStrokesRequestSchema", () => {
  it("accepts a non-negative integer and rejects a fractional one", () => {
    const request = { golferId: "g1", strokes: 20 };
    expect(setStrokesRequestSchema.parse(request)).toEqual(request);
    expect(() => setStrokesRequestSchema.parse({ golferId: "g1", strokes: 12.4 })).toThrow();
  });

  // min(0) is a MODEL invariant reaching the wire (spec 2026-07-30 §2): nobody gives strokes
  // back, and the card renders dots as `"●".repeat(strokes)`.
  it("rejects a negative strokes count", () => {
    expect(() => parse(setStrokesRequestSchema, { golferId: "g", strokes: -1 })).toThrow(ContractError);
  });

  // MAX_STROKES is a plausibility limit with real margin, not a golf rule — a nonsense filter that
  // must not refuse a pairing somebody actually plays (whole-branch review Minor 7: it was 54,
  // which rejects a beginner off a scratch anchor, the exact anti-pattern Arc A corrected on the
  // same number). Written against the constant so the ceiling and its pin can never drift.
  it("rejects a strokes count above MAX_STROKES and accepts the boundary", () => {
    expect(() => parse(setStrokesRequestSchema, { golferId: "g", strokes: MAX_STROKES + 1 })).toThrow(ContractError);
    expect(() => parse(setStrokesRequestSchema, { golferId: "g", strokes: MAX_STROKES })).not.toThrow();
    expect(() => parse(setStrokesRequestSchema, { golferId: "g", strokes: 0 })).not.toThrow();
    // The value the ceiling exists to admit: a raw difference bigger than any course handicap.
    expect(() => parse(setStrokesRequestSchema, { golferId: "g", strokes: 58 })).not.toThrow();
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

  // The other direction of the same split: skins' `scoring` is `.default("net")` on the shared field
  // set so a legacy STORED game-added event still parses (round.test.ts pins that), and REQUIRED
  // here so a client proposing a NEW skins game has to say which pot it is rather than silently
  // getting net. A default on the request path would make the choice unaskable.
  it("rejects a skins game submitted with no scoring — the request must name the pot", () => {
    expect(() => parse(gameConfigInputSchema, { kind: "skins", players: ["a", "b"] })).toThrow(ContractError);
    expect(() => parse(gameConfigInputSchema, { kind: "skins", scoring: "gross", players: ["a", "b"] })).not.toThrow();
  });
});

describe("finalizeRoundResponseSchema", () => {
  // `handicapping` (per-participant adjusted gross score + differential) is DELETED with the whole
  // WHS pipeline (spec 2026-07-29 §7) — a finalize response is now the settled game results and
  // nothing else. The non-strict response schema drops a legacy field rather than rejecting it, so
  // a new bundle against a not-yet-redeployed lambda still parses.
  it("round-trips the settled results, and strips a legacy handicapping array", () => {
    const results = [{ kind: "stableford", id: "game-1", points: [] }];
    expect(parse(finalizeRoundResponseSchema, { results })).toEqual({ results });
    expect(parse(finalizeRoundResponseSchema, { results, handicapping: [{ golferId: "ann", kind: "incomplete" }] })).toEqual({ results });
  });
});
