import type { CourseCard } from "../course/card.js";
import { findTeeSet } from "../course/card.js";
import { DomainError } from "../errors.js";
import { adjustedGrossScore, scoreDifferential } from "../handicap/whs.js";
import type { GolferId, RoundId } from "../ids.js";
import type { GameConfig } from "../scoring/game.js";
import { scoreGame } from "../scoring/game.js";
import type { GameResult } from "../scoring/result.js";
import { resultOf } from "../scoring/result.js";
import type { HoleResult } from "./holeResult.js";
import type { Participant } from "./participant.js";
import type { RoundEvent } from "./events.js";
import type { ScoreCell } from "./state.js";
import { byCanonicalOrder, cellKey, reduceRound, withoutSeq } from "./state.js";

// The event log's write side is RoundState — a live projection that keeps re-folding as
// new events arrive. RoundArchive is its terminal read side: the frozen, content-addressed
// snapshot a `final` round settles into once, handed off to durable storage, results
// screens, and the handicap index pipeline. Nothing here ever changes after settlement —
// a correction to a finalized round is a new round-reopened + more events + a re-settle,
// never a mutation of an existing archive.
export interface RoundArchive {
  readonly roundId: RoundId;
  readonly card: CourseCard;
  readonly participants: readonly Participant[];
  readonly games: readonly GameConfig[];
  readonly cells: Readonly<Record<string, ScoreCell>>;
  readonly events: readonly RoundEvent[]; // canonical domain order — the replay source
  readonly results: readonly GameResult[];
  readonly handicapping: readonly (
    | { readonly golferId: GolferId; readonly kind: "complete"; readonly ags: number; readonly differential: number }
    | { readonly golferId: GolferId; readonly kind: "incomplete" }
  )[];
}

// A differential can only be posted once every tee-set hole has decided (a stroke count, a
// pickup, or a concession — adjustedGrossScore's own rule). Mid-round, or for a golfer who
// never finished, that's not an error — it's the ordinary "incomplete" case a v1 crew hits
// whenever someone walks in after a few holes or picks up on the last one.
const handicappingFor = (
  participant: Participant,
  card: CourseCard,
  cells: Readonly<Record<string, ScoreCell>>,
): RoundArchive["handicapping"][number] => {
  const teeSet = findTeeSet(card, participant.tee);
  const holes = new Map<number, HoleResult>();
  for (const hole of teeSet.holes) {
    const cell = cells[cellKey(participant.golferId, hole.number)];
    if (cell) holes.set(hole.number, cell.result);
  }
  try {
    const ags = adjustedGrossScore(teeSet, participant.courseHandicap, holes);
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

// Folds the log, then freezes it. Settlement only ever runs against a `final` round (the
// one lifecycle state that means "no more events are coming" in practice — a reopened round
// can still append), and every configured game must have resolved: a settled round with a
// hanging game is a contradiction the archive must never represent.
export const settleRound = (events: readonly RoundEvent[]): RoundArchive => {
  const state = reduceRound(events);
  if (state.status !== "final") throw new DomainError("round-not-final", "settleRound requires a final round");

  const results = state.games.map((config) => {
    const result = resultOf(scoreGame(config, state));
    if (!result) throw new DomainError("game-unresolved", `game "${config.id}" never resolved`);
    return result;
  });

  const handicapping = state.participants.map((participant) => handicappingFor(participant, state.card, state.cells));

  // seq is server-ack metadata, not event content (see state.ts) — the archive's identity
  // must be the same regardless of which device's copy happened to get acked, so every
  // envelope is stripped of it here, after sorting into the one order that depends only on
  // content (byCanonicalOrder) rather than delivery or input array position.
  const canonicalEvents = [...events].sort(byCanonicalOrder).map(withoutSeq);

  // One literal object shape, fields in a fixed order, every time this runs — the mechanism
  // that makes JSON.stringify(settleRound(log)) order-stable is this literal's key order
  // never varying, on top of every field above already being independent of input order.
  return {
    roundId: state.id,
    card: state.card,
    participants: state.participants,
    games: state.games,
    cells: state.cells,
    events: canonicalEvents,
    results,
    handicapping,
  };
};
