import type { CrewSeason } from "../ports/crewStore.js";

// Window-start rule (crew-scoreboard spec §2): a new season picks up where the last closed
// one ended, or January 1 (UTC) of the creation year — whichever is LATER. Fixed at
// creation, stored, never recomputed: sequential seasons tile, and a season created after
// its rounds were played still reaches back to the year start.
export const yearStartUtcMs = (nowMs: number): number => Date.UTC(new Date(nowMs).getUTCFullYear(), 0, 1);

export const seasonStartMs = (existing: readonly CrewSeason[], nowMs: number): number => {
  const latestClosedEnd = existing.reduce<number | undefined>(
    (acc, season) => (season.closedAtMs !== undefined && (acc === undefined || season.closedAtMs > acc) ? season.closedAtMs : acc),
    undefined,
  );
  return Math.max(latestClosedEnd ?? 0, yearStartUtcMs(nowMs));
};
