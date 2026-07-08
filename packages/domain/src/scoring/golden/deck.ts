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
): GameState[] => {
  let wallMs = 0;
  let seq = 0;
  const nextHlc = (): Hlc => ({ wallMs: wallMs++, counter: 0, deviceId: DEVICE });
  const nextOpId = () => opId(`golden-${seq++}`);

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
      const result: HoleResult = score === "picked-up" || score === "conceded" ? { kind: score } : { kind: "strokes", strokes: score };
      events.push({
        kind: "score-recorded",
        golferId: golferId(golfer),
        hole: index + 1,
        result,
        opId: nextOpId(),
        hlc: nextHlc(),
        authorId: golferId(golfer),
      });
    });
  }

  const state = reduceRound(events);
  return games.map((config) => scoreGame(config, state));
};
