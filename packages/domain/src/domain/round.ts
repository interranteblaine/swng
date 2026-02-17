import { DomainError } from "./error";
import { coursePar } from "./course";
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
  course: CourseSnapshot;
  createdAt: IsoDateTime;
}): RoundConfig {
  const { roundId, accessCode, course, createdAt } = options;

  const par = coursePar(course);
  if (par.length === 0) {
    throw new DomainError("par array must be non-empty");
  }

  return {
    roundId,
    accessCode,
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
    holeNumber <= config.course.holeCount
  );
}
