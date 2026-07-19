import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { courseHandicapFor, unratedCourseHandicap } from "@swng/client";
import type { CourseId } from "@swng/domain";
import { cardId, formatHandicapIndex, resolveIndex, strokeGrant } from "@swng/domain";
import type { CourseView, GetMyRecordResponse, StartRoundResponse } from "@swng/contracts";
import { ApiError, createRound, getCourse, getMyRecord } from "../api";
import { SignInCta } from "../auth/SignInCta";
import { useAuth } from "../auth/useAuth";
import { CourseSearch } from "../courses/CourseSearch";
import { CourseSummaryCard } from "../courses/CourseSummaryCard";
import { credentialStore } from "../identity";
import { btnPrimary, cardBox, inputBox } from "../ui/classes";

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
  // Destructured for a stable effect dep (withAuth is a useCallback — useAuth.ts), rather than
  // `auth` itself, which is a fresh object literal every render (ProfilePage's own precedent).
  const { withAuth } = auth;

  const [courseView, setCourseView] = useState<CourseView | undefined>(undefined);
  const [tee, setTee] = useState<string>("");
  const [courseError, setCourseError] = useState<string | undefined>(undefined);
  const [courseHandicap, setCourseHandicap] = useState("0");
  // The golfer's read-time metrics (GET /me/record) — the live input resolveIndex reads for a
  // swng/whs source. A nicety: a failed/absent fetch just leaves this undefined, so a computed
  // source resolves to no value and the strokes field stays typeable, never blocking the page
  // (index-source model spec §4; unrated-courses T5b).
  const [record, setRecord] = useState<GetMyRecordResponse | undefined>(undefined);
  // Seed-once flag (unrated-courses T5b): the strokes suggestion pre-fills the field
  // only while the golfer hasn't touched it — the moment they type, their value wins forever.
  const [touched, setTouched] = useState(false);
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

  // The metrics resolveIndex reads for a swng/whs source (unrated-courses T5b): one GET /me/record
  // when signed in. Purely a nicety — a rejection just leaves `record` undefined, so a computed
  // source resolves to no value (the golfer types their own strokes); it never blocks the page.
  useEffect(() => {
    if (!auth.signedIn) return;
    void withAuth((token) => getMyRecord(token))
      .then(setRecord)
      .catch(() => {}); // withAuth already handled a terminal 401; anything else just leaves the record unset
  }, [auth.signedIn, withAuth]);

  // "Strokes you get here" — the golfer's index turned into today's strokes, shown WITH its
  // derivation and editable (index-source model spec §6). The active index is resolved from the
  // golfer's CHOSEN source + the live metrics via the ONE domain resolver (the same one the profile
  // and JoinRoundPage call) — swng by default, whs if adopted, or a declared value. A rated tee
  // gets the exact Rule 6.1a figure (courseHandicapFor over the full card's holes); an unrated tee
  // has no slope/rating to convert, so it falls back to the index itself, hole-count-correct —
  // round(index) on 18, round(index / 2) on 9 (the /2 is a UI presentation of the estimate, not the
  // Rule 6.1a formula). No resolved value (a brand-new golfer, or a computed source with no data)
  // → no derivation note, so the field stays its plain "0" and they just type their strokes.
  const resolved = resolveIndex(golfer?.indexSource, record?.metrics ?? {});
  const selectedTeeSet = courseView?.card.teeSets.find((teeSet) => teeSet.name === tee);
  const suggestion = ((): { readonly value: number; readonly note: string } | undefined => {
    if (resolved.value === undefined || !selectedTeeSet) return undefined;
    const indexText = formatHandicapIndex(resolved.value); // +1.2 for a plus index — the domain owns the convention
    const sourceNoun = resolved.kind === "whs" ? "WHS index" : "index"; // spec §6: name a WHS source
    // The strokes lead reads through strokeGrant: a plus player GIVES strokes ("You give N"),
    // everyone else just receives the plain number — the view never tests the sign itself (spec §3).
    const lead = (value: number): string => {
      const grant = strokeGrant(value);
      return grant.kind === "gives" ? `You give ${grant.count}` : `${value}`;
    };
    if (selectedTeeSet.rating !== undefined && selectedTeeSet.slope !== undefined) {
      const value = courseHandicapFor(resolved.value, selectedTeeSet);
      return { value, note: `${lead(value)} — from your ${sourceNoun} (${indexText}) on this course` };
    }
    // Unrated: the strokes ≈ index estimate, halved for a 9-hole card (spec §4).
    const holeCount = selectedTeeSet.holes.length; // 9 or 18 — every card tee is one or the other
    const value = unratedCourseHandicap(resolved.value, holeCount);
    return { value, note: `${lead(value)} — from your ${sourceNoun} (${indexText}), adjusted for ${holeCount} holes; unrated course, adjust if it plays hard/easy` };
  })();
  const suggestedValue = suggestion?.value;

  // Seed the field (and re-seed on a tee change) only while untouched — a typed value is never
  // overwritten (`touched` gates it). The suggested value is a primitive dep, so a re-render that
  // recomputes the same number doesn't re-fire this.
  useEffect(() => {
    if (touched || suggestedValue === undefined) return;
    setCourseHandicap(String(suggestedValue));
  }, [touched, suggestedValue]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedHandicap = Number.parseInt(courseHandicap, 10);
    // Only ever reachable in the signed-in-with-a-golfer state (the form isn't rendered
    // otherwise), but guarded anyway: a course, a tee, a valid handicap, and a real golfer.
    if (!courseView || !tee || !Number.isInteger(parsedHandicap) || !golfer) return;

    setSubmitting(true);
    setError(undefined);
    try {
      // Course-cards spec §4: a REFERENCE, never a card — the server resolves and freezes the
      // lineage's CURRENT card itself. Accounts-only identity (spec §3): the creator seat is
      // always yourself, resolved server-side from the Bearer — the request carries no
      // name/golferId (the server freezes the account golfer's name into the join event).
      const response: StartRoundResponse = await auth.withAuth((token) =>
        createRound({ course: { courseId: courseView.courseId, cardId: cardId(courseView.cardId) }, host: { tee, courseHandicap: parsedHandicap } }, token),
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
                <Link to="/profile" className="text-sm text-forest underline decoration-gold decoration-2">
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

          {/* The derivation note is a SIBLING of the <label>, not nested inside it — nesting
              would fold it into the label's own accessible name (getByLabelText for the field
              would then have to match the note too). The plain label ("Strokes you get here") plus
              the visible derivation is the legibility rule (spec §4/§7): the field is the index
              turned into today's strokes, never a bare number and never a separate declaration. */}
          <div className="flex flex-col gap-1">
            <label className="flex flex-col gap-1 text-forest">
              Strokes you get here
              <input
                type="number"
                step={1}
                value={courseHandicap}
                onChange={(event) => {
                  setTouched(true); // a typed value wins over the seed from here on
                  setCourseHandicap(event.target.value);
                }}
                className={`${inputBox} text-lg`}
              />
            </label>
            {suggestion && <span className="text-xs text-fairway/70">{suggestion.note}</span>}
          </div>

          {error && (
            <p role="alert" className="text-oxblood">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || !courseView || !golfer}
            className={`${btnPrimary} disabled:opacity-50`}
          >
            Create round
          </button>
        </form>
      )}
    </main>
  );
}
