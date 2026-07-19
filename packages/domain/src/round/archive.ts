import type { CourseCard } from "../course/card.js";
import { findTeeSet } from "../course/card.js";
import { DomainError } from "../errors.js";
import type { GameId, GolferId, RoundId } from "../ids.js";
import { handicappingFor } from "../scoring/allocation.js";
import type { GameConfig } from "../scoring/game.js";
import { gameMembers, scoreGame } from "../scoring/game.js";
import type { GameResult } from "../scoring/result.js";
import { resultOf } from "../scoring/result.js";
import type { RosterEntry } from "./participant.js";
import type { RoundEvent } from "./events.js";
import type { RoundState, ScoreCell } from "./state.js";
import { byCanonicalOrder, cellAt, reduceRound, withoutSeq } from "./state.js";

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

// The must-resolve set: every configured game except one explicitly terminated (a terminated
// game is never waiting on a result that will never come — it stays in `state.games` for
// audit, just excluded here). This is the ONE filter settleRound's own throw path below and
// the live finalize-readiness view (unresolvedGames, bottom of file) both walk — factored out
// so there is exactly one place in the domain that decides which games block finalize.
const mustResolve = (state: RoundState): readonly GameConfig[] => state.games.filter((config) => !state.terminatedGameIds.has(config.id));

// The ONE resolved/unresolved predicate mustResolve's members are tested against — scores the
// config fresh against the current fold and asks resultOf whether it has settled. Shared by
// settleRound (throws when this comes back undefined) and unresolvedGames (collects the
// configs where it does), so "is this game done" is decided in exactly one place too.
const resolvedResultOf = (config: GameConfig, state: RoundState): GameResult | undefined => resultOf(scoreGame(config, state));

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

  const results = mustResolve(state).map((config) => {
    const result = resolvedResultOf(config, state);
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
    return teeSet.holes.some((hole) => cellAt(state.cells, entry.golferId, hole.number) !== undefined);
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

// The per-golfer holes NOT yet scored, in card order. Same convention ScorecardGrid.tsx and
// the (now-deleted) web finalizeReadiness.ts both used: the first tee set's hole numbering —
// shared canonically by every tee at a course, since only yardage/rating/slope vary per tee.
const missingHolesFor = (state: RoundState, golfer: GolferId): readonly number[] => {
  const holes = state.card.teeSets[0]?.holes ?? [];
  return holes.filter((hole) => cellAt(state.cells, golfer, hole.number) === undefined).map((hole) => hole.number);
};

export interface UnresolvedGameMissing {
  readonly golferId: GolferId;
  readonly holes: readonly number[]; // never empty — a fully-scored golfer is omitted, not listed with []
}

export interface UnresolvedGame {
  readonly gameId: GameId;
  readonly missing: readonly UnresolvedGameMissing[]; // one entry per game-member golfer who still has holes open
}

// The finalize dialog's readiness view of the SAME must-resolve set settleRound's throw path
// enforces above — a live, non-throwing read of "what's still blocking finalize right now"
// instead of settleRound's all-or-nothing throw. Reused, not reimplemented: this walks
// `mustResolve` and tests the identical `resolvedResultOf` predicate settleRound itself uses,
// so there is exactly one place in the domain that decides which games must resolve before
// finalize — a game a caller would 409 on right now, and only that game, comes back here.
export const unresolvedGames = (state: RoundState): readonly UnresolvedGame[] =>
  mustResolve(state)
    .filter((config) => resolvedResultOf(config, state) === undefined)
    .map((config) => ({
      gameId: config.id,
      missing: gameMembers(config)
        .map((golferId) => ({ golferId, holes: missingHolesFor(state, golferId) }))
        .filter((entry) => entry.holes.length > 0),
    }));
