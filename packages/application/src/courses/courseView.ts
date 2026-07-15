import type { CardRecord } from "@swng/domain";
import type { CourseView } from "@swng/contracts";

// No translation exists — the view IS the record's card plus attribution (spec invariant 3).
export const toCourseView = (record: CardRecord): CourseView => ({
  courseId: record.courseId,
  cardId: record.cardId,
  card: record.card,
  enteredBy: record.enteredBy.name,
  updatedAtMs: record.enteredAtMs,
});
