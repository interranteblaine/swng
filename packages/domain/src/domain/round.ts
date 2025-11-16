import { DomainError } from "./error";
import type {
  IsoDateTime,
  Player,
  RoundConfig,
  RoundId,
  RoundSnapshot,
  RoundState,
  Score,
} from "./types";

export function createRoundConfig(options: {
  roundId: RoundId;
  accessCode: string;
  courseName: string;
  par: number[];
  createdAt: IsoDateTime;
}): RoundConfig {
  const { roundId, accessCode, courseName, par, createdAt } = options;

  if (par.length === 0) {
    throw new DomainError("par array must be non-empty");
  }

  const holes = par.length; // define away "holes vs par" mismatch

  return {
    roundId,
    accessCode,
    courseName,
    holes,
    par: [...par],
    createdAt,
  };
}

export function createInitialRoundState(
  roundId: RoundId,
  createdAt: IsoDateTime
): RoundState {
  return {
    roundId,
    currentHole: 1,
    status: "IN_PROGRESS",
    stateVersion: 1,
    updatedAt: createdAt,
  };
}

export function isValidHoleNumber(
  config: RoundConfig,
  holeNumber: number
): boolean {
  return (
    Number.isInteger(holeNumber) &&
    holeNumber >= 1 &&
    holeNumber <= config.holes
  );
}

export function makeRoundSnapshot(input: {
  config: RoundConfig;
  state: RoundState;
  players: Player[];
  scores: Score[];
}): RoundSnapshot {
  const { config, state, players, scores } = input;

  return {
    config,
    state,
    players: [...players],
    scores: [...scores],
  };
}
