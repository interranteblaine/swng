import { describe, expect, it } from "vitest";
import { roundId } from "../ids.js";
import { inWindow } from "./scoreboard.js";
import type { StoredLine } from "./scoreboard.js";
import { seasonWindowOf } from "./seasonWindow.js";

// Minimal StoredLine fixture — only finalizedAtMs/createdAtMs (playedAtMs's own inputs)
// vary across these tests; every other field is a fixed, unexamined placeholder.
const mkLine = (finalizedAtMs: number, createdAtMs?: number): StoredLine => ({
  roundId: roundId("r1"),
  courseName: "Fixture",
  tee: "white",
  holes: 18,
  par: 72,
  courseHandicap: 10,
  distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  finalizedAtMs,
  ...(createdAtMs !== undefined ? { createdAtMs } : {}),
});

describe("seasonWindowOf", () => {
  it("converts a full-year season to its ms window", () => {
    expect(seasonWindowOf({ startsAt: "2026-01-01", endsAt: "2026-12-31" })).toEqual({
      startMs: Date.UTC(2026, 0, 1),
      endMs: Date.UTC(2026, 11, 31) + 86_399_999,
    });
  });

  it("a line played at exactly endMs is inWindow", () => {
    const window = seasonWindowOf({ startsAt: "2026-01-01", endsAt: "2026-12-31" });
    expect(inWindow(window, mkLine(window.endMs!))).toBe(true);
  });

  it("a line played at endMs + 1 is not inWindow", () => {
    const window = seasonWindowOf({ startsAt: "2026-01-01", endsAt: "2026-12-31" });
    expect(inWindow(window, mkLine(window.endMs! + 1))).toBe(false);
  });

  it("a line played at startMs - 1 is not inWindow", () => {
    const window = seasonWindowOf({ startsAt: "2026-01-01", endsAt: "2026-12-31" });
    expect(inWindow(window, mkLine(window.startMs - 1))).toBe(false);
  });

  it("a single-day season contains a line played that UTC day", () => {
    const window = seasonWindowOf({ startsAt: "2026-06-15", endsAt: "2026-06-15" });
    expect(window).toEqual({
      startMs: Date.UTC(2026, 5, 15),
      endMs: Date.UTC(2026, 5, 15) + 86_399_999,
    });
    // start of day, midday, and the last ms of the day all land inside.
    expect(inWindow(window, mkLine(Date.UTC(2026, 5, 15, 0, 0, 0, 0)))).toBe(true);
    expect(inWindow(window, mkLine(Date.UTC(2026, 5, 15, 12, 30, 0, 0)))).toBe(true);
    expect(inWindow(window, mkLine(Date.UTC(2026, 5, 15, 23, 59, 59, 999)))).toBe(true);
    // the neighboring days are out.
    expect(inWindow(window, mkLine(Date.UTC(2026, 5, 14, 23, 59, 59, 999)))).toBe(false);
    expect(inWindow(window, mkLine(Date.UTC(2026, 5, 16, 0, 0, 0, 0)))).toBe(false);
  });

  it.each(["2026-1-1", "garbage", ""])("throws on malformed shape %j", (bad) => {
    expect(() => seasonWindowOf({ startsAt: bad, endsAt: "2026-12-31" })).toThrow(Error);
  });

  it.each(["2026-02-30", "2026-13-01"])(
    "throws on semantically-invalid calendar date %j (round-trip check, not silent rollover)",
    (bad) => {
      expect(() => seasonWindowOf({ startsAt: "2026-01-01", endsAt: bad })).toThrow(Error);
    },
  );
});
