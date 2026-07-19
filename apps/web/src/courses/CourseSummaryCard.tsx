import { Link } from "react-router";
import type { CourseView } from "@swng/contracts";
import { cardBox, inputBox } from "../ui/classes";
import { teeNumbers } from "./teeNumbers";

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

// The course detail + tee picker — shown once a course is selected in CreateRoundPage, via
// search or via CoursePage's own "Start a round here" preselect (Courses-surface T6;
// AddCoursePage itself now lands on CoursePage, not here, on success). The verify affordance
// (M6 Task 5) is gone — attribution only now (course-cards spec §8): a tee set names who
// entered it, never a self-typed verify count.
export function CourseSummaryCard({ course, selectedTee, onSelectTee, onChangeCourse }: CourseSummaryCardProps) {
  return (
    <div className={`${cardBox} flex flex-col gap-3 p-4`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-lg font-semibold text-forest">{course.card.courseName}</p>
        <div className="flex items-center gap-3">
          {onChangeCourse && (
            <button type="button" onClick={onChangeCourse} className="text-sm text-forest underline decoration-fairway">
              Change course
            </button>
          )}
          {/* The create-flow's own path to maintenance (Courses-surface T6): editing itself
              lives on CoursePage now, not here — this is just the door to it. */}
          <Link to={`/courses/${course.courseId}`} className="text-sm text-forest underline decoration-fairway">
            View course
          </Link>
        </div>
      </div>

      <label className="flex flex-col gap-1 text-forest">
        Tee
        <select value={selectedTee} onChange={(event) => onSelectTee(event.target.value)} className={`${inputBox} text-lg`}>
          {course.card.teeSets.map((teeSet) => (
            <option key={teeSet.name} value={teeSet.name}>
              {teeSet.name} — {teeNumbers(teeSet)}
            </option>
          ))}
        </select>
      </label>

      {/* Attribution only (course-cards spec §8): who entered this card and when — no per-tee
          verify badges, no edit affordance here directly (editing lives on CoursePage, reached
          via "View course" above). */}
      <p className="font-mono text-sm text-fairway">
        entered by {course.enteredBy} · updated {new Date(course.updatedAtMs).toLocaleDateString()}
      </p>
    </div>
  );
}
