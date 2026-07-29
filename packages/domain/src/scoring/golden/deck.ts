import type { CourseCard } from "../../course/card.js";
import { deviceId, golferId, opId, roundId } from "../../ids.js";
import type { Hlc } from "../../round/hlc.js";
import type { HoleResult } from "../../round/holeResult.js";
import type { Participant } from "../../round/participant.js";
import type { RoundEvent } from "../../round/events.js";
import { reduceRound } from "../../round/state.js";
import type { RoundState } from "../../round/state.js";
import { scoreGame } from "../game.js";
import type { GameConfig, GameState } from "../game.js";

// Fixtures write scores as numbers, the "picked-up" literal, or null — the same vocabulary a
// scorer taps in on the wire, kept out of HoleResult's shape. null means "no cell recorded for
// this hole": the deck emits no score-recorded event for it at all, letting a card leave a gap
// anywhere (not just a dense unrecorded suffix) — the medal-family engines (stableford, stroke
// play, skins) resolve a decided hole wherever its cell exists, unlike match play's sequential
// decided-prefix.
//
// No "conceded" shorthand (task-2, spec §2d): a conceded hole now REQUIRES a strokes number
// (HoleResult's conceded arm), so a bare string literal can no longer stand for one — inventing
// a number here to keep the shorthand would fabricate a score no fixture ever specified. Every
// deck that needs a conceded cell (this file's own callers today have none — see fieldDeck18)
// builds the raw score-recorded RoundEvent directly and appends it to the log, the same way
// every "cleared" cell already has to (that kind was never representable here either).
export type FixtureScores = Readonly<Record<string, ReadonlyArray<number | "picked-up" | null>>>;

// A correction rewrites one already-recorded cell: the deck appends it as a raw
// score-recorded event AFTER every initial score, so its hlc is strictly later
// and the fold's LWW cell register resolves it as the winner.
export interface FixtureCorrection {
  readonly golfer: string;
  readonly hole: number;
  readonly score: number | "picked-up";
}

// A golden deck only needs a single fictitious recorder — provenance of the
// scaffolding events (genesis, joins, game-added, started) is never asserted on.
const RECORDER = golferId("golden-recorder");
const DEVICE = deviceId("golden-deck");

// Builds a minimal, canonically-ordered event log — genesis, joins, games, start,
// then one score-recorded per (golfer, hole) in fixture order, then any corrections,
// optionally closed out with a round-finalized. hlcs are sequential and never tie:
// a correction's hlc is always strictly later than the score it replaces, which is
// exactly what lets it win the fold's LWW cell resolution deterministically. Same-hlc
// concurrency (two writes racing at the identical instant) is deliberately out of
// scope here — that's state.properties.test.ts's job.
const buildGoldenLog = (
  card: CourseCard,
  participants: readonly Participant[],
  games: readonly GameConfig[],
  scores: FixtureScores,
  corrections: readonly FixtureCorrection[],
  finalize: boolean,
): { readonly events: readonly RoundEvent[]; readonly state: RoundState } => {
  let wallMs = 0;
  let opCounter = 0;
  const nextHlc = (): Hlc => ({ wallMs: wallMs++, counter: 0, deviceId: DEVICE });
  const nextOpId = () => opId(`golden-${opCounter++}`);
  const toResult = (score: number | "picked-up"): HoleResult =>
    score === "picked-up" ? { kind: score } : { kind: "strokes", strokes: score };

  const events: RoundEvent[] = [
    { kind: "round-created", roundId: roundId("golden"), card, opId: nextOpId(), hlc: nextHlc(), authorId: RECORDER },
    ...participants.map(
      (participant): RoundEvent => ({ kind: "participant-joined", participant, opId: nextOpId(), hlc: nextHlc(), authorId: participant.golferId }),
    ),
    ...games.map((config): RoundEvent => ({ kind: "game-added", config, opId: nextOpId(), hlc: nextHlc(), authorId: RECORDER })),
    { kind: "round-started", opId: nextOpId(), hlc: nextHlc(), authorId: RECORDER },
  ];

  for (const [golfer, holeScores] of Object.entries(scores)) {
    holeScores.forEach((score, index) => {
      if (score === null) return; // deliberate gap — no cell recorded for this hole
      events.push({
        kind: "score-recorded",
        golferId: golferId(golfer),
        hole: index + 1,
        result: toResult(score),
        opId: nextOpId(),
        hlc: nextHlc(),
        authorId: golferId(golfer),
      });
    });
  }

  for (const { golfer, hole, score } of corrections) {
    events.push({
      kind: "score-recorded",
      golferId: golferId(golfer),
      hole,
      result: toResult(score),
      opId: nextOpId(),
      hlc: nextHlc(),
      authorId: golferId(golfer),
    });
  }

  if (finalize) {
    events.push({ kind: "round-finalized", opId: nextOpId(), hlc: nextHlc(), authorId: RECORDER });
  }

  return { events, state: reduceRound(events) };
};

export const playGoldenRound = (
  card: CourseCard,
  participants: readonly Participant[],
  games: readonly GameConfig[],
  scores: FixtureScores,
  corrections: readonly FixtureCorrection[] = [],
): GameState[] => {
  const { state } = buildGoldenLog(card, participants, games, scores, corrections, false);
  // Score the games as reduceRound ordered them (join order by first-write hlc),
  // not the caller's array — the two coincide in every deck here, but this is
  // the shape production code actually consumes (it only ever has state.games).
  return state.games.map((config) => scoreGame(config, state));
};

// Same deck, but exposes the raw event log instead of scored GameStates — what
// settlement tests need (settleRound consumes an event log, not a GameState array).
// finalize defaults true since the common settlement case is "the round is over";
// pass false to build a log settleRound should reject as not-yet-final.
export const playGoldenRoundLog = (
  card: CourseCard,
  participants: readonly Participant[],
  games: readonly GameConfig[],
  scores: FixtureScores,
  corrections: readonly FixtureCorrection[] = [],
  finalize = true,
): readonly RoundEvent[] => buildGoldenLog(card, participants, games, scores, corrections, finalize).events;
