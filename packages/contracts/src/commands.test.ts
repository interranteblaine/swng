import { describe, expect, it } from "vitest";
import type { CourseCard } from "@swng/domain";
import { ContractError, parse } from "./parse.js";
import {
  addGameRequestSchema,
  finalizeRoundResponseSchema,
  gameConfigInputSchema,
  joinRoundRequestSchema,
  recordScoreRequestSchema,
  setBasisRequestSchema,
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
  // tee/basis. No host.name (the golfer record's name is frozen into the event server-side), no
  // golferId, no players[].
  it("accepts a valid start-round request", () => {
    const request = { course, host: { tee: "white", basis: { kind: "normally-shoots", overPar: 8 } } };
    expect(parse(startRoundRequestSchema, request)).toEqual(request);
  });

  it("rejects a non-integer overPar", () => {
    const request = { course, host: { tee: "white", basis: { kind: "normally-shoots", overPar: 8.5 } } };
    expect(() => parse(startRoundRequestSchema, request)).toThrow(ContractError);
  });

  // task-1 (pre-prod hardening, wire-ingress length/count bounds): every user-supplied string
  // gets a .max() at the request boundary.
  it("rejects an over-long tee name", () => {
    expect(() =>
      parse(startRoundRequestSchema, {
        course,
        host: { tee: "x".repeat(41), basis: { kind: "normally-shoots", overPar: 10 } },
      }),
    ).toThrow();
  });

  // [-20, 100] is a plausibility bound on what a golfer can state they normally shoot, not a golf
  // rule — a century over par on 18 holes is already absurd, and 20 under is well past the best
  // round ever played (spec 2026-07-29 §2a).
  it("rejects an overPar outside [-20, 100]", () => {
    expect(() => parse(startRoundRequestSchema, { course, host: { tee: "white", basis: { kind: "normally-shoots", overPar: 101 } } })).toThrow(ContractError);
    expect(() => parse(startRoundRequestSchema, { course, host: { tee: "white", basis: { kind: "normally-shoots", overPar: -21 } } })).toThrow(ContractError);
  });

  it("accepts an overPar at the [-20, 100] boundary", () => {
    expect(() => parse(startRoundRequestSchema, { course, host: { tee: "white", basis: { kind: "normally-shoots", overPar: 100 } } })).not.toThrow();
    expect(() => parse(startRoundRequestSchema, { course, host: { tee: "white", basis: { kind: "normally-shoots", overPar: -20 } } })).not.toThrow();
  });

  // Course-cards spec invariant 4/5: the client can never author a card — the old `card:` shape
  // is GONE, not tolerated. A request still shaped the old way (a full card, no `course`
  // reference) is rejected as invalid, not silently accepted.
  it("rejects the old card: shape — a client can never author a card", () => {
    const request = { card, host: { tee: "white", basis: { kind: "normally-shoots", overPar: 8 } } };
    expect(() => parse(startRoundRequestSchema, request)).toThrow(ContractError);
  });

  // The schema isn't `.strict()`, so an OLD client still sending the deleted identity fields
  // (host.name / golferId / players / crewId) isn't rejected — Zod's default strips the unknown
  // keys silently, leaving exactly the accounts-only shape.
  it("strips deleted/old-client fields (host.name, golferId, players, crewId) rather than rejecting them", () => {
    const request = {
      course,
      host: { name: "Ann", tee: "white", basis: { kind: "normally-shoots", overPar: 8 } },
      golferId: "ann-1",
      players: [{ name: "Bo", tee: "white", basis: { kind: "normally-shoots", overPar: 2 } }],
      crewId: "crew-1",
    };
    const parsed = parse(startRoundRequestSchema, request);
    expect(parsed).not.toHaveProperty("golferId");
    expect(parsed).not.toHaveProperty("players");
    expect(parsed).not.toHaveProperty("crewId");
    expect(parsed.host).not.toHaveProperty("name");
    expect(parsed).toEqual({ course, host: { tee: "white", basis: { kind: "normally-shoots", overPar: 8 } } });
  });
});

describe("joinRoundRequestSchema", () => {
  // Accounts-only identity (spec §3): join is always as-self — only code + tee + basis.
  // "AB2345" (not "ABC123"): task-1's regex bound excludes 0/O/1/I/L from the join-code
  // alphabet, and "1" isn't a character the real minting alphabet ever produces.
  it("accepts a valid join-round request", () => {
    const request = { code: "AB2345", tee: "white", basis: { kind: "normally-shoots", overPar: 2 } };
    expect(parse(joinRoundRequestSchema, request)).toEqual(request);
  });

  it("rejects a code that isn't exactly 6 characters", () => {
    const request = { code: "ABC12", tee: "white", basis: { kind: "normally-shoots", overPar: 2 } };
    expect(() => parse(joinRoundRequestSchema, request)).toThrow(ContractError);
  });

  it("rejects a non-integer overPar", () => {
    const request = { code: "AB2345", tee: "white", basis: { kind: "normally-shoots", overPar: 2.5 } };
    expect(() => parse(joinRoundRequestSchema, request)).toThrow(ContractError);
  });

  // Spec §2a: `strokes` is the SECOND constructor and is bounded at zero — the plus-handicap case
  // is unrepresentable, because under a relative model the anchor is the best player at 0 and
  // nobody gives strokes back.
  it("accepts a literal strokes basis, and rejects a negative one", () => {
    const given = { code: "AB2345", tee: "white", basis: { kind: "strokes", strokes: 18 } };
    expect(parse(joinRoundRequestSchema, given)).toEqual(given);
    expect(() => parse(joinRoundRequestSchema, { code: "AB2345", tee: "white", basis: { kind: "strokes", strokes: -1 } })).toThrow(ContractError);
  });

  it("rejects an unknown basis kind", () => {
    expect(() => parse(joinRoundRequestSchema, { code: "AB2345", tee: "white", basis: { kind: "index", value: 12.4 } })).toThrow(ContractError);
  });

  // task-1 (pre-prod hardening): the join-code alphabet excludes visually-ambiguous
  // characters (0/O/1/I/L) — see compositionRoot.ts's JOIN_CODE_ALPHABET, the real minting
  // alphabet this regex mirrors exactly.
  it("rejects a join code with a character outside the safe alphabet", () => {
    expect(() => parse(joinRoundRequestSchema, { code: "ABC0O1", tee: "White", basis: { kind: "normally-shoots", overPar: 10 } })).toThrow(); // 0/O/1 are excluded from the join-code alphabet
  });

  it("rejects an over-long tee name", () => {
    expect(() => parse(joinRoundRequestSchema, { code: "AB2345", tee: "x".repeat(41), basis: { kind: "normally-shoots", overPar: 2 } })).toThrow(ContractError);
  });

  // See startRoundRequestSchema's own comment above for where [-20, 100] comes from.
  it("rejects an overPar outside [-20, 100]", () => {
    expect(() => parse(joinRoundRequestSchema, { code: "AB2345", tee: "white", basis: { kind: "normally-shoots", overPar: 101 } })).toThrow(ContractError);
    expect(() => parse(joinRoundRequestSchema, { code: "AB2345", tee: "white", basis: { kind: "normally-shoots", overPar: -21 } })).toThrow(ContractError);
  });

  it("accepts an overPar at the [-20, 100] boundary", () => {
    expect(() => parse(joinRoundRequestSchema, { code: "AB2345", tee: "white", basis: { kind: "normally-shoots", overPar: 100 } })).not.toThrow();
    expect(() => parse(joinRoundRequestSchema, { code: "AB2345", tee: "white", basis: { kind: "normally-shoots", overPar: -20 } })).not.toThrow();
  });

  // NOT `.strict()`: an old client still sending name / golferId strips silently.
  it("strips the deleted name / golferId fields rather than rejecting them", () => {
    const request = { code: "AB2345", name: "Bo", tee: "white", basis: { kind: "normally-shoots", overPar: 2 }, golferId: "g-1" };
    const parsed = parse(joinRoundRequestSchema, request);
    expect(parsed).not.toHaveProperty("name");
    expect(parsed).not.toHaveProperty("golferId");
    expect(parsed).toEqual({ code: "AB2345", tee: "white", basis: { kind: "normally-shoots", overPar: 2 } });
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

  // Conceded now carries the score the group says out loud (task-2, spec §2d), bounded the same
  // way `strokes` is (commands.ts's scoreResultInputArms — mirrors the three cases above).
  it("rejects a conceded strokes count above 30", () => {
    const request = { ...base, hole: 5, result: { kind: "conceded", strokes: 31 } };
    expect(() => parse(recordScoreRequestSchema, request)).toThrow(ContractError);
  });

  it("rejects a conceded strokes count of 0 (must be at least 1)", () => {
    const request = { ...base, hole: 5, result: { kind: "conceded", strokes: 0 } };
    expect(() => parse(recordScoreRequestSchema, request)).toThrow(ContractError);
  });

  it("accepts a conceded strokes count of exactly 30 (the boundary)", () => {
    const request = { ...base, hole: 5, result: { kind: "conceded", strokes: 30 } };
    expect(() => parse(recordScoreRequestSchema, request)).not.toThrow();
  });

  it("rejects a fractional conceded strokes count", () => {
    const request = { ...base, hole: 5, result: { kind: "conceded", strokes: 4.5 } };
    expect(() => parse(recordScoreRequestSchema, request)).toThrow(ContractError);
  });

  it("rejects a bare conceded result with no strokes number at all", () => {
    const request = { ...base, hole: 5, result: { kind: "conceded" } };
    expect(() => parse(recordScoreRequestSchema, request)).toThrow(ContractError);
  });
});

describe("setBasisRequestSchema", () => {
  it("accepts an under-par normal score, rejects a non-integer", () => {
    const under = { golferId: "g1", basis: { kind: "normally-shoots" as const, overPar: -2 } };
    expect(setBasisRequestSchema.parse(under)).toEqual(under);
    expect(() => setBasisRequestSchema.parse({ golferId: "g1", basis: { kind: "normally-shoots", overPar: 12.4 } })).toThrow();
  });

  // Widened from the original [-10, 54] — see startRoundRequestSchema's own comment (commands.ts)
  // for the WHS 6.1a derivation of [-20, 100].
  it("rejects an overPar outside [-20, 100]", () => {
    expect(() => parse(setBasisRequestSchema, { golferId: "g", basis: { kind: "normally-shoots", overPar: 101 } })).toThrow();
  });

  it("rejects an overPar below -20", () => {
    expect(() => parse(setBasisRequestSchema, { golferId: "g", basis: { kind: "normally-shoots", overPar: -21 } })).toThrow();
  });

  it("accepts an overPar at the [-20, 100] boundary", () => {
    expect(() => parse(setBasisRequestSchema, { golferId: "g", basis: { kind: "normally-shoots", overPar: 100 } })).not.toThrow();
    expect(() => parse(setBasisRequestSchema, { golferId: "g", basis: { kind: "normally-shoots", overPar: -20 } })).not.toThrow();
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
