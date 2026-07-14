import { describe, expect, it } from "vitest";
import { roundDayKey, roundLabel } from "./roundLabel";

// A fixed instant used across the format assertions: 2025-07-12 07:58 UTC. July 12 2025 is a
// Saturday, and the designation is rendered in UTC (roundLabel's own doc comment explains why it
// is a single canonical rendering, not the viewer's local zone), so this reads unambiguously as
// "Sat, Jul 12" at "7:58a" on every machine — the assertions below stay hermetic regardless of
// the CI box's timezone.
const SAT_JUL_12_0758 = Date.UTC(2025, 6, 12, 7, 58);

describe("roundLabel", () => {
  it("renders course + date — the canonical 'Casa Verde GC · Sat, Jul 12' (spec §5)", () => {
    expect(roundLabel({ courseName: "Casa Verde GC", createdAt: SAT_JUL_12_0758 })).toBe("Casa Verde GC · Sat, Jul 12");
  });

  it("appends the tee time when withTime is passed (the same-course-same-day disambiguator)", () => {
    expect(roundLabel({ courseName: "Casa Verde GC", createdAt: SAT_JUL_12_0758 }, { withTime: true })).toBe("Casa Verde GC · Sat, Jul 12 · 7:58a");
  });

  it("renders just the course name when createdAt is absent (old projection rows, pre-backfill)", () => {
    expect(roundLabel({ courseName: "Casa Verde GC" })).toBe("Casa Verde GC");
    // withTime has nothing to append to a day that isn't there — still the bare course name.
    expect(roundLabel({ courseName: "Casa Verde GC" }, { withTime: true })).toBe("Casa Verde GC");
  });

  it("formats afternoon / midnight / noon times with a single-letter meridiem", () => {
    expect(roundLabel({ courseName: "X", createdAt: Date.UTC(2025, 6, 12, 14, 5) }, { withTime: true })).toBe("X · Sat, Jul 12 · 2:05p");
    expect(roundLabel({ courseName: "X", createdAt: Date.UTC(2025, 6, 12, 0, 0) }, { withTime: true })).toBe("X · Sat, Jul 12 · 12:00a");
    expect(roundLabel({ courseName: "X", createdAt: Date.UTC(2025, 6, 12, 12, 0) }, { withTime: true })).toBe("X · Sat, Jul 12 · 12:00p");
  });
});

describe("roundDayKey — the same-course-same-day collision key", () => {
  it("two rounds at the same course on the same UTC day share a key; a different day does not", () => {
    const morning = roundDayKey({ courseName: "Casa Verde GC", createdAt: Date.UTC(2025, 6, 12, 7, 58) });
    const afternoon = roundDayKey({ courseName: "Casa Verde GC", createdAt: Date.UTC(2025, 6, 12, 15, 30) });
    const nextDay = roundDayKey({ courseName: "Casa Verde GC", createdAt: Date.UTC(2025, 6, 13, 7, 58) });
    expect(morning).toBe(afternoon);
    expect(morning).not.toBe(nextDay);
  });

  it("different courses on the same day do not collide", () => {
    const casa = roundDayKey({ courseName: "Casa Verde GC", createdAt: Date.UTC(2025, 6, 12, 7, 58) });
    const pebble = roundDayKey({ courseName: "Pebble Beach", createdAt: Date.UTC(2025, 6, 12, 7, 58) });
    expect(casa).not.toBe(pebble);
  });

  it("is undefined without a createdAt — a round with no day can't collide with anything", () => {
    expect(roundDayKey({ courseName: "Casa Verde GC" })).toBeUndefined();
  });
});
