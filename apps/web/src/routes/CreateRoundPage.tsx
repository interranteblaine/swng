import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import type { CourseId } from "@swng/domain";
import type { CourseView } from "@swng/contracts";
import { ApiError, createRound, getCourse } from "../api";
import { CourseSearch } from "../courses/CourseSearch";
import { CourseSummaryCard } from "../courses/CourseSummaryCard";
import { credentialStore } from "../identity";

interface LocationState {
  // AddCoursePage's own success navigation (M6 Task 5's "Add a course" hand-off) — a course
  // just added should land here already selected, not force the golfer to search for the
  // thing they just typed in.
  readonly courseId?: CourseId;
  // EditCoursePage's own success hand-off (M7 Task 7, M-i): the refreshed CourseView, straight
  // off addTeeSet's own response — no re-fetch needed here, unlike AddCoursePage's courseId
  // hand-off above, because EditCoursePage already holds the full, current CourseView.
  readonly refreshedCourse?: CourseView;
}

export function CreateRoundPage() {
  const navigate = useNavigate();
  const location = useLocation();

  const [courseView, setCourseView] = useState<CourseView | undefined>(undefined);
  const [tee, setTee] = useState<string>("");
  const [courseError, setCourseError] = useState<string | undefined>(undefined);
  const [name, setName] = useState("");
  const [courseHandicap, setCourseHandicap] = useState("0");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const selectCourse = (courseId: CourseId) => {
    setCourseError(undefined);
    getCourse(courseId)
      .then((response) => {
        setCourseView(response.course);
        // Tee always tracks the newly chosen card's own tee sets, never a stale name from a
        // previously selected course.
        setTee(response.course.card.teeSets[0]?.name ?? "");
      })
      .catch((caught: unknown) => {
        setCourseView(undefined);
        setCourseError(caught instanceof ApiError ? caught.message : "Could not load that course — try again.");
      });
  };

  // M-i: the ONE place this page's held courseView gets replaced by a revision it didn't
  // itself fetch — CourseSummaryCard's own verify-409 re-fetch calls this directly (wired via
  // the onCourseRefreshed prop below); the edit-flow's return hand-off (the effect below)
  // calls it too. Both existed before Task 7 closed this gap: only the verify-409 site kept
  // CourseSummaryCard's OWN local state current, never this page's — a mid-setup revision
  // race could freeze the stale (internally consistent) card (papercuts.md #3's "M-i").
  // `tee` tracks along: a revision keeps its tee NAME unchanged (course.ts's addTeeSet — same
  // name is what makes it a revision), so the current selection survives if it still names a
  // tee on the refreshed card; only a first-arrival (the edit-flow's `refreshedCourse` landing
  // before any tee was ever selected) falls back to the card's first tee, same as selectCourse.
  const handleCourseRefreshed = (refreshed: CourseView) => {
    setCourseView(refreshed);
    setTee((current) => (refreshed.card.teeSets.some((t) => t.name === current) ? current : (refreshed.card.teeSets[0]?.name ?? "")));
  };

  // Fires once per navigation INTO this page (location.key is a fresh id react-router mints
  // per history entry) — not on every render, and not keyed off `location.state` itself
  // (a plain object literal from AddCoursePage's navigate() call would otherwise be a "new"
  // dependency on every render and re-fetch forever).
  useEffect(() => {
    const state = location.state as LocationState | null;
    // EditCoursePage's own hand-off (M-i, the edit flow's onCourseRefreshed call site) takes
    // priority: it already carries the full, current CourseView, so there's nothing to fetch.
    if (state?.refreshedCourse) {
      handleCourseRefreshed(state.refreshedCourse);
      return;
    }
    if (state?.courseId) selectCourse(state.courseId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above: keyed by the router's own per-navigation identity, not by `state`'s object identity
  }, [location.key]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedHandicap = Number.parseInt(courseHandicap, 10);
    if (!courseView || !tee || !name.trim() || !Number.isInteger(parsedHandicap)) return;

    setSubmitting(true);
    setError(undefined);
    try {
      // courseView.card VERBATIM — exactly the fetched CourseCard, not reconstructed —
      // because a round freezes this whole snapshot (brief: "the freeze source swap is THE
      // change").
      const response = await createRound({ card: courseView.card, host: { name: name.trim(), tee, courseHandicap: parsedHandicap } });
      credentialStore.save(response.roundId, { token: response.token, golferId: response.golferId, name: name.trim(), joinCode: response.joinCode });
      navigate(`/round/${response.roundId}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not create the round — try again.");
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-slate-950 p-6 text-slate-100">
      <h1 className="text-2xl font-bold">Start a round</h1>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {courseView ? (
          <CourseSummaryCard
            course={courseView}
            selectedTee={tee}
            onSelectTee={setTee}
            onChangeCourse={() => setCourseView(undefined)}
            onCourseRefreshed={handleCourseRefreshed}
          />
        ) : (
          <CourseSearch onSelect={(courseId) => selectCourse(courseId)} />
        )}
        {courseError && (
          <p role="alert" className="text-red-400">
            {courseError}
          </p>
        )}

        <label className="flex flex-col gap-1">
          Your name
          <input value={name} onChange={(event) => setName(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg" />
        </label>

        <label className="flex flex-col gap-1">
          Course handicap
          <input
            type="number"
            step={1}
            value={courseHandicap}
            onChange={(event) => setCourseHandicap(event.target.value)}
            className="rounded-lg bg-slate-800 p-3 text-lg"
          />
        </label>

        {error && (
          <p role="alert" className="text-red-400">
            {error}
          </p>
        )}

        <button type="submit" disabled={submitting || !courseView} className="rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold disabled:opacity-50">
          Create round
        </button>
      </form>
    </main>
  );
}
