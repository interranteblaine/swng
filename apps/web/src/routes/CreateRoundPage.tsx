import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { CourseId } from "@swng/domain";
import { cardId } from "@swng/domain";
import type { CourseView, StartRoundResponse } from "@swng/contracts";
import { ApiError, createRound, getCourse } from "../api";
import { SignInCta } from "../auth/SignInCta";
import { useAuth } from "../auth/useAuth";
import { CourseSearch } from "../courses/CourseSearch";
import { CourseSummaryCard } from "../courses/CourseSummaryCard";
import { credentialStore } from "../identity";
import { btnPrimary, cardBox, inputBox } from "../ui/classes";
import { usePageTitle } from "../ui/usePageTitle";

// A datetime-local input's value is a LOCAL wall-clock string with no zone — "2026-07-31T14:05".
// Both directions go through here so the instant submitted is exactly the one the field shows;
// nothing is inferred (spec §5). Earlier drafts of this design picked local noon, then the entry
// clock, by a hidden rule — the field showing the real value is what makes those unnecessary.
const pad = (n: number): string => String(n).padStart(2, "0");
const toDatetimeLocalValue = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

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
  usePageTitle("Start a round");
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // Round-played-date spec §5: always visible, defaulting to now, no "past round" disclosure and
  // no second mode. The lazy initializer reads the clock exactly once, at mount.
  const [playedAt, setPlayedAt] = useState<string>(() => toDatetimeLocalValue(new Date()));

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

  const canSubmit =
    courseView !== undefined && tee !== "" && golfer !== undefined && playedAt !== "" && !Number.isNaN(new Date(playedAt).getTime());

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Only ever reachable in the signed-in-with-a-golfer state (the form isn't rendered
    // otherwise), but guarded anyway: a course, a tee, a real golfer, and a parseable played-at.
    if (!canSubmit || !courseView || !golfer) return;

    setSubmitting(true);
    setError(undefined);
    try {
      // Course-cards spec §4: a REFERENCE, never a card — the server resolves and freezes the
      // lineage's CURRENT card itself. Accounts-only identity (spec §3): the creator seat is
      // always yourself, resolved server-side from the Bearer — the request carries no
      // name/golferId (the server freezes the account golfer's name into the join event).
      // playedAtMs (round-played-date spec §5): always sent — the field always holds a value on
      // this form, so there is no "absent means now" case here (that arm exists on the wire for
      // other clients, not for this form). Exactly what the field shows, never inferred.
      const response: StartRoundResponse = await auth.withAuth((token) =>
        createRound({ course: { courseId: courseView.courseId, cardId: cardId(courseView.cardId) }, host: { tee }, playedAtMs: new Date(playedAt).getTime() }, token),
      );
      credentialStore.save(response.roundId, { token: response.token, golferId: response.golferId, name: golfer.name, joinCode: response.joinCode });
      navigate(`/round/${response.roundId}`);
    } catch (caught) {
      // card-superseded (course-cards spec §4): someone else's edit landed on this course's
      // lineage between the fetch and this submit. Re-fetch the now-current card (which also
      // re-seeds `tee` via selectCourse) so the golfer reviews the real numbers before retrying,
      // rather than silently starting a round on numbers they never actually saw.
      if (caught instanceof ApiError && caught.code === "card-superseded") {
        selectCourse(courseView.courseId);
        setError("This card was just updated — review the numbers before starting.");
        setSubmitting(false);
        return;
      }
      setError(caught instanceof ApiError ? caught.message : "Could not create the round — try again.");
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-cream p-6">
      <h1 className="text-2xl font-extrabold tracking-tight text-forest">Start a round</h1>

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
            <p role="alert" className="text-oxblood">
              {courseError}
            </p>
          )}

          {/* Round-played-date spec §5: always visible, no "past round" disclosure and no second
              mode — a retroactive round is not a different kind of round, just a different date.
              Date AND time, deliberately: whatever this field shows is exactly what gets sent. */}
          <label className="flex flex-col gap-1">
            <span className="text-sm text-fairway">When did you play?</span>
            <input
              type="datetime-local"
              value={playedAt}
              onChange={(e) => setPlayedAt(e.target.value)}
              className={inputBox}
            />
          </label>

          {golfer ? (
            <div className="flex flex-col gap-1">
              <span className="text-sm text-fairway">Playing as</span>
              <div className={`${cardBox} flex items-center justify-between gap-2 p-3 text-lg text-forest`}>
                <span>{golfer.name}</span>
                <Link to="/profile" className="text-sm text-forest underline decoration-fairway decoration-2">
                  Change
                </Link>
              </div>
            </div>
          ) : (
            // A quiet placeholder while identity resolves — submit stays disabled, so no round
            // is ever created before we know whose it is.
            <div role="status" aria-label="Loading your profile" className="flex flex-col gap-1">
              <div className={`${cardBox} p-3 text-lg text-fairway/70`}>Loading your profile…</div>
            </div>
          )}

          {error && (
            <p role="alert" className="text-oxblood">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || !canSubmit}
            className={`${btnPrimary} disabled:opacity-50`}
          >
            Create round
          </button>
        </form>
      )}
    </main>
  );
}
