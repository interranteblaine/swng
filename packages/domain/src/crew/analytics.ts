import type { GolferId } from "../ids.js";
import type { RoundArchive } from "../round/archive.js";
import { configForResult } from "./ledger.js";
import type { SeasonLedgerLine } from "./ledger.js";

// Crew analytics — folds beside the existing standings (analytics spec 2026-07-21 §5): compute
// on read over a season's shared snapshots, nothing stored, current-roster scoping applies
// exactly as the existing ledger (`memberIds` narrows every fold, same as aggregateSeason's own
// roster filter one layer up). Mirrors ledger.ts's own idiom — a pure accumulator Map keyed on
// a canonical string, sorted once at the end. The lowest-net-average and most-improved-index
// folds (and their own result types) — the season superlatives these fed — are deleted whole
// (crew-scoreboard spec §3c: the per-member scoreboard supersedes winner-only callouts; keeping
// both would put two differently-defined net numbers on one page).

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
