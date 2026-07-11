import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { CourseId } from "@swng/domain";
import type { CourseView, StartRoundResponse } from "@swng/contracts";
import { ApiError, createRound, getCourse, updateMe } from "../api";
import { useAuth } from "../auth/useAuth";
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
  const auth = useAuth();
  // Truthy exactly when the "Playing as <name>" line replaces the free-text name field — a
  // real GolferView, not just signedIn (a signed-in account with no golfer yet — golfer is
  // null, or still loading, GET /me not resolved — keeps the free-text field, same as signed
  // out, until PUT /me mints one at submit time below).
  const asSelf = auth.signedIn && Boolean(auth.golfer);

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
    // Playing as yourself always has a name (auth.golfer.name) — only the free-text path needs
    // one typed. Everything else (course/tee/handicap) is required either way.
    if (!courseView || !tee || !Number.isInteger(parsedHandicap) || (!asSelf && !name.trim())) return;

    setSubmitting(true);
    setError(undefined);
    try {
      // courseView.card VERBATIM — exactly the fetched CourseCard, not reconstructed —
      // because a round freezes this whole snapshot (brief: "the freeze source swap is THE
      // change").
      let response: StartRoundResponse;
      let savedName: string;
      if (asSelf) {
        // Playing as an existing account golfer: golferId + Bearer ride along, host.name is
        // the account's own name (never a stale local `name` field — there isn't one to go
        // stale, the input was replaced).
        const golfer = auth.golfer!;
        savedName = golfer.name;
        response = await auth.withAuth((token) =>
          createRound({ card: courseView.card, host: { name: golfer.name, tee, courseHandicap: parsedHandicap }, golferId: golfer.golferId }, token),
        );
      } else if (auth.signedIn) {
        // Signed in with NO golfer yet: the typed name first creates the account's golfer (PUT
        // /me), THEN the round is created as-self with the golferId that mints — strictly in
        // this order (assert-call-order is part of this milestone's own headline behavior:
        // "zero claiming" only holds if the round is created AS the right golfer from the
        // start).
        const trimmed = name.trim();
        savedName = trimmed;
        response = await auth.withAuth(async (token) => {
          const created = await updateMe(token, { name: trimmed });
          return createRound({ card: courseView.card, host: { name: trimmed, tee, courseHandicap: parsedHandicap }, golferId: created.golfer.golferId }, token);
        });
      } else {
        // Signed out: byte-identical to before this milestone — no golferId, no Bearer.
        const trimmed = name.trim();
        savedName = trimmed;
        response = await createRound({ card: courseView.card, host: { name: trimmed, tee, courseHandicap: parsedHandicap } });
      }
      credentialStore.save(response.roundId, { token: response.token, golferId: response.golferId, name: savedName, joinCode: response.joinCode });
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

        {asSelf ? (
          <div className="flex flex-col gap-1">
            <span className="text-sm text-slate-400">Playing as</span>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-800 p-3 text-lg">
              <span>{auth.golfer!.name}</span>
              <Link to="/profile" className="text-sm text-emerald-400 underline">
                Change
              </Link>
            </div>
          </div>
        ) : (
          <label className="flex flex-col gap-1">
            Your name
            <input value={name} onChange={(event) => setName(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg" />
          </label>
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

        <button type="submit" disabled={submitting || !courseView} className="rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold disabled:opacity-50">
          Create round
        </button>
      </form>
    </main>
  );
}
