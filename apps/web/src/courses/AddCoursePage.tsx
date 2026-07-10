import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router";
import { ApiError, createCourse } from "../api";
import { useAuth } from "../auth/useAuth";
import { HoleGrid, defaultHoles, holesAreComplete, parseHoles } from "./HoleGrid";
import type { HoleCount, HoleInput } from "./HoleGrid";

type Field = "name" | "teeName" | "rating" | "slope" | "holes";

// Every DomainError code course.ts's validateCourseName/validateTeeSet can throw (packages/
// domain/src/course/course.ts) — the one vocabulary this page's inline errors speak, never a
// hand-rolled rule set that could drift from the domain's own invariants (brief: "client-side
// validation surfaces the domain's own error codes"). The four hole-shape codes can't be
// pinned to one row (the server reports "some hole failed," not which), so they all land on
// the grid's own shared error slot instead of a specific row.
const FIELD_FOR_CODE: Readonly<Record<string, Field>> = {
  "invalid-course-name": "name",
  "invalid-tee-name": "teeName",
  "invalid-rating": "rating",
  "invalid-slope": "slope",
  "invalid-hole-count": "holes",
  "invalid-hole-numbering": "holes",
  "invalid-par": "holes",
  "invalid-yardage": "holes",
  "invalid-stroke-index": "holes",
  "duplicate-tee-name": "teeName",
};

// The keyboard-first, single-screen course entry flow (M6 Task 5, redesigned M7 Task 7 —
// papercut 2's illegible grid): course name, tee name, rating, slope, then HoleGrid (the
// hole-count toggle + grid, shared with EditCoursePage so a correction pre-fills and
// validates against the exact same code — see HoleGrid.tsx). This page now owns only the
// fields the grid doesn't: name/enteredBy/teeName/rating/slope, and the submit wiring.
export function AddCoursePage() {
  const navigate = useNavigate();
  const auth = useAuth();

  const [name, setName] = useState("");
  const [enteredBy, setEnteredBy] = useState("");
  const [teeName, setTeeName] = useState("");
  const [rating, setRating] = useState("");
  const [slope, setSlope] = useState("");
  const [holeCount, setHoleCount] = useState<HoleCount>(18);
  const [holes, setHoles] = useState<readonly HoleInput[]>(defaultHoles(18));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ readonly code: string; readonly message: string } | undefined>(undefined);

  // Auto-fill (M7 Task 6, an M6 carry): "Your name" defaults to the signed-in golfer's name
  // once GET /me resolves (it arrives async, hence an effect rather than a useState seed) —
  // only into a still-empty field, never over something already typed, and the wire shape is
  // unchanged (enteredBy still submits whatever the field holds).
  const signedInName = auth.golfer?.name;
  useEffect(() => {
    if (!signedInName) return;
    setEnteredBy((current) => (current === "" ? signedInName : current));
  }, [signedInName]);

  const changeHoleCount = (next: HoleCount) => {
    setHoleCount(next);
    // A fresh grid, not a resize-in-place: a stale 10th-18th row surviving an 18→9 switch (or
    // vice versa) is worse than just starting the new count over.
    setHoles(defaultHoles(next));
  };

  const updateHole = (index: number, patch: Partial<HoleInput>) => {
    setHoles((current) => current.map((hole, i) => (i === index ? { ...hole, ...patch } : hole)));
  };

  const parsedHoles = parseHoles(holes);
  const holesComplete = holesAreComplete(parsedHoles);
  const parsedRating = Number.parseFloat(rating);
  const parsedSlope = Number.parseInt(slope, 10);

  // Form-completeness gating only (every existing page's own "is this even parseable" guard,
  // e.g. CreateRoundPage's courseHandicap check) — NOT a re-implementation of domain's bounds/
  // permutation rules (rating 30..90, slope 55..155, SI a permutation, ...). Those live once,
  // in course.ts, and reach the golfer via the server's own coded rejection below.
  const canSubmit =
    name.trim().length > 0 && enteredBy.trim().length > 0 && teeName.trim().length > 0 && Number.isFinite(parsedRating) && Number.isInteger(parsedSlope) && holesComplete;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(undefined);
    try {
      const response = await createCourse({
        name: name.trim(),
        tee: { name: teeName.trim(), rating: parsedRating, slope: parsedSlope, holes: parsedHoles },
        enteredBy: enteredBy.trim(),
      });
      // Success → /create, with the just-added course preselected (brief) — CreateRoundPage
      // fetches the full CourseView from this id itself (the same path a search pick takes),
      // so this page hands over nothing but the id.
      navigate("/create", { state: { courseId: response.course.courseId } });
    } catch (caught) {
      if (caught instanceof ApiError) setError({ code: caught.code, message: caught.message });
      else setError({ code: "unknown", message: "Could not add the course — try again." });
      setSubmitting(false);
    }
  };

  const errorFor = (field: Field): string | undefined => (error && FIELD_FOR_CODE[error.code] === field ? error.message : undefined);
  // Any code this page doesn't have a field slot for (network, a 500, ...) — the same generic
  // fallback every other page's catch block already shows.
  const generalError = error && FIELD_FOR_CODE[error.code] === undefined ? error.message : undefined;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-slate-950 p-6 text-slate-100">
      <h1 className="text-2xl font-bold">Add a course</h1>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {/* The error span is a SIBLING of the <label>, not nested inside it — nesting it would
            fold the error text into the label's own accessible name (every getByLabelText
            lookup for this field would then have to match the error text too, not just the
            field's name). */}
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            Course name
            <input value={name} onChange={(event) => setName(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg" />
          </label>
          {errorFor("name") && (
            <span role="alert" className="text-sm text-red-400">
              {errorFor("name")}
            </span>
          )}
        </div>

        <label className="flex flex-col gap-1">
          Your name
          <input value={enteredBy} onChange={(event) => setEnteredBy(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg" />
        </label>

        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            Tee name
            <input value={teeName} onChange={(event) => setTeeName(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg" />
          </label>
          {errorFor("teeName") && (
            <span role="alert" className="text-sm text-red-400">
              {errorFor("teeName")}
            </span>
          )}
        </div>

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

        <button type="submit" disabled={!canSubmit || submitting} className="rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold disabled:opacity-50">
          Add course
        </button>
      </form>
    </main>
  );
}
