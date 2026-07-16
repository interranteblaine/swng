import type { CourseCard, TeeSet } from "./card.js";
import { DomainError } from "../errors.js";
import type { CardId, CourseId, GolferId, TeeId } from "../ids.js";

// Where a tee set's numbers came from: typed in by a community scorer, or ingested from an
// external course-data source — provenance metadata frozen onto a stored card (CardRecord).
export type Provenance = "community" | "imported";

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

// The per-tee invariant table, applied to every tee of every card (validateCard calls this per
// tee) — the rules live exactly once, regardless of which write introduced the tee.
const validateTeeSet = (tee: TeeSet): void => {
  if (tee.name.trim().length === 0 || tee.name.length > MAX_TEE_NAME_LENGTH) {
    throw new DomainError("invalid-tee-name", `tee name must be 1-${MAX_TEE_NAME_LENGTH} characters: "${tee.name}"`);
  }
  // Unrated tees exist (unrated-courses spec §1): rating/slope are optional AS A PAIR — both
  // present (rated), both absent (unrated), or exactly one present (rejected outright).
  const ratingSet = tee.rating !== undefined;
  const slopeSet = tee.slope !== undefined;
  if (ratingSet !== slopeSet) {
    throw new DomainError("rating-slope-paired", `tee "${tee.name}" must set course rating and slope together, or neither (unrated)`);
  }
  if (ratingSet) {
    if (tee.rating! < RATING_BOUNDS.min || tee.rating! > RATING_BOUNDS.max) {
      throw new DomainError("invalid-rating", `tee "${tee.name}" rating ${tee.rating} outside ${RATING_BOUNDS.min}..${RATING_BOUNDS.max}`);
    }
    if (!Number.isInteger(tee.slope!) || tee.slope! < SLOPE_BOUNDS.min || tee.slope! > SLOPE_BOUNDS.max) {
      throw new DomainError("invalid-slope", `tee "${tee.name}" slope ${tee.slope} outside ${SLOPE_BOUNDS.min}..${SLOPE_BOUNDS.max}`);
    }
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

// The ONE normalization both the store's GSI write and search's query use — collapsing
// case/whitespace variance so "Casa Verde GC" and " casa  verde gc " resolve to the same
// course rather than silently forking into duplicates.
export const courseNameKey = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();

// ——— Course-cards model (spec 2026-07-15) ———
// The system stores exactly one kind of thing: complete, immutable cards, in lineages.
// A CardRecord wraps the EXACT CourseCard value rounds freeze — the stored unit is the
// frozen unit; no translation function exists (spec invariant 3). The M6 aggregate above
// is deleted once the wire switches over (plan T4).

export interface EnteredBy {
  readonly golferId: GolferId;
  readonly name: string; // display name at write time, frozen — renames never rewrite attribution
}

export interface CardRecord {
  readonly cardId: CardId;
  readonly courseId: CourseId;
  readonly card: CourseCard; // card.source === { cardId, courseId }; every tee carries teeId
  readonly enteredBy: EnteredBy;
  readonly enteredAtMs: number;
  readonly provenance: Provenance;
  readonly supersedes?: CardId; // absent on lineage roots
}

// The whole-card validity rules: M6's validateTeeSet verbatim per tee, PLUS the card-level
// rules the aggregate never had — ≥1 tee, unique names, and ONE hole count across every tee
// (spec invariant 6: a frozen card cannot be internally contradictory).
export const validateCard = (card: CourseCard): void => {
  validateCourseName(card.courseName);
  if (card.teeSets.length === 0) {
    throw new DomainError("invalid-hole-count", "a card must have at least one tee set");
  }
  card.teeSets.forEach((tee) => validateTeeSet(tee));

  const lowerNames = card.teeSets.map((t) => t.name.toLowerCase());
  if (new Set(lowerNames).size !== lowerNames.length) {
    throw new DomainError("duplicate-tee-name", "tee names must be unique (case-insensitive) within a card");
  }

  const holeCounts = new Set(card.teeSets.map((t) => t.holes.length));
  if (holeCounts.size > 1) {
    throw new DomainError("mismatched-hole-count", `every tee in a card must describe the same holes; got counts ${[...holeCounts].join(", ")}`);
  }
};

// Tee identity is recorded at write time, never inferred later (spec invariant 2): a
// submitted teeId must exist in the card being superseded, and no id may appear twice.
// An id-less tee is NEW (the caller mints its id after this passes).
export const validateTeeContinuity = (currentCard: CourseCard, tees: readonly { readonly teeId?: TeeId; readonly name: string }[]): void => {
  const knownIds = new Set(currentCard.teeSets.map((t) => t.teeId).filter((id): id is TeeId => id !== undefined));
  const seen = new Set<TeeId>();
  for (const tee of tees) {
    if (tee.teeId === undefined) continue;
    if (seen.has(tee.teeId)) {
      throw new DomainError("duplicate-tee-id", `tee id "${tee.teeId}" submitted more than once`);
    }
    seen.add(tee.teeId);
    if (!knownIds.has(tee.teeId)) {
      throw new DomainError("unknown-tee-id", `tee "${tee.name}" claims id "${tee.teeId}", which the superseded card does not have`);
    }
  }
};

// Assembles + validates a CardRecord. Every input tee must already carry its (server-minted)
// teeId — an id-less tee here is a caller bug, not client input, hence a plain Error rather
// than a wire-mapped DomainError.
export const buildCardRecord = (input: {
  readonly cardId: CardId;
  readonly courseId: CourseId;
  readonly courseName: string;
  readonly teeSets: readonly TeeSet[];
  readonly enteredBy: EnteredBy;
  readonly enteredAtMs: number;
  readonly provenance?: Provenance;
  readonly supersedes?: CardId;
}): CardRecord => {
  const ids = input.teeSets.map((t) => t.teeId);
  if (ids.some((id) => id === undefined)) {
    throw new Error("buildCardRecord: every stored tee must carry a tee-id (caller mints before assembling)");
  }
  if (new Set(ids).size !== ids.length) {
    throw new DomainError("duplicate-tee-id", "tee ids must be unique within a card");
  }
  const card: CourseCard = {
    courseName: input.courseName,
    source: { cardId: input.cardId, courseId: input.courseId },
    teeSets: input.teeSets,
  };
  validateCard(card);
  return {
    cardId: input.cardId,
    courseId: input.courseId,
    card,
    enteredBy: input.enteredBy,
    enteredAtMs: input.enteredAtMs,
    provenance: input.provenance ?? "community",
    ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
  };
};
