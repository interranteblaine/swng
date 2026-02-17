import { DomainError } from "./error";
import type {
  Course,
  CourseId,
  CourseSnapshot,
  IsoDateTime,
  TeeHole,
  TeeSet,
} from "./types";

export function validateTeeSet(teeSet: TeeSet, holeCount: number): void {
  if (!teeSet.name || teeSet.name.trim().length === 0) {
    throw new DomainError("Tee set name must be non-empty");
  }

  if (!teeSet.color || teeSet.color.trim().length === 0) {
    throw new DomainError("Tee set color must be non-empty");
  }

  if (teeSet.courseRating < 50 || teeSet.courseRating > 90) {
    throw new DomainError(
      `Course rating must be between 50 and 90, got ${teeSet.courseRating}`
    );
  }

  if (
    !Number.isInteger(teeSet.slopeRating) ||
    teeSet.slopeRating < 55 ||
    teeSet.slopeRating > 155
  ) {
    throw new DomainError(
      `Slope rating must be an integer between 55 and 155, got ${teeSet.slopeRating}`
    );
  }

  if (teeSet.holes.length !== holeCount) {
    throw new DomainError(
      `Tee set "${teeSet.name}" must have exactly ${holeCount} holes, got ${teeSet.holes.length}`
    );
  }

  const holeNumbers = new Set<number>();
  const handicapIndices = new Set<number>();

  for (const hole of teeSet.holes) {
    validateTeeHole(hole);
    holeNumbers.add(hole.holeNumber);
    handicapIndices.add(hole.handicapIndex);
  }

  // Hole numbers must be exactly 1..holeCount
  if (holeNumbers.size !== holeCount) {
    throw new DomainError(
      `Tee set "${teeSet.name}" has duplicate hole numbers`
    );
  }
  for (let i = 1; i <= holeCount; i++) {
    if (!holeNumbers.has(i)) {
      throw new DomainError(
        `Tee set "${teeSet.name}" is missing hole number ${i}`
      );
    }
  }

  // Handicap indices must be exactly 1..holeCount
  if (handicapIndices.size !== holeCount) {
    throw new DomainError(
      `Tee set "${teeSet.name}" has duplicate handicap indices`
    );
  }
  for (let i = 1; i <= holeCount; i++) {
    if (!handicapIndices.has(i)) {
      throw new DomainError(
        `Tee set "${teeSet.name}" is missing handicap index ${i}`
      );
    }
  }
}

function validateTeeHole(hole: TeeHole): void {
  if (hole.par !== 3 && hole.par !== 4 && hole.par !== 5) {
    throw new DomainError(
      `Par must be 3, 4, or 5, got ${hole.par} for hole ${hole.holeNumber}`
    );
  }

  if (!Number.isInteger(hole.yardage) || hole.yardage <= 0) {
    throw new DomainError(
      `Yardage must be a positive integer, got ${hole.yardage} for hole ${hole.holeNumber}`
    );
  }
}

export function createCourse(options: {
  courseId: CourseId;
  name: string;
  location?: string;
  holeCount: number;
  teeSets: TeeSet[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}): Course {
  const { courseId, name, location, holeCount, teeSets, createdAt, updatedAt } =
    options;

  if (!name || name.trim().length === 0) {
    throw new DomainError("Course name must be non-empty");
  }

  if (holeCount !== 9 && holeCount !== 18) {
    throw new DomainError(`Hole count must be 9 or 18, got ${holeCount}`);
  }

  if (teeSets.length === 0) {
    throw new DomainError("Course must have at least one tee set");
  }

  const teeSetNames = new Set(
    teeSets.map((ts) => ts.name.trim().toLowerCase())
  );
  if (teeSetNames.size !== teeSets.length) {
    throw new DomainError("Tee set names must be unique");
  }

  for (const teeSet of teeSets) {
    validateTeeSet(teeSet, holeCount);
  }

  return {
    courseId,
    name,
    location,
    holeCount,
    teeSets,
    createdAt,
    updatedAt,
  };
}

export function teeSetPar(teeSet: TeeSet): number[] {
  return [...teeSet.holes]
    .sort((a, b) => a.holeNumber - b.holeNumber)
    .map((h) => h.par);
}

export function findTeeSet(
  teeSets: TeeSet[],
  name: string
): TeeSet | undefined {
  const lower = name.toLowerCase();
  return teeSets.find((ts) => ts.name.toLowerCase() === lower);
}

export function toCourseSnapshot(course: Course): CourseSnapshot {
  return {
    courseId: course.courseId,
    name: course.name,
    location: course.location,
    holeCount: course.holeCount,
    teeSets: course.teeSets,
  };
}
