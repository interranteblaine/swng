import type { CourseCard } from "../course/card.js";
import { DomainError } from "../errors.js";
import type { CrewId, GameId, GolferId, RoundId } from "../ids.js";
import { handicappingFor } from "../scoring/allocation.js";
import type { GameConfig } from "../scoring/game.js";
import { scoreGame } from "../scoring/game.js";
import type { GameResult } from "../scoring/result.js";
import { resultOf } from "../scoring/result.js";
import type { Participant } from "./participant.js";
import type { RoundEvent } from "./events.js";
import type { ScoreCell } from "./state.js";
import { byCanonicalOrder, reduceRound, withoutSeq } from "./state.js";

// The event log's write side is RoundState — a live projection that keeps re-folding as
// new events arrive. RoundArchive is its terminal read side: the frozen, content-addressed
// snapshot a `final` round settles into once, handed off to durable storage, results
// screens, and the handicap index pipeline. Nothing here ever changes after settlement —
// a correction to a finalized round is a new round-reopened + more events + a re-settle,
// never a mutation of an existing archive.
export interface RoundArchive {
  readonly roundId: RoundId;
  // Carried verbatim from RoundState.crewId (itself fixed at genesis) — a round's crew tag
  // never changes across the settle boundary, same as every other field here.
  readonly crewId?: CrewId;
  readonly card: CourseCard;
  readonly participants: readonly Participant[];
  readonly games: readonly GameConfig[];
  readonly cells: Readonly<Record<string, ScoreCell>>;
  readonly events: readonly RoundEvent[]; // canonical domain order — the replay source
  readonly results: readonly GameResult[];
  // Sorted lexicographically — canonical, arrival-order-independent, like every other
  // archive field. `games` above keeps every config regardless (audit trail); this is
  // the honest record of which of them were terminated rather than resolved.
  readonly terminatedGameIds: readonly GameId[];
  readonly handicapping: readonly (
    | { readonly golferId: GolferId; readonly kind: "complete"; readonly ags: number; readonly differential: number }
    | { readonly golferId: GolferId; readonly kind: "incomplete" }
  )[];
}

// Folds the log, then freezes it. Settlement only ever runs against a `final` round (the
// one lifecycle state that means "no more events are coming" in practice — a reopened round
// can still append), and every configured game must have resolved: a settled round with a
// hanging game is a contradiction the archive must never represent.
export const settleRound = (events: readonly RoundEvent[]): RoundArchive => {
  const state = reduceRound(events);
  if (state.status !== "final") throw new DomainError("round-not-final", "settleRound requires a final round");

  // A terminated game never joins the must-resolve set — settlement isn't waiting on a
  // result that will never come. It stays in `games` below (audit); it's simply absent
  // from `results`.
  const results = state.games
    .filter((config) => !state.terminatedGameIds.has(config.id))
    .map((config) => {
      const result = resultOf(scoreGame(config, state));
      if (!result) throw new DomainError("game-unresolved", `game "${config.id}" never resolved`);
      return result;
    });

  const terminatedGameIds = [...state.terminatedGameIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

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
    crewId: state.crewId,
    card: state.card,
    participants: state.participants,
    games: state.games,
    cells: state.cells,
    events: canonicalEvents,
    results,
    terminatedGameIds,
    handicapping,
  };
};
