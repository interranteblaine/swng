import { describe, expect, it } from "vitest";
import { teeNumbers } from "./teeNumbers";

describe("teeNumbers", () => {
  it("renders a rated tee's rating and slope", () => {
    expect(teeNumbers({ rating: 71.6, slope: 128 })).toBe("rating 71.6, slope 128");
  });

  it('renders "unrated" when both are absent (the unrated pair)', () => {
    expect(teeNumbers({})).toBe("unrated");
  });

  // A tee should never be half-rated (course.ts enforces the pairing), but a defensive helper
  // must not render "rating 71.6, slope undefined" if one somehow arrives alone.
  it.each([
    ["rating alone", { rating: 71.6 }],
    ["slope alone", { slope: 128 }],
  ])('renders "unrated" for a half pair: %s', (_label, tee) => {
    expect(teeNumbers(tee)).toBe("unrated");
  });
});
