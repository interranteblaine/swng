import { describe, expect, it } from "vitest";
import { anchorOf, resolveStrokes } from "./strokeBasis.js";
import type { GolferId } from "../ids.js";

const g = (s: string) => s as GolferId;
const shoots = (id: string, overPar: number) => ({ golferId: g(id), basis: { kind: "normally-shoots" as const, overPar } });
const takes = (id: string, strokes: number) => ({ golferId: g(id), basis: { kind: "strokes" as const, strokes } });
// Every call passes an explicit anchor — resolveStrokes has no fallback (spec §2b).
const resolve = (bases: Parameters<typeof resolveStrokes>[0], holes: number) => resolveStrokes(bases, holes, anchorOf(bases));

describe("resolveStrokes", () => {
  it("takes the difference from the lowest stated normal score", () => {
    const s = resolve([shoots("blaine", 30), shoots("ravi", 10)], 18);
    expect(s.get(g("blaine"))).toBe(20);
    expect(s.get(g("ravi"))).toBe(0);
  });

  it("gives a player who stated strokes exactly what they said", () => {
    const s = resolve([takes("blaine", 18), shoots("ravi", 10)], 18);
    expect(s.get(g("blaine"))).toBe(18);
    expect(s.get(g("ravi"))).toBe(0);
  });

  it("allocates nothing when only one player's level is known", () => {
    // Spec §2b: strokes cannot be allocated against an unknown level. Correct, not a failure.
    const s = resolve([shoots("blaine", 30), takes("ravi", 0)], 18);
    expect(s.get(g("blaine"))).toBe(0);
    expect(s.get(g("ravi"))).toBe(0);
  });

  it("anchors a lone player against himself", () => {
    expect(resolve([shoots("blaine", 30)], 18).get(g("blaine"))).toBe(0);
  });

  it("halves the difference once, at the end, on a nine-hole card", () => {
    const s = resolve([shoots("blaine", 30), shoots("ravi", 10)], 9);
    expect(s.get(g("blaine"))).toBe(10);
  });

  it("rounds a halved odd difference half-up", () => {
    const s = resolve([shoots("blaine", 25), shoots("ravi", 10)], 9);
    expect(s.get(g("blaine"))).toBe(8); // 15 / 2 = 7.5 → 8
  });

  it("never halves a literal strokes assertion", () => {
    expect(resolve([takes("blaine", 9)], 9).get(g("blaine"))).toBe(9);
  });

  it("clamps a below-zero difference to zero", () => {
    // The departed-player path (spec §2b): reduceRound anchors on the PRESENT field, so a
    // departed player better than everyone still there would otherwise resolve negative. After
    // Task 5 the card renders "●".repeat(dots) and repeat() throws RangeError on a negative, so
    // this clamp is the thing standing between that path and a crash on the live card.
    const s = resolveStrokes([shoots("early", 2)], 18, 10); // anchor from the surviving field
    expect(s.get(g("early"))).toBe(0);
  });
});
