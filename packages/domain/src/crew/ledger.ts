import { DomainError } from "../errors.js";
import type { GolferId, RoundId } from "../ids.js";
import type { RoundArchive } from "../round/archive.js";

interface CrewLine {
  readonly wins: number;
  readonly losses: number;
  readonly halves: number;
  readonly points: number;
  readonly skins: number;
}

const ZERO_LINE: CrewLine = { wins: 0, losses: 0, halves: 0, points: 0, skins: 0 };

// One archive's contribution to a crew's records — pure, so it can run identically inside
// the projector (application layer, projecting live) and offline (a rebuild replaying every
// finalized archive). See product.md §6 (the ledger) / architecture.md's projections table
// (`LEDGER#crew#season`, `H2H#crew#a#b`).
export interface CrewRoundContribution {
  readonly roundId: RoundId;
  // One line per golfer who appears in >=1 COUNTED game (singles/fourball/stableford/skins)
  // — never per participant. A golfer who only played stroke-play in this round (the one
  // format with no ledger column in v1) gets no line at all, not an all-zero one.
  readonly lines: readonly { readonly golferId: GolferId; readonly wins: number; readonly losses: number; readonly halves: number; readonly points: number; readonly skins: number }[];
  // singles-match results ONLY — v1's head-to-head is singles-only (fourball's "sides", not
  // individuals, don't map onto a golfer-pair record the way a singles match does).
  readonly headToHead: readonly { readonly a: GolferId; readonly b: GolferId; readonly outcome: "a" | "b" | "halved" }[];
}

// archive.games and archive.results share ids (settleRound builds every result directly
// from a config in archive.games — round/archive.ts), so a result always has a matching
// config at the same id; the lookup below narrows the union for TS, not for a case that can
// actually happen at runtime.
const configForResult = <Kind extends string>(archive: RoundArchive, id: string, kind: Kind): Extract<RoundArchive["games"][number], { readonly kind: Kind }> => {
  const config = archive.games.find((candidate) => candidate.id === id);
  if (config?.kind !== kind) {
    throw new DomainError("crew-ledger-config-mismatch", `no "${kind}" config for result "${id}" in archive "${archive.roundId}"`);
  }
  return config as Extract<RoundArchive["games"][number], { readonly kind: Kind }>;
};

export const crewContribution = (archive: RoundArchive): CrewRoundContribution => {
  const lines = new Map<GolferId, CrewLine>();
  const add = (golferId: GolferId, delta: Partial<CrewLine>): void => {
    const current = lines.get(golferId) ?? ZERO_LINE;
    lines.set(golferId, {
      wins: current.wins + (delta.wins ?? 0),
      losses: current.losses + (delta.losses ?? 0),
      halves: current.halves + (delta.halves ?? 0),
      points: current.points + (delta.points ?? 0),
      skins: current.skins + (delta.skins ?? 0),
    });
  };

  const headToHead: { a: GolferId; b: GolferId; outcome: "a" | "b" | "halved" }[] = [];

  // Terminated games have no results entry by construction (settleRound filters them
  // before building `results` — round/archive.ts) — iterating archive.results, not
  // archive.games, is what makes "terminated games contribute nothing" fall out for free.
  for (const result of archive.results) {
    switch (result.kind) {
      case "singles-match": {
        const config = configForResult(archive, result.id, "singles-match");
        // Canonical order for the ledger's pair identity is plain lexicographic golferId
        // comparison — independent of which side the config happened to store as a/b.
        const [canonicalA, canonicalB] = config.a < config.b ? [config.a, config.b] : [config.b, config.a];
        if ("halved" in result.outcome) {
          add(config.a, { halves: 1 });
          add(config.b, { halves: 1 });
          headToHead.push({ a: canonicalA, b: canonicalB, outcome: "halved" });
        } else {
          const winner = result.outcome.winner;
          const loser = winner === config.a ? config.b : config.a;
          add(winner, { wins: 1 });
          add(loser, { losses: 1 });
          headToHead.push({ a: canonicalA, b: canonicalB, outcome: winner === canonicalA ? "a" : "b" });
        }
        break;
      }
      case "fourball-match": {
        const config = configForResult(archive, result.id, "fourball-match");
        // No headToHead entry — v1's head-to-head is singles-only (see the interface doc).
        if ("halved" in result.outcome) {
          for (const golferId of [...config.a, ...config.b]) add(golferId, { halves: 1 });
        } else {
          const winningSide = result.outcome.winner === "a" ? config.a : config.b;
          const losingSide = result.outcome.winner === "a" ? config.b : config.a;
          for (const golferId of winningSide) add(golferId, { wins: 1 });
          for (const golferId of losingSide) add(golferId, { losses: 1 });
        }
        break;
      }
      case "stableford":
        for (const { golferId, points } of result.points) add(golferId, { points });
        break;
      case "skins":
        for (const { golferId, skins } of result.won) add(golferId, { skins });
        break;
      case "stroke-play":
        // Deliberately absent: the ledger has no medal column in v1 (wins come from
        // singles+fourball, points from stableford, skins from skins) — stroke-play
        // results never touch `lines`.
        break;
      default:
        // Exhaustive at compile time; guards a result kind added to the union without a
        // matching arm here (or a runtime value that bypassed the type system).
        throw new DomainError("unknown-game-kind", `crewContribution has no rule for game kind "${(result as { kind: string }).kind}"`);
    }
  }

  const sortedLines = [...lines.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([golferId, line]) => ({ golferId, ...line }));

  return { roundId: archive.roundId, lines: sortedLines, headToHead };
};

export interface SeasonLedgerLine {
  readonly golferId: GolferId;
  readonly rounds: number;
  readonly wins: number;
  readonly losses: number;
  readonly halves: number;
  readonly points: number;
  readonly skins: number;
}

export interface HeadToHeadRecord {
  readonly a: GolferId;
  readonly b: GolferId;
  readonly aWins: number;
  readonly bWins: number;
  readonly halves: number;
}

// Pure fold over every archive's contribution — order-independent because it's nothing but
// commutative addition into per-golfer/per-pair accumulators (a permutation of the input
// array visits the same additions in a different order, same sums either way).
export const aggregateSeason = (
  contributions: readonly CrewRoundContribution[],
): { readonly ledger: readonly SeasonLedgerLine[]; readonly headToHead: readonly HeadToHeadRecord[] } => {
  const ledgerByGolfer = new Map<GolferId, { rounds: number } & CrewLine>();
  const h2hByPair = new Map<string, { a: GolferId; b: GolferId; aWins: number; bWins: number; halves: number }>();

  for (const contribution of contributions) {
    for (const line of contribution.lines) {
      const current = ledgerByGolfer.get(line.golferId) ?? { rounds: 0, ...ZERO_LINE };
      ledgerByGolfer.set(line.golferId, {
        rounds: current.rounds + 1,
        wins: current.wins + line.wins,
        losses: current.losses + line.losses,
        halves: current.halves + line.halves,
        points: current.points + line.points,
        skins: current.skins + line.skins,
      });
    }
    for (const h2h of contribution.headToHead) {
      // Keyed on the already-canonical a/b that crewContribution produced — never
      // re-canonicalized here, since aggregateSeason has no config to derive it from.
      const key = `${h2h.a}#${h2h.b}`;
      const current = h2hByPair.get(key) ?? { a: h2h.a, b: h2h.b, aWins: 0, bWins: 0, halves: 0 };
      h2hByPair.set(key, {
        a: current.a,
        b: current.b,
        aWins: current.aWins + (h2h.outcome === "a" ? 1 : 0),
        bWins: current.bWins + (h2h.outcome === "b" ? 1 : 0),
        halves: current.halves + (h2h.outcome === "halved" ? 1 : 0),
      });
    }
  }

  const ledger = [...ledgerByGolfer.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([golferId, stats]) => ({ golferId, ...stats }));

  const headToHead = [...h2hByPair.values()].sort((x, y) => (x.a !== y.a ? (x.a < y.a ? -1 : 1) : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));

  return { ledger, headToHead };
};
