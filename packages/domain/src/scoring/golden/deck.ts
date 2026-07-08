import type { CourseCard } from "../../course/card.js";
import { deviceId, golferId, opId, roundId } from "../../ids.js";
import type { Hlc } from "../../round/hlc.js";
import type { HoleResult } from "../../round/holeResult.js";
import type { Participant } from "../../round/participant.js";
import type { RoundEvent } from "../../round/events.js";
import { reduceRound } from "../../round/state.js";
import { scoreGame } from "../game.js";
import type { GameConfig, GameState } from "../game.js";

// Fixtures write scores as numbers or the "picked-up"/"conceded" literals — the
// same vocabulary a scorer taps in on the wire, kept out of HoleResult's shape.
export type FixtureScores = Readonly<Record<string, ReadonlyArray<number | "picked-up" | "conceded">>>;

// A correction rewrites one already-recorded cell: the deck appends it as a raw
// score-recorded event AFTER every initial score, so its hlc is strictly later
// and the fold's LWW cell register resolves it as the winner.
export interface FixtureCorrection {
  readonly golfer: string;
  readonly hole: number;
  readonly score: number | "picked-up" | "conceded";
}

// A golden deck only needs a single fictitious recorder — provenance of the
// scaffolding events (genesis, joins, game-added, started) is never asserted on.
const RECORDER = golferId("golden-recorder");
const DEVICE = deviceId("golden-deck");

// Builds a minimal, canonically-ordered event log — genesis, joins, games, start,
// then one score-recorded per (golfer, hole) in fixture order — reduces it, and
// scores every configured game against the result. Sequential hlcs are enough
// here because the golden decks never need to exercise conflict resolution;
// that's state.properties.test.ts's job.
export const playGoldenRound = (
  card: CourseCard,
  participants: readonly Participant[],
  games: readonly GameConfig[],
  scores: FixtureScores,
  corrections: readonly FixtureCorrection[] = [],
): GameState[] => {
  let wallMs = 0;
  let seq = 0;
  const nextHlc = (): Hlc => ({ wallMs: wallMs++, counter: 0, deviceId: DEVICE });
  const nextOpId = () => opId(`golden-${seq++}`);
  const toResult = (score: number | "picked-up" | "conceded"): HoleResult =>
    score === "picked-up" || score === "conceded" ? { kind: score } : { kind: "strokes", strokes: score };

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

  const state = reduceRound(events);
  // Score the games as reduceRound ordered them (join order by first-write hlc),
  // not the caller's array — the two coincide in every deck here, but this is
  // the shape production code actually consumes (it only ever has state.games).
  return state.games.map((config) => scoreGame(config, state));
};
