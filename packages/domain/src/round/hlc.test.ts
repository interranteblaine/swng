import { describe, expect, it } from "vitest";
import { deviceId } from "../ids.js";
import { compareHlc, type Hlc } from "./hlc.js";

const hlc = (wallMs: number, counter: number, device: string): Hlc => ({
  wallMs,
  counter,
  deviceId: deviceId(device),
});

describe("compareHlc", () => {
  it("orders by wall time first", () => {
    expect(compareHlc(hlc(1000, 5, "b"), hlc(2000, 0, "a"))).toBeLessThan(0);
  });
  it("breaks wall-time ties by counter", () => {
    expect(compareHlc(hlc(1000, 2, "a"), hlc(1000, 1, "b"))).toBeGreaterThan(0);
  });
  it("breaks counter ties by deviceId so the order is total", () => {
    expect(compareHlc(hlc(1000, 1, "a"), hlc(1000, 1, "b"))).toBeLessThan(0);
    expect(compareHlc(hlc(1000, 1, "a"), hlc(1000, 1, "a"))).toBe(0);
  });
});
