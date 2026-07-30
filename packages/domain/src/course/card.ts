import { DomainError } from "../errors.js";
import type { CardId, CourseId, TeeId } from "../ids.js";

export interface Hole {
  readonly number: number;      // 1-based position in play order
  readonly par: number;
  readonly yardage: number;
  readonly strokeIndex: number; // 1 = hardest; a permutation of 1..N within a tee set
}

export interface TeeSet {
  // Optional on the VALUE type (fixtures/decks construct cards directly; pre-scrap frozen
  // cards lack it) — present on every stored and newly-frozen card by construction
  // (buildCardRecord's invariant). Course-cards spec §3.
  readonly teeId?: TeeId;
  readonly name: string;
  readonly rating?: number; // present ⇔ slope present (validateTeeSet enforces the pairing)
  readonly slope?: number;
  readonly holes: readonly Hole[]; // 9 or 18, in play order
}

// `isRated` (the narrowing predicate every rating/slope-dependent path used to go through) is
// DELETED with the last thing that depended on a rating (spec 2026-07-29 §7): rating and slope are
// still recorded here because they are printed on the real scorecard, and nothing computes from
// them. `validateTeeSet` (course.ts) enforces the present-⇔-present pairing with its own explicit
// checks, so no narrowing helper is needed to keep that invariant.

// Which course record and exact card this value was frozen from — creation-time facts,
// never dereferenced for rendering or math (spec §2: frozen values are the only inputs).
export interface CardSource {
  readonly cardId: CardId;
  readonly courseId: CourseId;
}

export interface CourseCard {
  readonly courseName: string;
  readonly source?: CardSource; // same optional-on-value-type split as TeeSet.teeId above
  readonly teeSets: readonly TeeSet[];
}

export const findTeeSet = (card: CourseCard, name: string): TeeSet => {
  const tee = card.teeSets.find((t) => t.name === name);
  if (!tee) throw new DomainError("unknown-tee-set", `no tee set named "${name}"`);
  return tee;
};
