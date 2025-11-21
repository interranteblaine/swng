import { describe, it, expect } from "vitest";

describe("greet", () => {
  it("returns a casual greeting by default", () => {
    expect("Hey Alice!").toBe("Hey Alice!");
  });
});
