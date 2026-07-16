import type { CourseCard } from "../course/card.js";
import { findTeeSet } from "../course/card.js";
import { DomainError } from "../errors.js";
import type { GameId, GolferId, RoundId } from "../ids.js";
import { handicappingFor } from "../scoring/allocation.js";
import type { GameConfig } from "../scoring/game.js";
import { scoreGame } from "../scoring/game.js";
import type { GameResult } from "../scoring/result.js";
import { resultOf } from "../scoring/result.js";
import type { RosterEntry } from "./participant.js";
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
  // A settled round is a sealed leaf: the archive records only the round's own facts and
  // references no crew. A crew that wants this round in a season counts it inbound by roundId
  // (CrewStore's counted rounds), so the outbound link this field used to be simply doesn't
  // exist anymore.
  readonly card: CourseCard;
  // Departed participants who settled carry `departed: true` (RosterEntry's optional flag);
  // everyone else has no such key — additive-optional so old snapshots deserialize unchanged.
  // A departed participant with nothing to aggregate is omitted here entirely (see settleRound).
  readonly participants: readonly RosterEntry[];
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
    | { readonly golferId: GolferId; readonly kind: "unrated"; readonly ags: number }
    | { readonly golferId: GolferId; readonly kind: "incomplete" }
  )[];
}

// Every golferId a game config references — the union across all five kinds' player fields
// (players[] for the medal family, a/b for singles, the two pairs for fourball). Used only
// by the departure omission rule below, and unconditional on termination: a config still
// "references" its players even if the game was later terminated. Exhaustive by kind — a new
// game kind must add its own arm here (TS flags the missing return path).
const gameMembers = (config: GameConfig): readonly GolferId[] => {
  switch (config.kind) {
    case "stroke-play":
    case "stableford":
    case "skins":
      return config.players;
    case "singles-match":
      return [config.a, config.b];
    case "fourball-match":
      return [...config.a, ...config.b];
  }
};

// Folds the log, then freezes it. Settlement only ever runs against a `final` round (the
// one lifecycle state that means "no more events are coming" in practice — a reopened round
// can still append), and every configured game must have resolved: a settled round with a
// hanging game is a contradiction the archive must never represent.
export const settleRound = (events: readonly RoundEvent[]): RoundArchive => {
  const state = reduceRound(events);
  // A scrapped round produces NO snapshot, ever — it counts nowhere (task-15). This is the
  // structural half of that promise: settlement refuses an abandoned log outright, so no
  // archive / handicap-index / crew-season path can ever derive a result from one. Checked
  // BEFORE the round-not-final guard below because "abandoned" is also not "final", and the
  // honest signal a caller (finalizeRound) needs is round-abandoned, not a misleading
  // round-not-final. Reachable via finalizeRound's own candidate log too: an abandon dominates
  // the fold (state.ts), so an appended round-finalized can never turn a scrapped round settleable.
  if (state.status === "abandoned") throw new DomainError("round-abandoned", "settleRound: a scrapped round has no snapshot");
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

  // Departure rule (accounts-only identity spec §4), applied additively on top of the ordinary
  // settle. "Leaving stops the future and never rewrites the past": a departed participant's
  // played holes and resolved games (concessions included) count exactly as scored — the
  // `departed: true` flag is already on the folded roster entry and simply rides along. The one
  // extra rule is the empty case: a departed participant with NO scored holes AND membership in
  // NO game is omitted from the archive entirely — no participant entry, no handicapping line —
  // so they appear nowhere downstream. That is settle deciding once, not a reader filtering:
  // there is genuinely nothing to aggregate for them. Every non-departed participant is kept
  // unconditionally (this filter only ever removes a departed one).
  const hasScoredHole = (entry: RosterEntry): boolean => {
    const teeSet = findTeeSet(state.card, entry.tee);
    return teeSet.holes.some((hole) => state.cells[cellKey(entry.golferId, hole.number)] !== undefined);
  };
  const inSomeGame = (golferId: GolferId): boolean => state.games.some((config) => gameMembers(config).includes(golferId));
  const settledParticipants = state.participants.filter((entry) => !entry.departed || hasScoredHole(entry) || inSomeGame(entry.golferId));

  const handicapping = settledParticipants.map((participant) => handicappingFor(participant, state.card, state.cells));

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
    participants: settledParticipants,
    games: state.games,
    cells: state.cells,
    events: canonicalEvents,
    results,
    terminatedGameIds,
    handicapping,
  };
};
