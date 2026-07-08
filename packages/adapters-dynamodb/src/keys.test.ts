import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { evtSk } from "./keys.js";

describe("evtSk", () => {
  it("pads seq to 10 digits", () => {
    expect(evtSk(7)).toBe("EVT#0000000007");
  });

  it("orders lexically exactly as it orders numerically", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 9_999_999_999 }),
        fc.integer({ min: 0, max: 9_999_999_999 }),
        (a, b) => {
          expect(evtSk(a) < evtSk(b)).toBe(a < b);
        },
      ),
    );
  });
});
