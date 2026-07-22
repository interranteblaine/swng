import type { SeasonWindow } from "./scoreboard.js";

export interface SeasonBounds {
  readonly startsAt: string; // "YYYY-MM-DD" — required
  readonly endsAt: string;   // "YYYY-MM-DD" — required
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// A season bound is a CALENDAR DATE, compared against the UTC date of a round's played
// time (spec §1). Known, accepted edge: a late-evening local round near a boundary can
// land on the neighboring UTC day — one rule, no timezone machinery.
//
// PROGRAMMER GUARD, not a DomainError (spec §1): the wire regex gates every write path, so
// a malformed string here means a corrupted stored row — a plain Error, the posture of the
// adapter's own seasonId "#" guard. The round-trip check (not just the shape regex) rejects
// a semantically-invalid date (2026-02-30 rolling to Mar 2) instead of windowing to the
// wrong instant.
const isoOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const utcDayStartMs = (date: string): number => {
  if (!DATE.test(date)) throw new Error(`season bound not a YYYY-MM-DD date: "${date}"`);
  const [y, m, d] = date.split("-").map(Number);
  const ms = Date.UTC(y!, m! - 1, d!);
  if (isoOf(ms) !== date) throw new Error(`season bound is not a real calendar date: "${date}"`);
  return ms;
};

export const seasonWindowOf = (bounds: SeasonBounds): SeasonWindow => ({
  startMs: utcDayStartMs(bounds.startsAt),
  endMs: utcDayStartMs(bounds.endsAt) + 86_400_000 - 1, // last ms of the end day
});
