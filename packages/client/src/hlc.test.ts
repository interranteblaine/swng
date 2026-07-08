import { describe, expect, it } from "vitest";
import { compareHlc, deviceId } from "@swng/domain";
import { createHlcSource } from "./hlc.js";

const DEVICE = deviceId("phone-a");
const OTHER_DEVICE = deviceId("phone-b");

describe("createHlcSource", () => {
  it("under a frozen clock, yields strictly increasing stamps via a bumped counter", () => {
    const source = createHlcSource(DEVICE, { now: () => 1_000 });

    const first = source.next();
    const second = source.next();
    const third = source.next();

    expect(first.counter).toBe(0);
    expect(second.counter).toBe(1);
    expect(third.counter).toBe(2);
    expect(compareHlc(first, second)).toBeLessThan(0);
    expect(compareHlc(second, third)).toBeLessThan(0);
  });

  it("resets the counter when the wall clock advances to a new millisecond", () => {
    let now = 1_000;
    const source = createHlcSource(DEVICE, { now: () => now });

    const first = source.next();
    const second = source.next(); // same ms as first: counter bumps
    now = 2_000;
    const third = source.next(); // new ms: counter resets to 0

    expect(first.counter).toBe(0);
    expect(second.counter).toBe(1);
    expect(third.counter).toBe(0);
    expect(third.wallMs).toBe(2_000);
  });

  // The correction case: a phone whose wall clock is 60s behind the author it's correcting
  // must still win the LWW register — next() has to compare greater than the observed hlc
  // even though the local clock never caught up.
  it("after observe(), next() compares greater than the observed hlc even with a skewed-behind local clock", () => {
    const source = createHlcSource(DEVICE, { now: () => 1_000 });
    const remote = { wallMs: 1_000 + 60_000, counter: 5, deviceId: OTHER_DEVICE };

    source.observe(remote);
    const stamped = source.next();

    expect(compareHlc(stamped, remote)).toBeGreaterThan(0);
  });

  it("observe() never moves the source backward: a stale remote hlc is ignored", () => {
    const source = createHlcSource(DEVICE, { now: () => 10_000 });
    const ahead = source.next(); // wallMs 10_000, counter 0
    const stale = { wallMs: 1_000, counter: 99, deviceId: OTHER_DEVICE };

    source.observe(stale);
    const after = source.next();

    expect(compareHlc(after, ahead)).toBeGreaterThan(0);
    expect(after.wallMs).toBe(10_000);
  });

  it("yields strictly increasing stamps even when the wall clock regresses", () => {
    let now = 5_000;
    const source = createHlcSource(DEVICE, { now: () => now });

    const first = source.next();
    now = 3_000; // clock goes backward
    const second = source.next();

    expect(compareHlc(first, second)).toBeLessThan(0);
    expect(second.wallMs).toBe(5_000); // floored at the last stamp, not the regressed clock
  });

  it("defaults to the real wall clock when none is provided", () => {
    const source = createHlcSource(DEVICE);
    const before = Date.now();
    const stamped = source.next();
    const after = Date.now();

    expect(stamped.wallMs).toBeGreaterThanOrEqual(before);
    expect(stamped.wallMs).toBeLessThanOrEqual(after);
  });
});
