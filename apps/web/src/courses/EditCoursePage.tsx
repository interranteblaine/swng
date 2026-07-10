import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { courseId as makeCourseId } from "@swng/domain";
import type { CourseView } from "@swng/contracts";
import { ApiError, addTeeSet, getCourse } from "../api";
import { useAuth } from "../auth/useAuth";
import { HoleGrid, defaultHoles, holesAreComplete, parseHoles } from "./HoleGrid";
import type { HoleCount, HoleInput } from "./HoleGrid";

type Field = "rating" | "slope" | "holes";

// The revise-flow subset of AddCoursePage's own FIELD_FOR_CODE (I2/papercut 3): a revision
// always posts the SAME tee name (never invalid-tee-name/duplicate-tee-name — addTeeSet's
// own isRevision check skips the collision test entirely for a name match) and never touches
// the course's own name (invalid-course-name can't fire here either).
const FIELD_FOR_CODE: Readonly<Record<string, Field>> = {
  "invalid-rating": "rating",
  "invalid-slope": "slope",
  "invalid-hole-count": "holes",
  "invalid-hole-numbering": "holes",
  "invalid-par": "holes",
  "invalid-yardage": "holes",
  "invalid-stroke-index": "holes",
};

interface LocationState {
  // Which tee "Edit this card" was tapped for (CourseSummaryCard's own Link state) — falls
  // back to the course's first tee so a direct/refreshed visit to this URL still renders
  // something sane rather than a dead end.
  readonly teeName?: string;
  // Where the golfer came from — success returns here (brief: "returns to where the golfer
  // came from"), carrying the refreshed CourseView (M-i: the edit flow's own onCourseRefreshed
  // call site, mirroring CourseSummaryCard's verify-409 re-fetch).
  readonly returnTo?: string;
}

// I2 (papercut 3): the revise endpoint (`POST /courses/{id}/tees` — same tee name ⇒ new
// version, supersedes, verifications reset) shipped in M6 with zero web callers. This page is
// the first: load the course, pre-fill the SAME HoleGrid AddCoursePage uses with the current
// tee's numbers (never a hand-copy — see HoleGrid.tsx), and post the correction back under the
// unchanged tee name so the server treats it as a revision, not a brand-new tee.
export function EditCoursePage() {
  const { courseId: courseIdParam } = useParams<{ courseId: string }>();
  if (!courseIdParam) return <Navigate to="/" replace />; // unreachable given the route pattern; keeps TS/runtime honest

  return <EditCoursePageForId courseIdParam={courseIdParam} />;
}

function EditCoursePageForId({ courseIdParam }: { readonly courseIdParam: string }) {
  const id = makeCourseId(courseIdParam);
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();
  const state = location.state as LocationState | null;

  const [courseView, setCourseView] = useState<CourseView | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [enteredBy, setEnteredBy] = useState("");
  const [rating, setRating] = useState("");
  const [slope, setSlope] = useState("");
  const [holeCount, setHoleCount] = useState<HoleCount>(18);
  const [holes, setHoles] = useState<readonly HoleInput[]>(defaultHoles(18));
  const [prefilled, setPrefilled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ readonly code: string; readonly message: string } | undefined>(undefined);

  useEffect(() => {
    getCourse(id)
      .then((response) => setCourseView(response.course))
      .catch((caught: unknown) => setLoadError(caught instanceof ApiError ? caught.message : "Could not load that course — try again."));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `id` is derived from courseIdParam, which keys this component's own mount (see EditCoursePage above); re-running per render would re-fetch on every keystroke.
  }, []);

  const teeName = state?.teeName ?? courseView?.card.teeSets[0]?.name;

  // Pre-fill (I2): seeds the SAME grid from the currently fetched tee's exact numbers, once,
  // the moment the course arrives — never re-seeds afterward (a golfer's in-progress
  // corrections must survive any later re-render of this effect's own dependencies).
  useEffect(() => {
    if (!courseView || prefilled || !teeName) return;
    const tee = courseView.card.teeSets.find((t) => t.name === teeName);
    if (!tee) return;
    setRating(String(tee.rating));
    setSlope(String(tee.slope));
    setHoleCount(tee.holes.length === 9 ? 9 : 18);
    setHoles(tee.holes.map((hole) => ({ par: String(hole.par), yardage: String(hole.yardage), strokeIndex: String(hole.strokeIndex) })));
    setPrefilled(true);
  }, [courseView, prefilled, teeName]);

  // Auto-fill (M7 Task 6 idiom, carried into the edit flow): "Your name" defaults to the
  // signed-in golfer's name once GET /me resolves — only into a still-empty field, never over
  // something already typed.
  const signedInName = auth.golfer?.name;
  useEffect(() => {
    if (!signedInName) return;
    setEnteredBy((current) => (current === "" ? signedInName : current));
  }, [signedInName]);

  const changeHoleCount = (next: HoleCount) => {
    setHoleCount(next);
    setHoles(defaultHoles(next));
  };

  const updateHole = (index: number, patch: Partial<HoleInput>) => {
    setHoles((current) => current.map((hole, i) => (i === index ? { ...hole, ...patch } : hole)));
  };

  const parsedHoles = parseHoles(holes);
  const holesComplete = holesAreComplete(parsedHoles);
  const parsedRating = Number.parseFloat(rating);
  const parsedSlope = Number.parseInt(slope, 10);

  const canSubmit = Boolean(teeName) && enteredBy.trim().length > 0 && Number.isFinite(parsedRating) && Number.isInteger(parsedSlope) && holesComplete;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!teeName || !canSubmit) return;

    setSubmitting(true);
    setError(undefined);
    try {
      // The SAME tee name, always — that's what makes this a revision (course.ts's addTeeSet:
      // matching name ⇒ new version, supersedes, verifications reset) rather than a brand-new,
      // unrelated tee set living alongside the one the golfer meant to correct.
      const response = await addTeeSet(id, { tee: { name: teeName, rating: parsedRating, slope: parsedSlope, holes: parsedHoles }, enteredBy: enteredBy.trim() });
      // M-i: the edit flow's own onCourseRefreshed call site — the destination reads
      // `refreshedCourse` back out of router state (CreateRoundPage's own location-state
      // effect) so its held freeze source never goes stale, mirroring CourseSummaryCard's
      // verify-409 re-fetch.
      navigate(state?.returnTo ?? "/create", { state: { refreshedCourse: response.course } });
    } catch (caught) {
      if (caught instanceof ApiError) setError({ code: caught.code, message: caught.message });
      else setError({ code: "unknown", message: "Could not save the correction — try again." });
      setSubmitting(false);
    }
  };

  const errorFor = (field: Field): string | undefined => (error && FIELD_FOR_CODE[error.code] === field ? error.message : undefined);
  const generalError = error && FIELD_FOR_CODE[error.code] === undefined ? error.message : undefined;

  if (loadError) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-slate-950 p-6 text-slate-100">
        <h1 className="text-2xl font-bold">Edit this card</h1>
        <p role="alert" className="text-red-400">
          {loadError}
        </p>
      </main>
    );
  }

  if (!courseView || !teeName) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-slate-950 p-6 text-slate-100">
        <h1 className="text-2xl font-bold">Edit this card</h1>
        <p>Loading…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-slate-950 p-6 text-slate-100">
      <h1 className="text-2xl font-bold">Edit this card</h1>
      <p className="text-slate-400">
        Correcting <span className="font-semibold text-slate-100">{courseView.name}</span> — {teeName} tee
      </p>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          Your name
          <input value={enteredBy} onChange={(event) => setEnteredBy(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg" />
        </label>

        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            Rating
            <input value={rating} onChange={(event) => setRating(event.target.value)} inputMode="decimal" className="rounded-lg bg-slate-800 p-3 text-lg" />
          </label>
          {errorFor("rating") && (
            <span role="alert" className="text-sm text-red-400">
              {errorFor("rating")}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            Slope
            <input value={slope} onChange={(event) => setSlope(event.target.value)} inputMode="numeric" className="rounded-lg bg-slate-800 p-3 text-lg" />
          </label>
          {errorFor("slope") && (
            <span role="alert" className="text-sm text-red-400">
              {errorFor("slope")}
            </span>
          )}
        </div>

        <HoleGrid holeCount={holeCount} onChangeHoleCount={changeHoleCount} holes={holes} onChangeHole={updateHole} error={errorFor("holes")} />

        {generalError && (
          <p role="alert" className="text-red-400">
            {generalError}
          </p>
        )}

        {/* The revision contract, said plainly (brief): same tee name ⇒ a NEW version, and
            every prior verification resets — a golfer must know their fix wipes the trust
            badges before they tap Save, not discover it after. */}
        <p className="text-sm text-amber-400">Saving creates a corrected, unverified version — verifications on the current card will reset.</p>

        <button type="submit" disabled={!canSubmit || submitting} className="rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold disabled:opacity-50">
          Save correction
        </button>
      </form>
    </main>
  );
}
