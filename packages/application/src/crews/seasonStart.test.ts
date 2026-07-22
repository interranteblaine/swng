import { describe, expect, it } from "vitest";
import type { CrewSeason } from "../ports/crewStore.js";
import { seasonStartMs, yearStartUtcMs } from "./seasonStart.js";

// Fixed, explicit epoch-ms values throughout (conventions §4: no wall-clock reads in tests) —
// every `now`/`closedAtMs` below is a literal Date.UTC(...) call, never Date.now().

// A minimal closed CrewSeason fixture — only closedAtMs is load-bearing for seasonStartMs's own
// reduce; the rest are placeholder-but-valid so the value type-checks as a real CrewSeason.
const closedSeason = (closedAtMs: number): CrewSeason => ({
  seasonId: "s-closed",
  name: "Test Season",
  status: "closed",
  createdAtMs: closedAtMs - 1_000,
  startsAtMs: 0,
  closedAtMs,
});

// A minimal OPEN CrewSeason fixture — no closedAtMs at all (not `closedAtMs: undefined`,
// matching the port's own "an absent field, not a present-but-empty one" contract).
const openSeason = (): CrewSeason => ({
  seasonId: "s-open",
  name: "Test Season",
  status: "open",
  createdAtMs: 0,
  startsAtMs: 0,
});

describe("seasonStartMs", () => {
  it("no closed seasons → Jan 1 UTC of now's year", () => {
    const now = Date.UTC(2026, 5, 15); // June 15, 2026

    expect(seasonStartMs([], now)).toBe(Date.UTC(2026, 0, 1));
  });

  it("one closed season with closedAtMs in June of the current year → June wins", () => {
    const juneClose = Date.UTC(2026, 5, 15); // June 15, 2026
    const now = Date.UTC(2026, 8, 1); // September 1, 2026 — after the close

    expect(seasonStartMs([closedSeason(juneClose)], now)).toBe(juneClose);
  });

  it("a closed season from LAST year + now in a new year → the new year's Jan 1 wins (the max arm)", () => {
    const lastYearClose = Date.UTC(2025, 10, 1); // November 1, 2025
    const now = Date.UTC(2026, 2, 1); // March 1, 2026

    expect(seasonStartMs([closedSeason(lastYearClose)], now)).toBe(Date.UTC(2026, 0, 1));
  });

  it("open seasons (no closedAtMs) are ignored even when present", () => {
    const now = Date.UTC(2026, 5, 15); // June 15, 2026

    expect(seasonStartMs([openSeason()], now)).toBe(Date.UTC(2026, 0, 1));
  });
});

describe("yearStartUtcMs", () => {
  it("returns January 1 UTC of the given instant's year", () => {
    expect(yearStartUtcMs(Date.UTC(2026, 5, 15))).toBe(Date.UTC(2026, 0, 1));
    expect(yearStartUtcMs(Date.UTC(2025, 10, 1))).toBe(Date.UTC(2025, 0, 1));
  });
});
