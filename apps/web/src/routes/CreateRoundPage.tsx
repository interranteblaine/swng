import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { CourseId } from "@swng/domain";
import { cardId } from "@swng/domain";
import type { CourseView, StartRoundResponse } from "@swng/contracts";
import { ApiError, createRound, getCourse, getMyRecord } from "../api";
import { SignInCta } from "../auth/SignInCta";
import { useAuth } from "../auth/useAuth";
import { CourseSearch } from "../courses/CourseSearch";
import { CourseSummaryCard } from "../courses/CourseSummaryCard";
import { credentialStore } from "../identity";
import { btnPrimary, cardBox, inputBox } from "../ui/classes";
import { usePageTitle } from "../ui/usePageTitle";

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
  // Destructured so the record-fetch effect below lists a stable function reference as its dep
  // (withAuth's own useCallback identity, useAuth.ts) rather than the whole `auth` object, which is
  // a fresh literal every AuthProvider render — the ProfilePage precedent.
  const { withAuth } = auth;
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
  // What the golfer normally shoots relative to par (spec 2026-07-29 §2): starting a round is
  // joining it as the host, so the creator states the same one number a joiner does, in the same
  // words.
  // Pre-filled from the golfer's own average (spec 2026-07-29 §2c): what they normally shoot is
  // exactly the number this field asks for, so the one they can already read on their profile lands
  // here as a starting point they can type over. BLANK when there is no average — a brand-new
  // golfer, or one whose every round contains a pickup — with no floor and no fallback chain: one
  // finished round is better evidence than a guess, and a guess in this field becomes a claim in
  // the round's log. Seeded ONCE, and only while the field is still untouched, so a pre-fill
  // arriving after the golfer has typed can never overwrite what they typed.
  const [overPar, setOverPar] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // GET /me/record purely for the pre-fill above — the average is served, never computed here
  // (the compute fence: `averageOf` is deliberately not re-exported to the client). A failed fetch
  // just leaves the field blank, which is the honest no-average state anyway.
  useEffect(() => {
    if (!auth.signedIn) return;
    let ignore = false;
    void withAuth((token) => getMyRecord(token))
      .then((record) => {
        if (ignore) return;
        const average = record.metrics.average;
        if (average !== undefined) setOverPar((current) => (current === "" ? String(average) : current));
      })
      .catch(() => {}); // withAuth already handles a terminal 401; anything else leaves the field blank
    return () => {
      ignore = true;
    };
  }, [auth.signedIn, withAuth]);

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

  const parsedOverPar = Number.parseInt(overPar, 10);
  const canSubmit = courseView !== undefined && tee !== "" && Number.isInteger(parsedOverPar) && golfer !== undefined;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Only ever reachable in the signed-in-with-a-golfer state (the form isn't rendered
    // otherwise), but guarded anyway: a course, a tee, a stated number, and a real golfer.
    if (!canSubmit || !courseView || !golfer) return;

    setSubmitting(true);
    setError(undefined);
    try {
      // Course-cards spec §4: a REFERENCE, never a card — the server resolves and freezes the
      // lineage's CURRENT card itself. Accounts-only identity (spec §3): the creator seat is
      // always yourself, resolved server-side from the Bearer — the request carries no
      // name/golferId (the server freezes the account golfer's name into the join event).
      const response: StartRoundResponse = await auth.withAuth((token) =>
        createRound({ course: { courseId: courseView.courseId, cardId: cardId(courseView.cardId) }, host: { tee, basis: { kind: "normally-shoots", overPar: parsedOverPar } } }, token),
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

          {/* The SAME question the join form asks, in the same words (spec 2026-07-29 §2/§9,
              verbatim): starting a round is joining it as the host. No conversion and no derivation
              note — the number stated IS the number strokes come from, and the strokes themselves
              fall out of the whole field once everyone has stated theirs. The hint is a SIBLING of
              the <label> (not nested), which would fold it into the label's accessible name. */}
          <div className="flex flex-col gap-1">
            <label className="flex flex-col gap-1 text-forest">
              What do you normally shoot, relative to par?
              <input
                type="number"
                step={1}
                inputMode="numeric"
                value={overPar}
                onChange={(event) => setOverPar(event.target.value)}
                className={`${inputBox} text-lg`}
              />
            </label>
            <span className="text-xs text-fairway/70">Over par for a normal round — 18 holes. Under par? Use a minus.</span>
          </div>

          {error && (
            <p role="alert" className="text-oxblood">
              {error}
            </p>
          )}

          {/* Disabled until the number is there too: a blank field is not a claim, so submitting
              one must be visibly impossible rather than a silently dead button. */}
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
