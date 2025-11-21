import type { Score, PlayerId, RoundId, IsoDateTime } from "@swng/domain";
import { scoreSk, roundPk } from "./keys";

export interface ScoreItem {
  PK: string;
  SK: string;
  roundId: RoundId;
  playerId: PlayerId;
  holeNumber: number;
  strokes: number;
  updatedBy: PlayerId;
  updatedAt: IsoDateTime;
}

export function toScoreItem(score: Score): ScoreItem {
  return {
    PK: roundPk(score.roundId),
    SK: scoreSk(score.playerId, score.holeNumber),
    roundId: score.roundId,
    playerId: score.playerId,
    holeNumber: score.holeNumber,
    strokes: score.strokes,
    updatedBy: score.updatedBy,
    updatedAt: score.updatedAt,
  };
}

export function fromScoreItem(item: ScoreItem): Score {
  return {
    roundId: item.roundId,
    playerId: item.playerId,
    holeNumber: item.holeNumber,
    strokes: item.strokes,
    updatedBy: item.updatedBy,
    updatedAt: item.updatedAt,
  };
}
