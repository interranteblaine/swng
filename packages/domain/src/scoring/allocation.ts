import type { CourseCard } from "../course/card.js";
import { findTeeSet, isRated } from "../course/card.js";
import { DomainError } from "../errors.js";
import { adjustedGrossScore, scoreDifferential } from "../handicap/whs.js";
import type { GolferId } from "../ids.js";
import type { HoleResult } from "../round/holeResult.js";
import type { Participant } from "../round/participant.js";
import type { ScoreCell } from "../round/state.js";
import { cellAt } from "../round/state.js";
import { defaultAllowance, playingHandicap } from "./allowances.js";
import type { GameConfig } from "./game.js";
import { dotsByHole } from "./strokes.js";

const participantFor = (participants: readonly Participant[], id: GolferId): Participant => {
  const found = participants.find((p) => p.golferId === id);
  if (!found) throw new DomainError("unknown-participant", `no participant "${id}" joined this round`);
  return found;
};

// Consolidates the per-GAME stroke-allocation orchestration every scoring engine's own
// SI-based dots already encode internally (fourballMatch.ts, singlesMatch.ts,
// skins/stableford/strokePlay's own playingHandicap use) — this is the one place that
// re-derives "how many dots does each player get" from a GameConfig alone, pre-round,
// without re-running a full engine over a card. Kept byte-identical to what apps/web's
// dots.ts used to compute independently (M5 carry); web now delegates here (Task 5).
export const gameStrokeAllocation = (
  config: GameConfig,
  participants: readonly Participant[],
  card: CourseCard,
): ReadonlyMap<GolferId, ReadonlyMap<number, number>> => {
  const teeSetOf = (id: GolferId) => findTeeSet(card, participantFor(participants, id).tee);
  const chOf = (id: GolferId) => participantFor(participants, id).courseHandicap;

  switch (config.kind) {
    case "stroke-play": {
      // Gross play carries no handicap allowance at all — there is nothing to allocate.
      if (config.scoring === "gross") return new Map();
      const allowance = config.allowance ?? defaultAllowance("stroke-play");
      return new Map(config.players.map((id) => [id, dotsByHole(playingHandicap(chOf(id), allowance), teeSetOf(id))]));
    }
    case "stableford":
    case "skins": {
      const allowance = config.allowance ?? defaultAllowance(config.kind);
      return new Map(config.players.map((id) => [id, dotsByHole(playingHandicap(chOf(id), allowance), teeSetOf(id))]));
    }
    case "singles-match": {
      // Relative, not each player's own course handicap: only the higher-handicap
      // player receives dots (chHigh - chLow), the lower plays scratch.
      const allowance = config.allowance ?? defaultAllowance("singles-match");
      const chA = chOf(config.a);
      const chB = chOf(config.b);
      const higherIsA = chA >= chB;
      const higher = higherIsA ? config.a : config.b;
      const lower = higherIsA ? config.b : config.a;
      const diff = playingHandicap(Math.abs(chA - chB), allowance);
      return new Map([
        [higher, dotsByHole(diff, teeSetOf(higher))],
        [lower, dotsByHole(0, teeSetOf(lower))],
      ]);
    }
    case "fourball-match": {
      // Relative to the lowest playing handicap among the foursome.
      const allowance = config.allowance ?? defaultAllowance("fourball-match");
      const golfers = [...config.a, ...config.b];
      const playingHcps = new Map(golfers.map((id) => [id, playingHandicap(chOf(id), allowance)]));
      const lowHcp = Math.min(...playingHcps.values());
      return new Map(golfers.map((id) => [id, dotsByHole(playingHcps.get(id)! - lowHcp, teeSetOf(id))]));
    }
  }
};

// dotsByHole's allocation always sums exactly to its input strokes value (allocateStrokes' own
// documented invariant, strokes.ts) — summing here is safe rather than re-deriving a parallel
// "total dots" formula that could drift from the per-hole one above.
export const totalDots = (perHole: ReadonlyMap<number, number>): number => [...perHole.values()].reduce((sum, dots) => sum + dots, 0);

// A differential can only be posted once every tee-set hole has decided (a stroke count, a
// pickup, or a concession — adjustedGrossScore's own rule). Mid-round, or for a golfer who
// never finished, that's not an error — it's the ordinary "incomplete" case a v1 crew hits
// whenever someone walks in after a few holes or picks up on the last one.
//
// Lives here (not round/archive.ts) so it has exactly one implementation with two callers:
// settleRound below, and — per M6 Task 5 — the web's own handicapping display, which
// currently carries a drift-tested mirror of this exact function.
export const handicappingFor = (
  participant: Participant,
  card: CourseCard,
  cells: Readonly<Record<string, ScoreCell>>,
):
  | { readonly golferId: GolferId; readonly kind: "complete"; readonly ags: number; readonly differential: number }
  | { readonly golferId: GolferId; readonly kind: "unrated"; readonly ags: number }
  | { readonly golferId: GolferId; readonly kind: "incomplete" } => {
  const teeSet = findTeeSet(card, participant.tee);
  const holes = new Map<number, HoleResult>();
  for (const hole of teeSet.holes) {
    const cell = cellAt(cells, participant.golferId, hole.number);
    if (cell) holes.set(hole.number, cell.result);
  }
  try {
    const ags = adjustedGrossScore(teeSet, participant.courseHandicap, holes);
    // Unrated: the round is fully scored (AGS holds) but has no differential to post
    // (spec §4). It stays out of the WHS index by carrying no differential, never by a
    // downstream filter change.
    if (!isRated(teeSet)) return { golferId: participant.golferId, kind: "unrated", ags };
    // Raw per-tee-set differential only — combining two 9-hole differentials into one
    // 18-hole-equivalent is the index projection's job (published 2020 WHS rule), not
    // settlement's; the archive stays index-independent, per this tee set alone.
    const differential = scoreDifferential(teeSet, ags);
    return { golferId: participant.golferId, kind: "complete", ags, differential };
  } catch (error) {
    // holes-undecided is the one expected failure of a partial card; anything else (e.g.
    // an unknown tee-set name, which would mean a corrupt round) is a real bug and must
    // surface rather than be swallowed into a silent "incomplete".
    if (error instanceof DomainError && error.code === "holes-undecided") {
      return { golferId: participant.golferId, kind: "incomplete" };
    }
    throw error;
  }
};
