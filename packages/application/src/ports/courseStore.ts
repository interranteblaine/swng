import type { Course, CourseId } from "@swng/domain";

// A course's audit trail lives inside the Course aggregate itself (TeeSetVersion history,
// M6 Task 1) — so unlike RoundStore/EventJournal's split, a course needs no separate event
// log: this is a plain CRUD store over the whole aggregate (architecture.md §5), with
// optimistic concurrency so two concurrent edits to the same course never silently clobber
// one another.
export interface CourseStore {
  // expectedRevision undefined ⇒ create (condition: item absent); n ⇒ replace revision n
  // (condition: stored revision === n). On condition failure throws the application-layer
  // error idiom (errors.ts) with code "course-conflict" — use cases retry on a fresh read
  // (bounded, see application/src/retryOnConflict.ts — shared, not course-specific).
  put(course: Course, expectedRevision: number | undefined): Promise<void>;
  get(courseId: CourseId): Promise<{ course: Course; revision: number } | undefined>;
  search(nameKeyPrefix: string, limit: number): Promise<readonly { courseId: CourseId; name: string }[]>;
}
