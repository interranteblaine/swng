import { describe, expect, it } from "vitest";
import { dayCollisionChecker, roundDayKey, roundLabel } from "./roundLabel";

// A fixed instant used across the format assertions: 2025-07-12 07:58 UTC. July 12 2025 is a
// Saturday. The tests below pass an EXPLICIT `timeZone: "UTC"` so the assertions read
// unambiguously as "Sat, Jul 12" at "7:58a" on every machine — timezone is an explicit input to
// roundLabel (its own doc comment explains why: the product default is the viewer's LOCAL zone,
// so pinning a zone is how a test stays hermetic regardless of the CI box's TZ).
const SAT_JUL_12_0758 = Date.UTC(2025, 6, 12, 7, 58);

describe("roundLabel", () => {
  it("renders course + date — the canonical 'Casa Verde GC · Sat, Jul 12' (spec §5)", () => {
    expect(roundLabel({ courseName: "Casa Verde GC", createdAt: SAT_JUL_12_0758 }, { timeZone: "UTC" })).toBe("Casa Verde GC · Sat, Jul 12");
  });

  it("appends the tee time when withTime is passed (the same-course-same-day disambiguator)", () => {
    expect(roundLabel({ courseName: "Casa Verde GC", createdAt: SAT_JUL_12_0758 }, { withTime: true, timeZone: "UTC" })).toBe("Casa Verde GC · Sat, Jul 12 · 7:58a");
  });

  it("renders just the course name when createdAt is absent (old projection rows, pre-backfill)", () => {
    expect(roundLabel({ courseName: "Casa Verde GC" })).toBe("Casa Verde GC");
    // withTime has nothing to append to a day that isn't there — still the bare course name.
    expect(roundLabel({ courseName: "Casa Verde GC" }, { withTime: true, timeZone: "UTC" })).toBe("Casa Verde GC");
  });

  it("formats afternoon / midnight / noon times with a single-letter meridiem", () => {
    expect(roundLabel({ courseName: "X", createdAt: Date.UTC(2025, 6, 12, 14, 5) }, { withTime: true, timeZone: "UTC" })).toBe("X · Sat, Jul 12 · 2:05p");
    expect(roundLabel({ courseName: "X", createdAt: Date.UTC(2025, 6, 12, 0, 0) }, { withTime: true, timeZone: "UTC" })).toBe("X · Sat, Jul 12 · 12:00a");
    expect(roundLabel({ courseName: "X", createdAt: Date.UTC(2025, 6, 12, 12, 0) }, { withTime: true, timeZone: "UTC" })).toBe("X · Sat, Jul 12 · 12:00p");
  });

  // The reason this fix exists: a round everyone played Friday evening (Pacific) is Saturday in
  // UTC. The label must name the day the GROUP played, so it renders in the round's own zone —
  // an explicit input — not UTC. 2025-07-12 02:00 UTC is a Saturday; in America/New_York (UTC-4
  // in July) it is 2025-07-11 22:00 — Friday. Same instant, two zones, two days: the pinned zone
  // wins, never UTC.
  it("renders the pinned zone's day, not UTC's, for a Saturday-in-UTC instant that is still Friday locally", () => {
    const satUtcFriNy = Date.UTC(2025, 6, 12, 2, 0);
    expect(roundLabel({ courseName: "Casa Verde GC", createdAt: satUtcFriNy }, { timeZone: "UTC" })).toBe("Casa Verde GC · Sat, Jul 12");
    expect(roundLabel({ courseName: "Casa Verde GC", createdAt: satUtcFriNy }, { timeZone: "America/New_York" })).toBe("Casa Verde GC · Fri, Jul 11");
  });

  it("renders the tee time on the pinned zone's clock, not UTC's", () => {
    // 07:58 UTC is 03:58 (a.m.) in America/New_York (UTC-4 in July) — the group's own wall clock,
    // not the UTC "7:58a".
    expect(roundLabel({ courseName: "X", createdAt: SAT_JUL_12_0758 }, { withTime: true, timeZone: "America/New_York" })).toBe("X · Sat, Jul 12 · 3:58a");
  });

  it("formats in the environment's local zone when no timeZone is given (the product default)", () => {
    // Deterministic without pinning the worker's TZ: omitting timeZone must equal passing the
    // environment's own resolved zone explicitly — i.e. the default IS local.
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(roundLabel({ courseName: "X", createdAt: SAT_JUL_12_0758 }, { withTime: true })).toBe(roundLabel({ courseName: "X", createdAt: SAT_JUL_12_0758 }, { withTime: true, timeZone: localZone }));
  });
});

describe("roundDayKey — the same-course-same-day collision key", () => {
  it("two rounds at the same course on the same day (same zone) share a key; a different day does not", () => {
    const morning = roundDayKey({ courseName: "Casa Verde GC", createdAt: Date.UTC(2025, 6, 12, 7, 58) }, { timeZone: "UTC" });
    const afternoon = roundDayKey({ courseName: "Casa Verde GC", createdAt: Date.UTC(2025, 6, 12, 15, 30) }, { timeZone: "UTC" });
    const nextDay = roundDayKey({ courseName: "Casa Verde GC", createdAt: Date.UTC(2025, 6, 13, 7, 58) }, { timeZone: "UTC" });
    expect(morning).toBe(afternoon);
    expect(morning).not.toBe(nextDay);
  });

  it("different courses on the same day do not collide", () => {
    const casa = roundDayKey({ courseName: "Casa Verde GC", createdAt: Date.UTC(2025, 6, 12, 7, 58) }, { timeZone: "UTC" });
    const pebble = roundDayKey({ courseName: "Pebble Beach", createdAt: Date.UTC(2025, 6, 12, 7, 58) }, { timeZone: "UTC" });
    expect(casa).not.toBe(pebble);
  });

  it("keys the round on the pinned zone's day — one instant lands on different days across zones", () => {
    // The zone-basis requirement: the SAME instant that is Saturday in UTC is Friday in New York,
    // so its collision key must differ between the two — otherwise a label rendering local days
    // would group on UTC days and append the tee time to the wrong pairs.
    const satUtcFriNy = Date.UTC(2025, 6, 12, 2, 0);
    const utcKey = roundDayKey({ courseName: "Casa Verde GC", createdAt: satUtcFriNy }, { timeZone: "UTC" });
    const nyKey = roundDayKey({ courseName: "Casa Verde GC", createdAt: satUtcFriNy }, { timeZone: "America/New_York" });
    expect(utcKey).not.toBe(nyKey);
  });

  it("uses the environment's local zone when no timeZone is given (matching roundLabel's default)", () => {
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const instant = Date.UTC(2025, 6, 12, 7, 58);
    expect(roundDayKey({ courseName: "Casa Verde GC", createdAt: instant })).toBe(roundDayKey({ courseName: "Casa Verde GC", createdAt: instant }, { timeZone: localZone }));
  });

  it("is undefined without a createdAt — a round with no day can't collide with anything", () => {
    expect(roundDayKey({ courseName: "Casa Verde GC" })).toBeUndefined();
  });
});

describe("dayCollisionChecker — in-list same-course-same-day flagging", () => {
  const casaMorning = { courseName: "Casa Verde GC", createdAt: Date.UTC(2025, 6, 12, 7, 58) };
  const casaAfternoon = { courseName: "Casa Verde GC", createdAt: Date.UTC(2025, 6, 12, 15, 30) };
  const casaNextDay = { courseName: "Casa Verde GC", createdAt: Date.UTC(2025, 6, 13, 7, 58) };
  const pebble = { courseName: "Pebble Beach", createdAt: Date.UTC(2025, 6, 12, 7, 58) };
  const noDate = { courseName: "Casa Verde GC" };

  it("flags both rounds that share course AND day", () => {
    const collides = dayCollisionChecker([casaMorning, casaAfternoon], { timeZone: "UTC" });
    expect(collides(casaMorning)).toBe(true);
    expect(collides(casaAfternoon)).toBe(true);
  });

  it("flags neither when the day differs", () => {
    const collides = dayCollisionChecker([casaMorning, casaNextDay], { timeZone: "UTC" });
    expect(collides(casaMorning)).toBe(false);
    expect(collides(casaNextDay)).toBe(false);
  });

  it("flags neither when the course differs", () => {
    const collides = dayCollisionChecker([casaMorning, pebble], { timeZone: "UTC" });
    expect(collides(casaMorning)).toBe(false);
    expect(collides(pebble)).toBe(false);
  });

  it("a round with no createdAt never collides", () => {
    const collides = dayCollisionChecker([noDate, { courseName: "Casa Verde GC" }], { timeZone: "UTC" });
    expect(collides(noDate)).toBe(false);
  });

  it("defaults to the local zone (matches an explicit local timeZone)", () => {
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const a = { courseName: "X", createdAt: Date.UTC(2025, 6, 12, 12, 0) };
    const b = { courseName: "X", createdAt: Date.UTC(2025, 6, 12, 13, 0) };
    expect(dayCollisionChecker([a, b])(a)).toBe(dayCollisionChecker([a, b], { timeZone: localZone })(a));
  });
});
