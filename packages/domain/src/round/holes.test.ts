import { describe, expect, it } from "vitest";
import type { TeeSet } from "../course/card.js";
import { hasHoleChoice, intendedHoles } from "./holes.js";

// An 18-hole tee with the conventional split: odd stroke indexes on the front, even on the back.
const eighteen: TeeSet = {
  name: "white",
  holes: Array.from({ length: 18 }, (_, i) => ({
    number: i + 1,
    par: 4,
    yardage: 400,
    strokeIndex: i < 9 ? i * 2 + 1 : (i - 9) * 2 + 2,
  })),
};

const nine: TeeSet = { name: "white", holes: eighteen.holes.slice(0, 9) };

const numbers = (tee: TeeSet, selection: Parameters<typeof intendedHoles>[1]) =>
  intendedHoles(tee, selection).map((h) => h.number);

describe("intendedHoles", () => {
  it("gives the whole card for 'all'", () => {
    expect(numbers(eighteen, "all")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });

  it("gives the first nine in card order for 'front'", () => {
    expect(numbers(eighteen, "front")).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("gives the second nine in card order for 'back'", () => {
    expect(numbers(eighteen, "back")).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });

  // The case that must never throw and never come back empty: a nine-hole card has one nine, so
  // every selection names it. "We played nine holes at a nine-hole course" is a true statement.
  it.each(["all", "front", "back"] as const)("resolves '%s' to the whole nine on a one-nine card", (selection) => {
    expect(numbers(nine, selection)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("preserves the hole objects themselves, not copies", () => {
    expect(intendedHoles(eighteen, "back")[0]).toBe(eighteen.holes[9]);
  });
});

// whole-branch review Finding 4: the ONE spelling of "does this card have a choice to make",
// replacing three independent ones (startRound's `<= 9` guard, two `=== 18` web predicates).
describe("hasHoleChoice", () => {
  it("is true for an 18-hole tee set — front/back is a real choice", () => {
    expect(hasHoleChoice(eighteen)).toBe(true);
  });

  it("is false for a 9-hole tee set — there's nothing to split", () => {
    expect(hasHoleChoice(nine)).toBe(false);
  });
});
