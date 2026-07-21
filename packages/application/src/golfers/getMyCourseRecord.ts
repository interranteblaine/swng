import { courseRecord } from "@swng/domain";
import type { CourseId } from "@swng/domain";
import type { GetMyCourseRecordResponse } from "@swng/contracts";
import type { AccountClaims } from "../ports/accountClaims.js";
import type { GolferStore } from "../ports/golferStore.js";
import type { ProjectionStore } from "../ports/projectionStore.js";
import { sortLines } from "../projections/projectArchive.js";

// GET /me/courses/{courseId}/record (analytics spec 2026-07-21 §4): "Your record here" — the
// getMyRecord idiom exactly (get-or-nothing: a sub with no golfer row at all gets courseRecord's
// own honest empty answer, never a throw or a create). courseRecord (domain/golfer/courseRecord.ts)
// filters to `courseId` and gates its own `insights` block at ≥5 rounds — never re-derived here.
export const getMyCourseRecord =
  (deps: { golferStore: GolferStore; projectionStore: ProjectionStore }) =>
  async (claims: AccountClaims, courseId: CourseId): Promise<GetMyCourseRecordResponse> => {
    const found = await deps.golferStore.getBySub(claims.sub);
    const lines = found ? await deps.projectionStore.listLines(found.golfer.id) : [];
    const record = courseRecord(sortLines(lines), courseId); // oldest→newest, ties like recordOf
    return { courseId, ...record };
  };
