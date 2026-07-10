import type { CourseCard, TeeSet } from "./card.js";
import { DomainError } from "../errors.js";
import type { CourseId } from "../ids.js";

// Where a tee set's numbers came from: typed in by a community scorer, or
// ingested from an external course-data source (identity/authority for either
// case lands in M7 — for now this is just provenance metadata on the version).
export type Provenance = "community" | "imported";

export interface TeeSetVersion {
  readonly version: number; // 1-based, monotonic per tee name
  readonly status: "current" | "superseded";
  readonly provenance: Provenance;
  readonly enteredBy: string; // display name; identity lands M7
  readonly enteredAtMs: number;
  readonly verifications: readonly { readonly name: string; readonly atMs: number }[];
  readonly tee: TeeSet; // the existing scoring shape, embedded whole
}

// Every version of every tee name ever entered, never pruned — a course's audit
// trail. Exactly one version per tee name is ever "current" (courseCardOf's
// input invariant); the rest are "superseded" history.
export interface Course {
  readonly courseId: CourseId;
  readonly name: string;
  readonly teeSets: readonly TeeSetVersion[];
}

const MAX_COURSE_NAME_LENGTH = 80;
const MAX_TEE_NAME_LENGTH = 40;
const PAR_BOUNDS = { min: 3, max: 6 };
const YARDAGE_BOUNDS = { min: 1, max: 800 };
const RATING_BOUNDS = { min: 30, max: 90 };
// USGA-published Slope Rating bounds (55 easiest .. 155 hardest).
const SLOPE_BOUNDS = { min: 55, max: 155 };

const validateCourseName = (name: string): void => {
  if (name.trim().length === 0 || name.length > MAX_COURSE_NAME_LENGTH) {
    throw new DomainError("invalid-course-name", `course name must be 1-${MAX_COURSE_NAME_LENGTH} characters: "${name}"`);
  }
};

// Shared by createCourse and addTeeSet so a tee set is held to identical rules
// regardless of which call introduced it — the invariant table lives exactly once.
const validateTeeSet = (tee: TeeSet): void => {
  if (tee.name.trim().length === 0 || tee.name.length > MAX_TEE_NAME_LENGTH) {
    throw new DomainError("invalid-tee-name", `tee name must be 1-${MAX_TEE_NAME_LENGTH} characters: "${tee.name}"`);
  }
  if (tee.rating < RATING_BOUNDS.min || tee.rating > RATING_BOUNDS.max) {
    throw new DomainError("invalid-rating", `tee "${tee.name}" rating ${tee.rating} outside ${RATING_BOUNDS.min}..${RATING_BOUNDS.max}`);
  }
  if (!Number.isInteger(tee.slope) || tee.slope < SLOPE_BOUNDS.min || tee.slope > SLOPE_BOUNDS.max) {
    throw new DomainError("invalid-slope", `tee "${tee.name}" slope ${tee.slope} outside ${SLOPE_BOUNDS.min}..${SLOPE_BOUNDS.max}`);
  }

  const holeCount = tee.holes.length;
  if (holeCount !== 9 && holeCount !== 18) {
    throw new DomainError("invalid-hole-count", `tee "${tee.name}" has ${holeCount} holes, must be 9 or 18`);
  }

  tee.holes.forEach((hole, index) => {
    if (hole.number !== index + 1) {
      throw new DomainError("invalid-hole-numbering", `tee "${tee.name}" hole at position ${index + 1} is numbered ${hole.number}`);
    }
    if (hole.par < PAR_BOUNDS.min || hole.par > PAR_BOUNDS.max) {
      throw new DomainError("invalid-par", `tee "${tee.name}" hole ${hole.number} par ${hole.par} outside ${PAR_BOUNDS.min}..${PAR_BOUNDS.max}`);
    }
    if (!Number.isInteger(hole.yardage) || hole.yardage < YARDAGE_BOUNDS.min || hole.yardage > YARDAGE_BOUNDS.max) {
      throw new DomainError(
        "invalid-yardage",
        `tee "${tee.name}" hole ${hole.number} yardage ${hole.yardage} outside ${YARDAGE_BOUNDS.min}..${YARDAGE_BOUNDS.max}`,
      );
    }
  });

  const strokeIndexes = tee.holes.map((h) => h.strokeIndex).sort((a, b) => a - b);
  const isPermutation = strokeIndexes.every((value, index) => value === index + 1);
  if (!isPermutation) {
    throw new DomainError("invalid-stroke-index", `tee "${tee.name}" strokeIndex values are not a permutation of 1..${holeCount}`);
  }
};

export const createCourse = (input: {
  readonly courseId: CourseId;
  readonly name: string;
  readonly tee: TeeSet;
  readonly enteredBy: string;
  readonly nowMs: number;
  readonly provenance?: Provenance;
}): Course => {
  validateCourseName(input.name);
  validateTeeSet(input.tee);
  return {
    courseId: input.courseId,
    name: input.name,
    teeSets: [
      {
        version: 1,
        status: "current",
        provenance: input.provenance ?? "community",
        enteredBy: input.enteredBy,
        enteredAtMs: input.nowMs,
        verifications: [],
        tee: input.tee,
      },
    ],
  };
};

export const addTeeSet = (
  course: Course,
  input: { readonly tee: TeeSet; readonly enteredBy: string; readonly nowMs: number; readonly provenance?: Provenance },
): Course => {
  validateTeeSet(input.tee);

  // Revision detection is exact-name match — that's what "same tee name" means for
  // versioning. A genuinely new name is still checked case-insensitively against every
  // CURRENT name so "White" and "WHITE" never coexist as two unrelated tee sets.
  const priorVersions = course.teeSets.filter((v) => v.tee.name === input.tee.name);
  const isRevision = priorVersions.length > 0;
  if (!isRevision) {
    const collidesWithCurrent = course.teeSets.some((v) => v.status === "current" && v.tee.name.toLowerCase() === input.tee.name.toLowerCase());
    if (collidesWithCurrent) {
      throw new DomainError("duplicate-tee-name", `tee name "${input.tee.name}" collides case-insensitively with an existing tee`);
    }
  }

  const nextVersion: TeeSetVersion = {
    version: isRevision ? Math.max(...priorVersions.map((v) => v.version)) + 1 : 1,
    status: "current",
    provenance: input.provenance ?? "community",
    enteredBy: input.enteredBy,
    enteredAtMs: input.nowMs,
    verifications: [], // a revision starts fresh — the prior version's verifications don't carry
    tee: input.tee,
  };

  const supersededTeeSets = course.teeSets.map((v) =>
    v.tee.name === input.tee.name && v.status === "current" ? ({ ...v, status: "superseded" } as const) : v,
  );

  return { ...course, teeSets: [...supersededTeeSets, nextVersion] };
};

export const verifyTeeSet = (
  course: Course,
  input: { readonly teeName: string; readonly verifierName: string; readonly expectedVersion: number; readonly nowMs: number },
): Course => {
  const current = course.teeSets.find((v) => v.tee.name === input.teeName && v.status === "current");
  if (!current) throw new DomainError("unknown-tee-set", `no tee set named "${input.teeName}"`);

  // A verification is an attestation of the exact numbers the verifier looked at — it must
  // never silently transplant onto a revision the verifier never saw (a corrected card is
  // unverified until someone re-verifies it; that's the point of verification). If the
  // caller's expectedVersion doesn't match what's current NOW, someone else's revision beat
  // them to it — fail outright rather than attach the verifier's credit to numbers they
  // never read.
  if (current.version !== input.expectedVersion) {
    throw new DomainError("tee-set-revised", `tee "${input.teeName}" is now version ${current.version}, expected version ${input.expectedVersion}`);
  }

  // Duplicate verifier name on the same version is a no-op, not an error — re-tapping
  // "verify" a second time (a plausible double-submit) shouldn't accumulate duplicate credit.
  if (current.verifications.some((v) => v.name === input.verifierName)) return course;

  const verified: TeeSetVersion = { ...current, verifications: [...current.verifications, { name: input.verifierName, atMs: input.nowMs }] };
  return { ...course, teeSets: course.teeSets.map((v) => (v === current ? verified : v)) };
};

// Current versions only, ordered by when each tee NAME first entered the course — not by
// teeSets' array position, which drifts once a revision re-appends an already-established
// name to the end of the array. version === 1 marks a name's first appearance exactly once
// (revisions never get a new version-1 entry), so scanning for those gives first-entered
// order independent of where the CURRENT version of that name now sits.
export const courseCardOf = (course: Course): CourseCard => {
  const firstEnteredNames = course.teeSets.filter((v) => v.version === 1).map((v) => v.tee.name);
  const currentByName = new Map(course.teeSets.filter((v) => v.status === "current").map((v) => [v.tee.name, v.tee]));
  return {
    courseName: course.name,
    // Every first-entered name has exactly one current version by construction
    // (addTeeSet's own invariant), so this lookup can never miss.
    teeSets: firstEnteredNames.map((name) => currentByName.get(name)!),
  };
};

// The ONE normalization both the store's GSI write and search's query use — collapsing
// case/whitespace variance so "Casa Verde GC" and " casa  verde gc " resolve to the same
// course rather than silently forking into duplicates.
export const courseNameKey = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();
