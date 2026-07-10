import { useState } from "react";
import type { FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { ApiError, createCourse } from "../api";

type HoleCount = 9 | 18;

interface HoleInput {
  readonly par: string;
  readonly yardage: string;
  readonly strokeIndex: string;
}

// Par defaults to 4 (brief) — the modal case on a real card, so a golfer typing straight down
// the grid only has to touch the pars that DIFFER from 4. Yardage/strokeIndex start blank:
// there's no sane default for either (strokeIndex especially — see the "never auto-assign"
// comment below).
const defaultHoles = (count: HoleCount): readonly HoleInput[] => Array.from({ length: count }, () => ({ par: "4", yardage: "", strokeIndex: "" }));

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

interface LocationState {
  readonly enteredBy?: string;
}

// The keyboard-first, single-screen course entry flow (M6 Task 5, built to the product's
// 10-minute gate): course name, tee name, rating, slope, a 9/18 toggle, then a hole grid whose
// tab order runs left-to-right top-to-bottom (par, yardage, SI per row) purely from DOM order —
// no explicit tabIndex plumbing, so a screen reader and a keyboard both get the same order for
// free.
export function AddCoursePage() {
  const navigate = useNavigate();
  const location = useLocation();
  // A name already typed into CreateRoundPage before bouncing here via CourseSearch's
  // empty-state link rides as router state — a one-time hint for this navigation, never a
  // bookmarkable value.
  const prefillEnteredBy = (location.state as LocationState | null)?.enteredBy ?? "";

  const [name, setName] = useState("");
  const [enteredBy, setEnteredBy] = useState(prefillEnteredBy);
  const [teeName, setTeeName] = useState("");
  const [rating, setRating] = useState("");
  const [slope, setSlope] = useState("");
  const [holeCount, setHoleCount] = useState<HoleCount>(18);
  const [holes, setHoles] = useState<readonly HoleInput[]>(defaultHoles(18));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ readonly code: string; readonly message: string } | undefined>(undefined);

  const changeHoleCount = (next: HoleCount) => {
    setHoleCount(next);
    // A fresh grid, not a resize-in-place: a stale 10th-18th row surviving an 18→9 switch (or
    // vice versa) is worse than just starting the new count over.
    setHoles(defaultHoles(next));
  };

  const updateHole = (index: number, patch: Partial<HoleInput>) => {
    setHoles((current) => current.map((hole, i) => (i === index ? { ...hole, ...patch } : hole)));
  };

  // The unused indexes, as a HINT only — never written back into a hole's own field. Typos in
  // stroke index poison every game's dot allocation for the life of the course, so the one
  // thing this page must never do is guess: the golfer types exactly what the paper card says,
  // this just tells them what's left to place.
  const usedStrokeIndexes = new Set(holes.map((h) => h.strokeIndex).filter((v) => v !== ""));
  const remainingStrokeIndexes = Array.from({ length: holeCount }, (_, i) => i + 1).filter((n) => !usedStrokeIndexes.has(String(n)));

  const parsedHoles = holes.map((hole, index) => ({
    number: index + 1,
    par: Number.parseInt(hole.par, 10),
    yardage: Number.parseInt(hole.yardage, 10),
    strokeIndex: Number.parseInt(hole.strokeIndex, 10),
  }));
  const holesComplete = parsedHoles.every((hole) => Number.isInteger(hole.par) && Number.isInteger(hole.yardage) && Number.isInteger(hole.strokeIndex));
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

        <fieldset role="radiogroup" aria-label="Holes" className="flex gap-4">
          {([9, 18] as const).map((count) => (
            <label key={count} className="flex items-center gap-2">
              <input type="radio" name="holeCount" checked={holeCount === count} onChange={() => changeHoleCount(count)} className="h-5 w-5" />
              {count}
            </label>
          ))}
        </fieldset>

        <p aria-label="Stroke index remaining" className="text-xs text-slate-400">
          SI remaining: {remainingStrokeIndexes.length > 0 ? remainingStrokeIndexes.join(", ") : "none"}
        </p>

        <div className="flex flex-col gap-1">
          {holes.map((hole, index) => {
            const n = index + 1;
            return (
              <div key={n} className="grid grid-cols-[2rem_1fr_1fr_1fr] items-center gap-2">
                <span className="text-sm text-slate-400">{n}</span>
                <input
                  aria-label={`Hole ${n} par`}
                  value={hole.par}
                  onChange={(event) => updateHole(index, { par: event.target.value })}
                  inputMode="numeric"
                  className="rounded-md bg-slate-800 p-2 text-center"
                />
                <input
                  aria-label={`Hole ${n} yardage`}
                  value={hole.yardage}
                  onChange={(event) => updateHole(index, { yardage: event.target.value })}
                  inputMode="numeric"
                  className="rounded-md bg-slate-800 p-2 text-center"
                />
                <input
                  aria-label={`Hole ${n} stroke index`}
                  value={hole.strokeIndex}
                  onChange={(event) => updateHole(index, { strokeIndex: event.target.value })}
                  inputMode="numeric"
                  className="rounded-md bg-slate-800 p-2 text-center"
                />
              </div>
            );
          })}
        </div>
        {errorFor("holes") && (
          <p role="alert" className="text-red-400">
            {errorFor("holes")}
          </p>
        )}

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
