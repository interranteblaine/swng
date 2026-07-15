import type { CourseView } from "@swng/contracts";

export interface CourseSummaryCardProps {
  readonly course: CourseView;
  readonly selectedTee: string;
  readonly onSelectTee: (teeName: string) => void;
  // Absent on AddCoursePage's own post-add summary (there's no search to go back to yet) —
  // present in CreateRoundPage, where it lets a golfer back out of a wrong pick.
  readonly onChangeCourse?: () => void;
  // Edit-flow plumbing: CreateRoundPage still passes its own handleCourseRefreshed here, but
  // this component no longer calls it — it used to fire on a verify-409 re-fetch (M7 Task 7,
  // M-i), and that call site is gone along with the verify affordance (course-cards spec §8).
  // The edit flow's own return hand-off never went through this prop — it's a route-level
  // effect in the caller (CreateRoundPage's own location-state effect), unchanged. Kept on the
  // type so CreateRoundPage keeps compiling without a matching, separate prop-removal task.
  readonly onCourseRefreshed?: (courseView: CourseView) => void;
}

// The course detail + tee picker — shown once a course is selected, in CreateRoundPage (via
// search or via AddCoursePage's own preselect-on-success) and reused as-is rather than
// duplicated: "shown after add and in the create-flow course detail" (brief) is the SAME
// component, not two. The verify affordance (M6 Task 5) is gone — attribution only now
// (course-cards spec §8): a tee set names who entered it, never a self-typed verify count.
export function CourseSummaryCard({ course, selectedTee, onSelectTee, onChangeCourse }: CourseSummaryCardProps) {
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-slate-900 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-lg font-semibold">{course.card.courseName}</p>
        {onChangeCourse && (
          <button type="button" onClick={onChangeCourse} className="text-sm text-emerald-400 underline">
            Change course
          </button>
        )}
      </div>

      <label className="flex flex-col gap-1">
        Tee
        <select value={selectedTee} onChange={(event) => onSelectTee(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg">
          {course.card.teeSets.map((teeSet) => (
            <option key={teeSet.name} value={teeSet.name}>
              {teeSet.name} — rating {teeSet.rating}, slope {teeSet.slope}
            </option>
          ))}
        </select>
      </label>

      {/* Attribution only (course-cards spec §8): who entered this card and when — no per-tee
          verify badges, no edit affordance (T6 restores editing from the new CoursePage). */}
      <p className="text-sm text-slate-400">
        entered by {course.enteredBy} · updated {new Date(course.updatedAtMs).toLocaleDateString()}
      </p>
    </div>
  );
}
