import { describe, expect, it } from "vitest";
import { formatCourseHandicap, formatHandicapIndex, indexSourcePhrase, strokeGrant } from "./present.js";

describe("formatHandicapIndex", () => {
  it("renders a normal index plainly, scratch as 0.0", () => {
    expect(formatHandicapIndex(12.4)).toBe("12.4");
    expect(formatHandicapIndex(0)).toBe("0.0");
  });
  it("renders a plus handicap (below 0) with a + and no minus", () => {
    expect(formatHandicapIndex(-1.2)).toBe("+1.2");
    expect(formatHandicapIndex(-0.4)).toBe("+0.4");
  });
});

describe("formatCourseHandicap", () => {
  it("renders a normal integer course handicap plainly, scratch as 0 — no decimals", () => {
    expect(formatCourseHandicap(13)).toBe("13");
    expect(formatCourseHandicap(0)).toBe("0");
  });
  it("renders a plus course handicap (below 0) with a + and no minus", () => {
    expect(formatCourseHandicap(-1)).toBe("+1");
    expect(formatCourseHandicap(-2)).toBe("+2");
  });
});

describe("strokeGrant", () => {
  it("positive receives, negative gives, zero none", () => {
    expect(strokeGrant(2)).toEqual({ kind: "receives", count: 2 });
    expect(strokeGrant(-2)).toEqual({ kind: "gives", count: 2 });
    expect(strokeGrant(0)).toEqual({ kind: "none", count: 0 });
  });
});

// The golfer-page arc (navigation spec §6c): ProfilePage's three source strings, moved here
// verbatim as the "your" arm, plus the third-person "their" arm for viewing someone else's
// record. All six strings pinned exactly.
describe("indexSourcePhrase", () => {
  it("the your arm — ProfilePage's own copy, verbatim", () => {
    expect(indexSourcePhrase("swng", "your")).toBe("from all your rounds");
    expect(indexSourcePhrase("whs", "your")).toBe("your WHS index");
    expect(indexSourcePhrase("declared", "your")).toBe("your own");
  });

  it("the their arm — third person, for viewing another golfer's record", () => {
    expect(indexSourcePhrase("swng", "their")).toBe("from all their rounds");
    expect(indexSourcePhrase("whs", "their")).toBe("their WHS index");
    expect(indexSourcePhrase("declared", "their")).toBe("their own");
  });
});
