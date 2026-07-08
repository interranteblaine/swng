import { DomainError } from "../errors.js";

export interface Hole {
  readonly number: number;      // 1-based position in play order
  readonly par: number;
  readonly yardage: number;
  readonly strokeIndex: number; // 1 = hardest; a permutation of 1..N within a tee set
}

export interface TeeSet {
  readonly name: string;
  readonly rating: number;
  readonly slope: number;
  readonly holes: readonly Hole[]; // 9 or 18, in play order
}

export interface CourseCard {
  readonly courseName: string;
  readonly teeSets: readonly TeeSet[];
}

export const findTeeSet = (card: CourseCard, name: string): TeeSet => {
  const tee = card.teeSets.find((t) => t.name === name);
  if (!tee) throw new DomainError("unknown-tee-set", `no tee set named "${name}"`);
  return tee;
};
