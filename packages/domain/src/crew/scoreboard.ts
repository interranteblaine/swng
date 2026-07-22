import type { GolferId, RoundId } from "../ids.js";
import { fullyHoledOut, grossOf } from "../golfer/analytics.js";
import { golferMetrics } from "../golfer/metrics.js";
import type { GolferRoundLine } from "../golfer/record.js";
import { roundHalfUp } from "../scoring/strokes.js";

// The crew scoreboard (crew-scoreboard spec §3a): a pure fold over ALREADY-FETCHED golfer
// projection lines — never a fetcher (the crew/analytics.ts discipline). `lines` per member
// is the FULL career in chronological order (application sorts via sortLines — golferMetrics'
// own contract); the fold windows internally so index/indexDelta can see the whole record.

export type StoredLine = GolferRoundLine & { readonly finalizedAtMs: number; readonly createdAtMs?: number };

export interface SeasonWindow {
  readonly startMs: number;
  readonly endMs?: number; // absent = open season
}

// The ONE played-date rule (spec §2): the round's created (played) time first, its finalize
// time when older lines predate createdAtMs — the roundLabel/chart-anchor precedent.
export const playedAtMs = (line: { readonly finalizedAtMs: number; readonly createdAtMs?: number }): number =>
  line.createdAtMs ?? line.finalizedAtMs;

// Inclusive at BOTH ends: a round played at the very instant of a close belongs to the
// season that was closing (spec §2).
export const inWindow = (window: SeasonWindow, line: StoredLine): boolean => {
  const at = playedAtMs(line);
  return at >= window.startMs && (window.endMs === undefined || at <= window.endMs);
};

export interface ScoreboardLine {
  readonly golferId: GolferId;
  readonly rounds: number;
  readonly best18?: { readonly gross: number; readonly toPar: number };
  readonly netPer18?: number;
  readonly index?: number;
  readonly indexDelta?: number;
}

const NET_PER_18_MIN_ROUNDS = 3; // the netAverages refusing-to-draw-noise floor, carried forward (spec §3a)

export const crewScoreboard = (
  members: readonly { readonly golferId: GolferId; readonly lines: readonly StoredLine[] }[],
  window: SeasonWindow,
): readonly ScoreboardLine[] => {
  const rows = members.map(({ golferId, lines }) => {
    const windowed = lines.filter((line) => inWindow(window, line));

    // Lowest gross over fully-holed-out in-window 18s; strict < keeps the EARLIER round on a
    // tie (lines arrive chronological — the bestsOf precedent).
    let best18: { gross: number; toPar: number } | undefined;
    for (const line of windowed) {
      if (line.holes !== 18 || !fullyHoledOut(line)) continue;
      const gross = grossOf(line);
      if (best18 === undefined || gross < best18.gross) best18 = { gross, toPar: gross - line.par };
    }

    // AGS-based, vs-par, normalized per 18 (spec §3a's honesty argument); one decimal.
    const netLines = windowed.filter((line) => line.ags !== undefined);
    const netPer18 =
      netLines.length >= NET_PER_18_MIN_ROUNDS
        ? roundHalfUp(
            (netLines.reduce((sum, line) => sum + (line.ags! - line.courseHandicap - line.par), 0) /
              netLines.reduce((sum, line) => sum + line.holes, 0)) *
              18 *
              10,
          ) / 10
        : undefined;

    // The index is always the whole career; the delta is window-scoped via the same
    // played-date rule the window itself uses.
    const index = golferMetrics(lines).swngIndex?.value;
    const before = golferMetrics(lines.filter((line) => playedAtMs(line) < window.startMs)).swngIndex?.value;
    const indexDelta = index !== undefined && before !== undefined ? roundHalfUp((index - before) * 10) / 10 : undefined;

    return {
      golferId,
      rounds: windowed.length,
      ...(best18 !== undefined ? { best18 } : {}),
      ...(netPer18 !== undefined ? { netPer18 } : {}),
      ...(index !== undefined ? { index } : {}),
      ...(indexDelta !== undefined ? { indexDelta } : {}),
    };
  });

  // Total order, domain-owned (the aggregateSeason precedent): netPer18 asc with absent
  // LAST, rounds desc, golferId asc.
  return rows.sort((x, y) => {
    if (x.netPer18 !== y.netPer18) {
      if (x.netPer18 === undefined) return 1;
      if (y.netPer18 === undefined) return -1;
      return x.netPer18 - y.netPer18;
    }
    return y.rounds !== x.rounds ? y.rounds - x.rounds : x.golferId < y.golferId ? -1 : x.golferId > y.golferId ? 1 : 0;
  });
};

// "We played together" as a DERIVED fact (spec §3b): roundIds where >=2 DISTINCT members
// hold an in-window line. No order promised — callers sort for the wire.
export const sharedRoundIds = (
  members: readonly { readonly golferId: GolferId; readonly lines: readonly StoredLine[] }[],
  window: SeasonWindow,
): readonly RoundId[] => {
  const holders = new Map<RoundId, Set<GolferId>>();
  for (const { golferId, lines } of members) {
    for (const line of lines) {
      if (!inWindow(window, line)) continue;
      const set = holders.get(line.roundId) ?? new Set<GolferId>();
      set.add(golferId);
      holders.set(line.roundId, set);
    }
  }
  return [...holders.entries()].filter(([, set]) => set.size >= 2).map(([roundId]) => roundId);
};
