import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import { courseId as makeCourseId } from "@swng/domain";
import type { CourseView } from "@swng/contracts";
import { ApiError, getCourse } from "../api";
import { btnPrimary, inputBox } from "../ui/classes";
import { usePageTitle } from "../ui/usePageTitle";
import { CourseRecordSection } from "./CourseRecordSection";
import { teeNumbers } from "./teeNumbers";

// Course-cards spec §7: the course hub — a read-only summary of a lineage's CURRENT card
// (name, attribution, every tee's own hole table) plus the three maintenance actions a golfer
// reaches it for: start a round here, edit the whole card, add a tee. GET /courses/{courseId}
// is "none"-auth (course data is public — courses.ts's own doc comment on getCourse/api.ts's
// mirror of it), so this page needs no sign-in gate of its own; only the pages the actions
// LINK to (CreateRoundPage, EditCoursePage) are gated.
export function CoursePage() {
  const { courseId: param } = useParams<{ courseId: string }>();
  if (!param) return <Navigate to="/" replace />; // unreachable given the route pattern; keeps TS/runtime honest

  return <CoursePageForId courseIdParam={param} />;
}

function CoursePageForId({ courseIdParam }: { readonly courseIdParam: string }) {
  const id = makeCourseId(courseIdParam);
  const [view, setView] = useState<CourseView | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [selectedTee, setSelectedTee] = useState<string | undefined>(undefined);
  // Re-runs once the card loads (usePageTitle's own title-prop-change contract) — "swng" while
  // loading, then the course name.
  usePageTitle(view?.card.courseName);

  useEffect(() => {
    getCourse(id)
      .then((response) => {
        setView(response.course);
        setSelectedTee(response.course.card.teeSets[0]?.name);
      })
      .catch((caught: unknown) => setLoadError(caught instanceof ApiError ? caught.message : "Could not load that course — try again."));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `id` is derived from courseIdParam, which keys this component's own mount (ArchivedRoundPage's own idiom); re-running per render would re-fetch on every keystroke elsewhere on the page.
  }, []);

  if (loadError) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-cream p-6">
        <p role="alert" className="text-oxblood">
          {loadError}
        </p>
      </main>
    );
  }

  if (!view) {
    return (
      <div role="status" aria-label="Loading course" className="flex min-h-screen items-center justify-center bg-cream text-forest">
        Loading…
      </div>
    );
  }

  const tee = view.card.teeSets.find((t) => t.name === selectedTee) ?? view.card.teeSets[0];

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-cream p-6">
      <h1 className="text-2xl font-bold text-forest">{view.card.courseName}</h1>
      <p className="font-mono text-sm text-fairway">
        entered by {view.enteredBy} · updated {new Date(view.updatedAtMs).toLocaleDateString()}
      </p>

      {/* Same tee-picker idiom as CourseSummaryCard.tsx (a second instance, not a shared
          component — this one is self-contained, holding its own selection, where
          CourseSummaryCard's stays controlled by its caller). */}
      <label className="flex flex-col gap-1 text-forest">
        Tee
        <select value={tee?.name ?? ""} onChange={(event) => setSelectedTee(event.target.value)} className={`${inputBox} text-lg`}>
          {view.card.teeSets.map((teeSet) => (
            <option key={teeSet.name} value={teeSet.name}>
              {teeSet.name} — {teeNumbers(teeSet)}
            </option>
          ))}
        </select>
      </label>

      {tee && (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="font-mono text-fairway">
              <th className="pr-3 text-left font-medium">Hole</th>
              <th className="pr-3 text-left font-medium">Par</th>
              <th className="pr-3 text-left font-medium">Yards</th>
              <th className="text-left font-medium">SI</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums text-forest">
            {tee.holes.map((hole) => (
              <tr key={hole.number} className="border-t border-hairline">
                <td className="py-1 pr-3">{hole.number}</td>
                <td className="py-1 pr-3">{hole.par}</td>
                <td className="py-1 pr-3">{hole.yardage}</td>
                <td className="py-1">{hole.strokeIndex}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="flex flex-col gap-3">
        <Link to="/create" state={{ courseId: view.courseId }} className={btnPrimary}>
          Start a round here
        </Link>
        <Link to={`/courses/${view.courseId}/edit`} className="text-forest underline decoration-fairway">
          Edit this card
        </Link>
        <Link to={`/courses/${view.courseId}/edit`} state={{ addTee: true }} className="text-forest underline decoration-fairway">
          Add a tee
        </Link>
      </div>

      {/* Analytics read-folds spec 2026-07-21 §4: "Your record here" — signed-in only; the
          section gates itself since this page's own GET /courses read stays "none"-auth. */}
      <CourseRecordSection courseId={view.courseId} />
    </main>
  );
}
