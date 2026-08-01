import type { GolferId, RoundId } from "../ids.js";
import { hasCompleteScore, scoreOf } from "../golfer/analytics.js";
import { averageOfValues, scoredOverPar, spreadOfValues } from "../golfer/average.js";
import type { GolferRoundLine } from "../golfer/record.js";

// The crew scoreboard (crew-scoreboard spec §3a, reshaped by spec 2026-07-29 §6): a pure fold over
// ALREADY-FETCHED golfer projection lines — never a fetcher (the crew/analytics.ts discipline).
// `lines` per member is the FULL career in chronological order (application sorts via sortLines —
// golferMetrics' own contract); the fold windows to the season internally.

// `playedAtMs` (spec 2026-08-01 §4a/§4c) is REQUIRED, not derived here — domain's ONE
// played-date rule (`playedAtMsOf`, round/playedAt.ts) is computed once by projectArchive and
// stamped onto every projection line (ports/projectionStore.ts), so by the time a line reaches
// this fold it already carries the real fact. There used to be a SECOND, overloaded rule living
// in this file (`createdAtMs ?? finalizedAtMs` — "guess the played date from when the record was
// made, or failing that from when it was sealed") that this arc exists to delete. `finalizedAtMs`
// stays on `StoredLine` too, but nothing in THIS file reads it (best18's tie-break walk relies on
// array order, which the application layer sorts by playedAtMs via sortLines, not finalizedAtMs)
// — it rides along only because getSeasonStandings.ts pulls it off these SAME line objects for
// the wire's own audit `finalizedAt`.
export type StoredLine = GolferRoundLine & { readonly finalizedAtMs: number; readonly playedAtMs: number };

export interface SeasonWindow {
  readonly startMs: number;
  readonly endMs?: number; // absent = open season
}

// Inclusive at BOTH ends: a round played at the very instant of a close belongs to the
// season that was closing (spec §2). A round counts in the season it was PLAYED in, never the
// one its paperwork (creation or finalize) happens to land in — spec 2026-08-01 §4c: a round
// played 2026-03-15 but finalized months later, after a season's endsAt has already passed,
// still belongs to that earlier season.
export const inWindow = (window: SeasonWindow, line: StoredLine): boolean => {
  const at = line.playedAtMs;
  return at >= window.startMs && (window.endMs === undefined || at <= window.endMs);
};

// Rounds · Average · Spread · Best (spec 2026-07-29 §6): once every round collapses to one number
// in one unit, a golfer's record is a DISTRIBUTION, not a point estimate — so the board describes
// it. `average` is level, `spread` is consistency (the most useful competitive fact about an
// opponent: ±4.2 beats better players more often than the averages suggest and loses to worse
// ones), `best18` is ceiling. The retired `netPer18` was also plain wrong: it subtracted whatever
// integer was typed at join, so a player who typed a difference read several strokes better than
// the truth. `index`/`indexDelta` go with the index itself; the trend lives on the profile chart.
export interface ScoreboardLine {
  readonly golferId: GolferId;
  readonly rounds: number;
  readonly average?: number;
  readonly spread?: number;
  readonly best18?: { readonly gross: number; readonly toPar: number };
}

export const crewScoreboard = (
  members: readonly { readonly golferId: GolferId; readonly lines: readonly StoredLine[] }[],
  window: SeasonWindow,
): readonly ScoreboardLine[] => {
  const rows = members.map(({ golferId, lines }) => {
    const windowed = lines.filter((line) => inWindow(window, line));

    // Lowest gross over fully-scored in-window 18s; strict < keeps the EARLIER round on a
    // tie (lines arrive chronological — the bestsOf precedent).
    let best18: { gross: number; toPar: number } | undefined;
    for (const line of windowed) {
      if (line.holes !== 18 || !hasCompleteScore(line)) continue;
      const gross = scoreOf(line);
      if (best18 === undefined || gross < best18.gross) best18 = { gross, toPar: gross - line.par };
    }

    // Average + spread over EVERY finished round in the window — deliberately NOT the profile's
    // rolling last-10 (spec §6: `Rounds 12` beside an average of 10 of them would be a lie on the
    // same row). Hence `averageOfValues`/`spreadOfValues` over the season's own values rather than
    // `averageOf`, which would silently re-slice to 10 on top of the window. The profile answers
    // "what do you shoot"; the board answers "what did you shoot this season" — and spread is THIS
    // board's column alone (controller ruling), so there is no rolling-10 spread anywhere to
    // disagree with the number on this row.
    const values = scoredOverPar(windowed);
    const average = averageOfValues(values);
    const spread = spreadOfValues(values);

    return {
      golferId,
      rounds: windowed.length,
      ...(average !== undefined ? { average } : {}),
      ...(spread !== undefined ? { spread } : {}),
      ...(best18 !== undefined ? { best18 } : {}),
    };
  });

  // Total order, domain-owned (the aggregateSeason precedent): average asc with absent
  // LAST, rounds desc, golferId asc.
  return rows.sort((x, y) => {
    if (x.average !== y.average) {
      if (x.average === undefined) return 1;
      if (y.average === undefined) return -1;
      return x.average - y.average;
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
