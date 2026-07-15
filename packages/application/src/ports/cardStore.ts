import type { CardRecord, CourseId } from "@swng/domain";

// The course system stores exactly one kind of thing: immutable cards, in lineages
// (course-cards spec §2). One mutable CURRENT pointer per lineage + one write-once item per
// card. There are NO retries and no revision counter: every write names the exact card the
// caller reviewed (record.supersedes), and a moved pointer is a 409 the human re-reviews —
// identity does the work M6's revision/pin/retry trio used to (spec §6).
export interface CardStore {
  // New lineage: pointer + first card in one transaction, both attribute_not_exists.
  create(record: CardRecord): Promise<void>;
  // Whole-card supersession: put the new card (write-once) + move the pointer, conditioned on
  // pointer.cardId === record.supersedes. Condition failure ⇒ ApplicationError("card-superseded").
  supersede(record: CardRecord): Promise<void>;
  // The lineage's current card — what getCourse serves and what startRound freezes.
  getCurrent(courseId: CourseId): Promise<CardRecord | undefined>;
  // Prefix search over CURRENT pointers only (courseNameKey normalization, same as writes).
  search(nameKeyPrefix: string, limit: number): Promise<readonly { courseId: CourseId; name: string; holeCount: 9 | 18 }[]>;
}
