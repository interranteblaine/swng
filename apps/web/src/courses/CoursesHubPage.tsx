import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { CourseId } from "@swng/domain";
import { coursesPlayed } from "@swng/domain";
import { getCourse, getMyRounds } from "../api";
import { useAuth } from "../auth/useAuth";
import { btnSecondary, cardBox, linkEntity } from "../ui/classes";
import { usePageTitle } from "../ui/usePageTitle";
import { CourseSearch } from "./CourseSearch";

// The courses hub (navigation spec §5): the courses noun's own canonical address, reached from
// the header's new Courses destination. Search is the hero — CourseSearch is UNCHANGED; its
// existing onSelect(courseId, name) callback navigates here rather than filling a form (the
// only difference from its other callers). Signed in, two more sections surface what the golfer
// already knows: their home course, and the courses `coursesPlayed` (a pure domain fold over
// GET /me/rounds' own lines — never inline grouping here) says they've actually played. No gold
// on this page — search is the hero, "Add a course" wears the plain secondary idiom.
export function CoursesHubPage() {
  usePageTitle("Courses");
  const navigate = useNavigate();
  const auth = useAuth();
  const { withAuth } = auth;

  const [homeCourse, setHomeCourse] = useState<{ readonly id: CourseId; readonly name: string } | undefined>(undefined);
  const [rounds, setRounds] = useState<readonly { readonly courseId?: CourseId; readonly courseName: string }[]>([]);

  useEffect(() => {
    const homeCourseId = auth.golfer?.homeCourseId;
    if (!homeCourseId) {
      setHomeCourse(undefined);
      return;
    }
    getCourse(homeCourseId)
      .then((response) => setHomeCourse({ id: response.course.courseId, name: response.course.card.courseName }))
      .catch(() => {}); // a friendly name is a nicety — a failed lookup just leaves the card off, never blocks the page
  }, [auth.golfer?.homeCourseId]);

  useEffect(() => {
    if (!auth.signedIn) {
      setRounds([]);
      return;
    }
    void withAuth((token) => getMyRounds(token))
      .then((response) => setRounds(response.rounds))
      .catch(() => {}); // withAuth already handles a terminal 401 (signs out); anything else just leaves the section empty
  }, [auth.signedIn, withAuth]);

  const played = coursesPlayed(rounds);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-8 bg-cream p-6">
      <h1 className="text-2xl font-bold text-forest">Courses</h1>

      <CourseSearch onSelect={(courseId) => navigate(`/courses/${courseId}`)} />

      {homeCourse && (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-forest">Your home course</h2>
          <Link to={`/courses/${homeCourse.id}`} className={`${cardBox} block px-4 py-3 text-forest ${linkEntity}`}>
            {homeCourse.name}
          </Link>
        </section>
      )}

      {auth.signedIn && played.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-forest">Courses you&apos;ve played</h2>
          <ul className="flex flex-col gap-1">
            {played.map((course) => (
              <li key={course.courseId}>
                <Link to={`/courses/${course.courseId}`} className={`${cardBox} block px-4 py-3 text-forest ${linkEntity}`}>
                  {course.name} · {course.rounds} round{course.rounds === 1 ? "" : "s"}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Link to="/courses/new" className={`self-start ${btnSecondary}`}>
        Add a course
      </Link>
    </main>
  );
}
