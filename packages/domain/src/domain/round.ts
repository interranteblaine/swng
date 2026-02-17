import { DomainError } from "./error";
import type {
  CourseSnapshot,
  IsoDateTime,
  RoundConfig,
  RoundId,
  RoundState,
} from "./types";

export function createRoundConfig(options: {
  roundId: RoundId;
  accessCode: string;
  courseName: string;
  par: number[];
  createdAt: IsoDateTime;
  course?: CourseSnapshot;
}): RoundConfig {
  const { roundId, accessCode, courseName, par, createdAt, course } = options;

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
    course,
  };
}

export function createInitialRoundState(
  roundId: RoundId,
  createdAt: IsoDateTime
): RoundState {
  return {
    roundId,
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
