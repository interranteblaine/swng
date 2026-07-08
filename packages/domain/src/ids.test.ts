import { describe, expect, it } from "vitest";
import { golferId } from "./ids.js";

describe("branded ids", () => {
  it("carries the runtime string through", () => {
    expect(golferId("g-1")).toBe("g-1");
  });
});
