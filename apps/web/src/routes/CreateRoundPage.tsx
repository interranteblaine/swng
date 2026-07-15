import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { CourseId } from "@swng/domain";
import type { CourseView, StartRoundResponse } from "@swng/contracts";
import { ApiError, createRound, getCourse } from "../api";
import { SignInCta } from "../auth/SignInCta";
import { useAuth } from "../auth/useAuth";
import { CourseSearch } from "../courses/CourseSearch";
import { CourseSummaryCard } from "../courses/CourseSummaryCard";
import { credentialStore } from "../identity";

interface LocationState {
  // AddCoursePage's own success navigation (M6 Task 5's "Add a course" hand-off) — a course
  // just added should land here already selected, not force the golfer to search for the
  // thing they just typed in.
  readonly courseId?: CourseId;
  // The edit flow's success hand-off (M-i): a refreshed CourseView delivered straight through
  // router state — no re-fetch needed here, unlike AddCoursePage's courseId hand-off above,
  // because the editor already holds the full, current card. The editor page itself is deleted
  // this task (course-cards spec §8); T6 restores it from the new CoursePage, so nothing sets
  // this key today — the effect that reads it is kept, harmless, for that restoration.
  readonly refreshedCourse?: CourseView;
}

export function CreateRoundPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();
  // The wall (accounts-only identity spec §3): anonymous round creation is gone from the UI —
  // starting a round means being signed in, playing AS your account golfer. `auth.golfer` being
  // truthy is the one condition the create form renders in ("Playing as <name>"); while it's
  // still undefined (the GET /me loading window, or the transient no-row case) the form shows a
  // quiet placeholder and submit stays disabled — the M8 defect (a submit renaming a
  // half-loaded profile) is structurally impossible now that no name is ever typed here.
  const golfer = auth.golfer ?? undefined;

  const [courseView, setCourseView] = useState<CourseView | undefined>(undefined);
  const [tee, setTee] = useState<string>("");
  const [courseError, setCourseError] = useState<string | undefined>(undefined);
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

  // The ONE place this page's held courseView gets replaced by a card it didn't itself fetch —
  // the edit-flow's return hand-off (the effect below, reading `refreshedCourse` off router
  // state) is the remaining caller. The old CourseSummaryCard verify-409 re-fetch site is gone
  // (the verify affordance died in T2, and card supersession is a whole-card write now, not a
  // per-tee verify). `tee` tracks along: a corrected card keeps its tee NAMES, so the current
  // selection survives if it still names a tee on the refreshed card; only a first-arrival (a
  // `refreshedCourse` landing before any tee was ever selected) falls back to the card's first
  // tee, same as selectCourse.
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
    // Only ever reachable in the signed-in-with-a-golfer state (the form isn't rendered
    // otherwise), but guarded anyway: a course, a tee, a valid handicap, and a real golfer.
    if (!courseView || !tee || !Number.isInteger(parsedHandicap) || !golfer) return;

    setSubmitting(true);
    setError(undefined);
    try {
      // courseView.card VERBATIM — exactly the fetched CourseCard, not reconstructed — because a
      // round freezes this whole snapshot. Accounts-only identity (spec §3): the creator seat is
      // always yourself, resolved server-side from the Bearer — the request carries no name/golferId
      // (the server freezes the account golfer's name into the join event).
      const response: StartRoundResponse = await auth.withAuth((token) =>
        createRound({ card: courseView.card, host: { tee, courseHandicap: parsedHandicap } }, token),
      );
      credentialStore.save(response.roundId, { token: response.token, golferId: response.golferId, name: golfer.name, joinCode: response.joinCode });
      navigate(`/round/${response.roundId}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not create the round — try again.");
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-slate-950 p-6 text-slate-100">
      <h1 className="text-2xl font-bold">Start a round</h1>

      {!auth.signedIn ? (
        <SignInCta message="Sign in to start a round." returnTo="/create" />
      ) : (
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

          {golfer ? (
            <div className="flex flex-col gap-1">
              <span className="text-sm text-slate-400">Playing as</span>
              <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-800 p-3 text-lg">
                <span>{golfer.name}</span>
                <Link to="/profile" className="text-sm text-emerald-400 underline">
                  Change
                </Link>
              </div>
            </div>
          ) : (
            // A quiet placeholder while identity resolves — submit stays disabled, so no round
            // is ever created before we know whose it is.
            <div role="status" aria-label="Loading your profile" className="flex flex-col gap-1">
              <div className="rounded-lg bg-slate-800 p-3 text-lg text-slate-500">Loading your profile…</div>
            </div>
          )}

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

          <button
            type="submit"
            disabled={submitting || !courseView || !golfer}
            className="rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold disabled:opacity-50"
          >
            Create round
          </button>
        </form>
      )}
    </main>
  );
}
