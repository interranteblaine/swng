import type { GolferId } from "../ids.js";
import { fullyHoledOut, grossOf } from "../golfer/analytics.js";
import { archiveGolferLine } from "../golfer/record.js";
import type { RoundArchive } from "../round/archive.js";
import { roundHalfUp } from "../scoring/strokes.js";
import { configForResult } from "./ledger.js";
import type { SeasonLedgerLine } from "./ledger.js";

// Crew analytics — new folds beside the existing standings (analytics spec 2026-07-21 §5):
// compute on read over the season's counted snapshots, nothing stored, current-roster scoping
// applies exactly as the existing ledger (`memberIds` narrows every fold, same as
// aggregateSeason's own roster filter one layer up). Mirrors ledger.ts's own idiom — a pure
// accumulator Map keyed on a canonical string, sorted once at the end.

export interface PartnerRecord {
  readonly a: GolferId;
  readonly b: GolferId;
  readonly wins: number;
  readonly losses: number;
  readonly halves: number;
}

// Partner records (spec §5): four-ball ONLY — ledger.ts's own headToHead is singles-only, and a
// four-ball SIDE (two golfers playing together) is a partnership worth its own W-L-H, distinct
// from the singles pairwise record. A side's pair counts iff BOTH golfers are current roster
// members (`memberIds`); a pair with a non-member is excluded outright, never partially counted.
// Pair identity is plain lexicographic golferId comparison — the config's own a/b side order is
// irrelevant (the crewContribution headToHead canonicalization precedent). Reuses
// `configForResult` (ledger.ts) for the ONE fourball-config lookup, never a second copy.
export const partnerRecords = (archives: readonly RoundArchive[], memberIds: ReadonlySet<GolferId>): readonly PartnerRecord[] => {
  const pairs = new Map<string, PartnerRecord>();

  const add = (sideA: GolferId, sideB: GolferId, delta: Partial<Pick<PartnerRecord, "wins" | "losses" | "halves">>): void => {
    if (!memberIds.has(sideA) || !memberIds.has(sideB)) return;
    const [a, b] = sideA < sideB ? [sideA, sideB] : [sideB, sideA];
    const key = `${a}#${b}`;
    const current = pairs.get(key) ?? { a, b, wins: 0, losses: 0, halves: 0 };
    pairs.set(key, {
      a,
      b,
      wins: current.wins + (delta.wins ?? 0),
      losses: current.losses + (delta.losses ?? 0),
      halves: current.halves + (delta.halves ?? 0),
    });
  };

  for (const archive of archives) {
    for (const result of archive.results) {
      if (result.kind !== "fourball-match") continue;
      const config = configForResult(archive, result.id, "fourball-match");
      if ("halved" in result.outcome) {
        add(config.a[0], config.a[1], { halves: 1 });
        add(config.b[0], config.b[1], { halves: 1 });
      } else {
        const winningSide = result.outcome.winner === "a" ? config.a : config.b;
        const losingSide = result.outcome.winner === "a" ? config.b : config.a;
        add(winningSide[0], winningSide[1], { wins: 1 });
        add(losingSide[0], losingSide[1], { losses: 1 });
      }
    }
  }

  return [...pairs.values()].sort((x, y) =>
    x.wins !== y.wins ? y.wins - x.wins : x.a !== y.a ? (x.a < y.a ? -1 : 1) : x.b < y.b ? -1 : x.b > y.b ? 1 : 0,
  );
};

export interface NetAverage {
  readonly golferId: GolferId;
  readonly holes: 9 | 18;
  readonly rounds: number;
  readonly average: number;
}

const NET_AVERAGE_MIN_ROUNDS = 3;

// Lowest net average (spec §5): per member, mean of (gross − courseHandicap) over fully
// holed-out counted rounds they played, grouped by hole count independently (a 9 never blends
// into an 18 — the bestsOf/courseRecord precedent). A member QUALIFIES for a hole count at >=3
// rounds; qualifying at BOTH hole counts keeps only the one with more qualifying rounds (tie ->
// 18); qualifying at NEITHER omits the member entirely — missing data is never ranked as zero.
// `archiveGolferLine` throws `unknown-participant` for a golfer not on that archive's roster, so
// every read is guarded by `participants.some(...)` first — sitting out a round is silent, never
// a throw.
export const netAverages = (archives: readonly RoundArchive[], memberIds: ReadonlySet<GolferId>): readonly NetAverage[] => {
  const nets = new Map<GolferId, { 9: number[]; 18: number[] }>();

  for (const archive of archives) {
    for (const golferId of memberIds) {
      if (!archive.participants.some((p) => p.golferId === golferId)) continue;
      const line = archiveGolferLine(archive, golferId);
      if (!fullyHoledOut(line)) continue;
      const net = grossOf(line) - line.courseHandicap;
      const byHoles = nets.get(golferId) ?? { 9: [], 18: [] };
      byHoles[line.holes].push(net);
      nets.set(golferId, byHoles);
    }
  }

  const results: NetAverage[] = [];
  for (const [golferId, byHoles] of nets) {
    const nineQualifies = byHoles[9].length >= NET_AVERAGE_MIN_ROUNDS;
    const eighteenQualifies = byHoles[18].length >= NET_AVERAGE_MIN_ROUNDS;
    if (!nineQualifies && !eighteenQualifies) continue;
    const holes: 9 | 18 = nineQualifies && (!eighteenQualifies || byHoles[9].length > byHoles[18].length) ? 9 : 18;
    const rounds = byHoles[holes];
    const average = roundHalfUp((rounds.reduce((sum, net) => sum + net, 0) / rounds.length) * 10) / 10;
    results.push({ golferId, holes, rounds: rounds.length, average });
  }

  return results.sort((x, y) => (x.average !== y.average ? x.average - y.average : x.golferId < y.golferId ? -1 : x.golferId > y.golferId ? 1 : 0));
};

export interface ImprovementEntry {
  readonly golferId: GolferId;
  readonly from: number;
  readonly to: number;
}

// Most improved (spec §5): a PURE sorter/filter over application-computed entries — each
// member's own swng index as of the season's first and last counted round. The index-at-boundary
// lookup itself (a bounded cross-read: one query per roster member) is Task 5's job in the
// application layer, deliberately NOT here — this stays a domain fold over already-resolved
// numbers, never a fetcher. Only a DROP (to < from) counts as improvement; a riser or a member
// missing either end is silently excluded, never zeroed or flagged.
export const mostImproved = (
  entries: readonly { readonly golferId: GolferId; readonly from?: number; readonly to?: number }[],
): readonly ImprovementEntry[] => {
  const drops: ImprovementEntry[] = [];
  for (const entry of entries) {
    if (entry.from === undefined || entry.to === undefined || !(entry.to < entry.from)) continue;
    drops.push({ golferId: entry.golferId, from: entry.from, to: entry.to });
  }
  return drops.sort((x, y) => {
    const dropX = x.from - x.to;
    const dropY = y.from - y.to;
    return dropX !== dropY ? dropY - dropX : x.golferId < y.golferId ? -1 : x.golferId > y.golferId ? 1 : 0;
  });
};

// Season title (spec §5): the Stableford points leader(s) of one season's ALREADY
// roster-filtered ledger (aggregateSeason's own output, current-roster-scoped one layer up) —
// [] when the ledger is empty or the leading points are 0 (a scoreless season crowns no one).
export const stablefordTitle = (ledger: readonly SeasonLedgerLine[]): readonly GolferId[] => {
  if (ledger.length === 0) return [];
  const maxPoints = Math.max(...ledger.map((line) => line.points));
  if (maxPoints === 0) return [];
  return ledger
    .filter((line) => line.points === maxPoints)
    .map((line) => line.golferId)
    .sort();
};
