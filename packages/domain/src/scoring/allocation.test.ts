import { describe, expect, it } from "vitest";
import { findTeeSet } from "../course/card.js";
import { gameId, golferId } from "../ids.js";
import type { GolferId } from "../ids.js";
import type { RosterEntry } from "../round/participant.js";
import { dotsByHole } from "./strokes.js";
import { fieldDeck18 } from "./golden/fieldDeck18.js";
import { fixtureLinks18 } from "./golden/fixtureCourse.js";
import { dotsForHoles, gameStrokeAllocation, roundStrokeAllocation, totalDots } from "./allocation.js";
import type { GameConfig } from "./game.js";

// The M5 field deck: strokes 6/0/13/3 (ann/bo/cal/dee), typed onto the roster. Hand-derived in the
// deck itself and pinned by fieldDeck18.test.ts against the match/skins engines — reused here as
// the orchestration oracle for gameStrokeAllocation.
const { players, fourball, skins } = fieldDeck18;
// Cast to a fixed-length tuple: fieldDeck18.players is a plain array as far as TS is
// concerned, so a bare destructure would otherwise type each element `GolferId |
// undefined` under noUncheckedIndexedAccess even though the deck's shape guarantees
// exactly these four.
const [ann, bo, cal, dee] = players.map((p) => p.golferId) as unknown as readonly [GolferId, GolferId, GolferId, GolferId];
const whiteTeeSet = findTeeSet(fixtureLinks18, "white");

// A roster seat: name and tee are incidental here, the number is the whole subject.
const p = (id: string, strokes: number): RosterEntry => ({ golferId: golferId(id), name: id, tee: "white", strokes });
const fieldRoster: readonly RosterEntry[] = players;

// Spec 2026-07-30 §3's own worked example: four players at 20/10/5/0, the 20 playing the 10.
const roster = [p("ann", 20), p("bo", 10), p("cy", 5), p("dee", 0)];

describe("gameStrokeAllocation", () => {
  it("a medal game uses each player's own number — it agrees with the card", () => {
    const allocation = gameStrokeAllocation(
      { kind: "stroke-play", id: gameId("g"), scoring: "net", players: [golferId("ann"), golferId("bo")] },
      roster,
      fixtureLinks18,
    );
    expect(totalDots(allocation.get(golferId("ann"))!)).toBe(20);
    expect(totalDots(allocation.get(golferId("bo"))!)).toBe(10);
  });

  it("a match is played off the difference, on the HARDEST holes", () => {
    const allocation = gameStrokeAllocation(
      { kind: "singles-match", id: gameId("m"), a: golferId("ann"), b: golferId("bo") },
      roster,
      fixtureLinks18,
    );
    expect(totalDots(allocation.get(golferId("ann"))!)).toBe(10);
    expect(totalDots(allocation.get(golferId("bo"))!)).toBe(0);
    // The ten shots land on stroke index 1-10 — not on SI 1, 2 and 11-18, which is what
    // subtracting two absolute allocations would have produced. This is the ONLY assertion in the
    // suite that distinguishes the two arms: the shot COUNT is identical either way.
    const anns = allocation.get(golferId("ann"))!;
    const dottedHoles = fixtureLinks18.teeSets[0]!.holes.filter((h) => (anns.get(h.number) ?? 0) > 0);
    expect(dottedHoles.every((h) => h.strokeIndex <= 10)).toBe(true);
    expect(dottedHoles).toHaveLength(10);
  });

  it("a four-ball puts all four off the lowest of the four", () => {
    const allocation = gameStrokeAllocation(
      { kind: "fourball-match", id: gameId("f"), a: [golferId("ann"), golferId("cy")], b: [golferId("bo"), golferId("dee")] },
      roster,
      fixtureLinks18,
    );
    expect(totalDots(allocation.get(golferId("ann"))!)).toBe(20);
    expect(totalDots(allocation.get(golferId("dee"))!)).toBe(0);
  });

  it("a medal game does NOT re-anchor on its own subset — bo keeps the card's 10 in a game with cy", () => {
    // The behaviour the prior arc had and this one deletes: a two-player net game between bo (10)
    // and cy (5) once made bo play off cy, showing 5 dots where the card showed 10.
    const allocation = gameStrokeAllocation(
      { kind: "stroke-play", id: gameId("subset"), scoring: "net", players: [golferId("bo"), golferId("cy")] },
      roster,
      fixtureLinks18,
    );
    expect(totalDots(allocation.get(golferId("bo"))!)).toBe(10);
    expect(totalDots(allocation.get(golferId("cy"))!)).toBe(5);
  });

  it("allocates nothing for a gross game", () => {
    const allocation = gameStrokeAllocation(
      { kind: "skins", id: gameId("g2"), scoring: "gross", players: [golferId("bo"), golferId("cy")] },
      roster,
      fixtureLinks18,
    );
    expect(allocation.size).toBe(0);
  });

  it("fourball: dots relative to the lowest in the field (Bo) — 6/0/13/3 by SI", () => {
    const allocation = gameStrokeAllocation(fourball, fieldRoster, fixtureLinks18);
    const expectedRelative: Readonly<Record<string, number>> = { [ann]: 6, [bo]: 0, [cal]: 13, [dee]: 3 };
    for (const [id, relative] of Object.entries(expectedRelative)) {
      expect(allocation.get(golferId(id))).toEqual(dotsByHole(relative, whiteTeeSet.holes));
    }
  });

  it("skins: the SAME allocation as the fourball on this deck — Bo is on 0, so absolute and relative coincide", () => {
    const allocation = gameStrokeAllocation(skins, fieldRoster, fixtureLinks18);
    const expectedAbsolute: Readonly<Record<string, number>> = { [ann]: 6, [bo]: 0, [cal]: 13, [dee]: 3 };
    for (const [id, absolute] of Object.entries(expectedAbsolute)) {
      expect(allocation.get(golferId(id))).toEqual(dotsByHole(absolute, whiteTeeSet.holes));
    }
  });

  it("a >=19 relative allocation wraps past a full lap: SI 1 gets 2 dots", () => {
    // A difference of 22 over 18 holes is 1 dot everywhere plus 4 extra on SI 1-4 (holes 2, 10,
    // 7, 13).
    const low = golferId("low");
    const high = golferId("high");
    const other = golferId("other-a");
    const other2 = golferId("other-b");
    const fourParticipants: readonly RosterEntry[] = [p("low", 0), p("high", 22), p("other-a", 5), p("other-b", 5)];
    const wideFourball: Extract<GameConfig, { kind: "fourball-match" }> = {
      kind: "fourball-match",
      id: gameId("wide"),
      a: [low, high],
      b: [other, other2],
    };
    const allocation = gameStrokeAllocation(wideFourball, fourParticipants, fixtureLinks18);
    expect(allocation.get(low)).toEqual(dotsByHole(0, whiteTeeSet.holes));
    expect(allocation.get(high)).toEqual(dotsByHole(22, whiteTeeSet.holes));
    // Hole 2 carries strokeIndex 1 on fixtureWhite18 — the >=19 wrap must land a
    // second dot there, not just one.
    expect(allocation.get(high)?.get(2)).toBe(2);
  });

  it("gross stroke-play allocates nothing: the whole allocation is empty", () => {
    const grossStrokePlay: Extract<GameConfig, { kind: "stroke-play" }> = {
      kind: "stroke-play",
      id: gameId("gross"),
      scoring: "gross",
      players: [ann, bo, cal, dee],
    };
    const allocation = gameStrokeAllocation(grossStrokePlay, fieldRoster, fixtureLinks18);
    expect(allocation).toEqual(new Map());
  });
});

describe("roundStrokeAllocation", () => {
  // The standard card's own dots: each player's asserted strokes allocated by stroke index, no
  // game. Unlike a match game (which subtracts the lowest of its own members), this is just
  // dotsByHole(entry.strokes, theirTeeSet) per player.
  it("an 8-stroke player gets 8 dots on their tee's 8 hardest SI holes", () => {
    const golfer = golferId("eight");
    const allocation = roundStrokeAllocation([p("eight", 8)], fixtureLinks18);
    expect(allocation.get(golfer)).toEqual(dotsByHole(8, whiteTeeSet.holes));
    expect(totalDots(allocation.get(golfer)!)).toBe(8);
  });

  it("a 0-stroke player gets a zero allocation on every hole", () => {
    const golfer = golferId("zero");
    const allocation = roundStrokeAllocation([p("zero", 0)], fixtureLinks18);
    expect(allocation.get(golfer)).toEqual(dotsByHole(0, whiteTeeSet.holes));
    expect(totalDots(allocation.get(golfer)!)).toBe(0);
  });

  it("allocates independently per participant, each against their own tee and asserted strokes", () => {
    const a = golferId("multi-a");
    const b = golferId("multi-b");
    const allocation = roundStrokeAllocation([p("multi-a", 8), p("multi-b", 0)], fixtureLinks18);
    expect(allocation.get(a)).toEqual(dotsByHole(8, whiteTeeSet.holes));
    expect(allocation.get(b)).toEqual(dotsByHole(0, whiteTeeSet.holes));
  });

  it("a medal game agrees with the card by construction, and a match deliberately does not", () => {
    // Two statements the panels make in words (spec 2026-07-30 §3), pinned side by side so a
    // future collapse of the two arms fails here as well as in the stroke-index assertion above.
    const card = roundStrokeAllocation(roster, fixtureLinks18);
    const medal = gameStrokeAllocation(
      { kind: "stableford", id: gameId("st"), players: [golferId("ann"), golferId("bo")] },
      roster,
      fixtureLinks18,
    );
    expect(medal.get(golferId("ann"))).toEqual(card.get(golferId("ann")));
    const match = gameStrokeAllocation(
      { kind: "singles-match", id: gameId("mm"), a: golferId("ann"), b: golferId("bo") },
      roster,
      fixtureLinks18,
    );
    expect(match.get(golferId("ann"))).not.toEqual(card.get(golferId("ann")));
  });
});

describe("totalDots", () => {
  it("sums a per-hole allocation to the total strokes it was built from", () => {
    const perHole = dotsByHole(11, whiteTeeSet.holes); // 18 holes: 11 < 18, so base = 0 and there is no wrap — SI 1-11 get exactly 1 dot each, SI 12-18 get none; sums back to 11
    expect(totalDots(perHole)).toBe(11);
  });
  it("sums to zero for an empty allocation (e.g. gross stroke-play)", () => {
    expect(totalDots(new Map())).toBe(0);
  });
  it("agrees with gameStrokeAllocation's own per-golfer allocation on the fourball fixture (6/0/13/3)", () => {
    const allocation = gameStrokeAllocation(fourball, fieldRoster, fixtureLinks18);
    const expectedRelative: Readonly<Record<string, number>> = { [ann]: 6, [bo]: 0, [cal]: 13, [dee]: 3 };
    for (const [id, relative] of Object.entries(expectedRelative)) {
      expect(totalDots(allocation.get(golferId(id))!)).toBe(relative);
    }
  });
});

describe("dotsForHoles", () => {
  it("sums only the requested holes' dots, not the whole allocation", () => {
    const perHole = dotsByHole(11, whiteTeeSet.holes); // 18 holes: 11 < 18, so base = 0 and there is no wrap — SI 1-11 get exactly 1 dot each, SI 12-18 get none (same fixture as totalDots' own test above, now correctly described there too)
    const front9 = whiteTeeSet.holes.filter((h) => h.number <= 9);
    const back9 = whiteTeeSet.holes.filter((h) => h.number > 9);
    expect(dotsForHoles(perHole, front9) + dotsForHoles(perHole, back9)).toBe(totalDots(perHole));
  });

  it("is zero when the allocation is undefined (a gross game's empty allocation)", () => {
    expect(dotsForHoles(undefined, whiteTeeSet.holes)).toBe(0);
  });

  it("is zero for an empty hole list", () => {
    expect(dotsForHoles(dotsByHole(11, whiteTeeSet.holes), [])).toBe(0);
  });
});
