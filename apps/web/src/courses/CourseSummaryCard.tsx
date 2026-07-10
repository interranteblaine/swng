import { useState } from "react";
import type { CourseView } from "@swng/contracts";
import { ApiError, verifyTeeSet } from "../api";

export interface CourseSummaryCardProps {
  readonly course: CourseView;
  readonly selectedTee: string;
  readonly onSelectTee: (teeName: string) => void;
  // Absent on AddCoursePage's own post-add summary (there's no search to go back to yet) —
  // present in CreateRoundPage, where it lets a golfer back out of a wrong pick.
  readonly onChangeCourse?: () => void;
}

// The course detail + tee picker + verify affordance (M6 Task 5) — shown once a course is
// selected, in CreateRoundPage (via search or via AddCoursePage's own preselect-on-success)
// and reused as-is rather than duplicated: "shown after add and in the create-flow course
// detail" (brief) is the SAME component, not two.
export function CourseSummaryCard({ course, selectedTee, onSelectTee, onChangeCourse }: CourseSummaryCardProps) {
  // Seeded from the prop, then advanced locally from verify's own response — course.teeSets is
  // CURRENT-versions-only metadata (contracts/src/courses.ts), and a fresh verify's response
  // carries the updated count directly, so there's nothing to re-fetch.
  const [teeSets, setTeeSets] = useState(course.teeSets);
  const [verifyError, setVerifyError] = useState<string | undefined>(undefined);

  const verify = async () => {
    // A plain browser prompt, not a modal screen: verifying is a rare, low-stakes "I looked at
    // this and it's right" tap (brief: "name prompt → POST verify"), not a flow that earns its
    // own UI. A blank/cancelled prompt (returns "" or null) is a silent no-op, not an error.
    const verifierName = window.prompt("Your name, to verify this card:");
    if (!verifierName?.trim()) return;
    try {
      const response = await verifyTeeSet(course.courseId, { teeName: selectedTee, verifierName: verifierName.trim() });
      setTeeSets(response.course.teeSets);
      setVerifyError(undefined);
    } catch (caught) {
      setVerifyError(caught instanceof ApiError ? caught.message : "Could not verify — try again.");
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-slate-900 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-lg font-semibold">{course.name}</p>
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

      <ul className="flex flex-col gap-1 text-sm text-slate-400">
        {teeSets.map((teeSet) => (
          <li key={teeSet.name}>
            {teeSet.name}: entered by {teeSet.enteredBy}
            {teeSet.verifiedBy.length > 0 ? ` · ✓ ${teeSet.verifiedBy.length} verified` : " · not yet verified"}
          </li>
        ))}
      </ul>

      <button type="button" onClick={() => void verify()} className="self-start rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100">
        Verify this card
      </button>
      {verifyError && (
        <p role="alert" className="text-red-400">
          {verifyError}
        </p>
      )}
    </div>
  );
}
