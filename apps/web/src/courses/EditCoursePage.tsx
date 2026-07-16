import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { courseId as makeCourseId } from "@swng/domain";
import type { TeeSet } from "@swng/domain";
import type { CourseView, SupersedeCardRequest } from "@swng/contracts";
import { ApiError, getCourse, supersedeCard } from "../api";
import { SignInCta } from "../auth/SignInCta";
import { useAuth } from "../auth/useAuth";
import { HoleGrid, defaultHoles, holesAreComplete, parseHoles } from "./HoleGrid";
import type { HoleCount, HoleInput } from "./HoleGrid";

type TeeSetInput = SupersedeCardRequest["teeSets"][number];

type Field = "name" | "teeName" | "rating" | "slope" | "holes";

// AddCoursePage's own FIELD_FOR_CODE, plus "duplicate-tee-name" (a whole-card submission can
// collide two tee names the way a brand-new course never could — AddCoursePage posts exactly
// one tee, so course.ts's own duplicate-name check can never fire there).
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
  // Which mode "Add a tee"/"Edit this card" (CoursePage's own two Links) landed in — absent
  // or false is "edit an existing tee"; true is "start a blank tee column at the card's own
  // hole count" (see holeCountOf below).
  readonly addTee?: boolean;
}

// A card's tees all share one hole count (course.ts's validateCard: `mismatched-hole-count`)
// — this is the ONE place that count is read off the loaded card, since add-tee mode's grid
// has no toggle of its own to set it (see HoleGrid's hideHoleCountToggle).
const holeCountOf = (view: CourseView): HoleCount => {
  const first = view.card.teeSets[0];
  return first && first.holes.length === 9 ? 9 : 18;
};

// Course-cards spec §7 (Courses-surface T6): the whole-card editor. Every submission — a
// number correction, a tee rename, a course rename, or a brand-new tee — POSTS THE ENTIRE
// CARD (PUT /courses/{courseId}); this page's only job is assembling that whole card from one
// edited (or added) tee plus every OTHER tee passed through verbatim, never a partial-tee wire
// shape. Single-tee editing UX (one column fits a phone) over that whole-card wire.
export function EditCoursePage() {
  const { courseId: param } = useParams<{ courseId: string }>();
  if (!param) return <Navigate to="/" replace />; // unreachable given the route pattern; keeps TS/runtime honest

  return <EditCoursePageForId courseIdParam={param} />;
}

function EditCoursePageForId({ courseIdParam }: { readonly courseIdParam: string }) {
  const id = makeCourseId(courseIdParam);
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();
  const addTee = Boolean((location.state as LocationState | null)?.addTee);

  const [view, setView] = useState<CourseView | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const [name, setName] = useState("");
  // The ORIGINAL tee being edited, identified by its ORIGINAL name — captured once at
  // selection time and never touched by the `teeName` input below, so a mid-edit rename never
  // loses track of which tee (and which teeId) submit is replacing. Stays undefined in
  // add-tee mode, where there is no original to track.
  const [selectedTeeName, setSelectedTeeName] = useState<string | undefined>(undefined);
  const [teeName, setTeeName] = useState("");
  const [rating, setRating] = useState("");
  const [slope, setSlope] = useState("");
  const [holes, setHoles] = useState<readonly HoleInput[]>(defaultHoles(18));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ readonly code: string; readonly message: string } | undefined>(undefined);

  // Seeds every tee-specific field from `tee` (a member of the just-(re)loaded card's own
  // teeSets) — the SAME idiom for the initial load, a tee-picker switch, and a post-409
  // re-seed, so none of those three paths can drift from the others.
  const selectTee = (courseView: CourseView, teeToEdit: string | undefined) => {
    const tee = courseView.card.teeSets.find((t) => t.name === teeToEdit) ?? courseView.card.teeSets[0];
    setSelectedTeeName(tee?.name);
    setTeeName(tee?.name ?? "");
    setRating(tee ? String(tee.rating) : "");
    setSlope(tee ? String(tee.slope) : "");
    setHoles(tee ? tee.holes.map((hole) => ({ par: String(hole.par), yardage: String(hole.yardage), strokeIndex: String(hole.strokeIndex) })) : defaultHoles(18));
  };

  // Seeds the WHOLE form from a freshly (re)loaded card: course name always from the card;
  // the tee fields either from the card's first tee (edit mode) or a blank column at the
  // card's own hole count (add-tee mode — defaultHoles(holeCountOf(...)) is the one place that
  // count comes from, since the toggle is hidden here).
  const seedFrom = (courseView: CourseView) => {
    setName(courseView.card.courseName);
    if (addTee) {
      setSelectedTeeName(undefined);
      setTeeName("");
      setRating("");
      setSlope("");
      setHoles(defaultHoles(holeCountOf(courseView)));
    } else {
      selectTee(courseView, courseView.card.teeSets[0]?.name);
    }
  };

  useEffect(() => {
    getCourse(id)
      .then((response) => {
        setView(response.course);
        seedFrom(response.course);
      })
      .catch((caught: unknown) => setLoadError(caught instanceof ApiError ? caught.message : "Could not load that course — try again."));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `id` is derived from courseIdParam, which keys this component's own mount (EditCoursePage's old load idiom); `addTee` is read once from router state at mount, and re-running this on every render would re-fetch on every keystroke below.
  }, []);

  const changeTeeToEdit = (teeToEdit: string) => {
    if (!view) return;
    selectTee(view, teeToEdit);
  };

  const updateHole = (index: number, patch: Partial<HoleInput>) => {
    setHoles((current) => current.map((hole, i) => (i === index ? { ...hole, ...patch } : hole)));
  };

  const parsedHoles = parseHoles(holes);
  const holesComplete = holesAreComplete(parsedHoles);
  const parsedRating = Number.parseFloat(rating);
  const parsedSlope = Number.parseInt(slope, 10);
  const holeCount: HoleCount = holes.length === 9 ? 9 : 18;

  const canSubmit =
    view !== undefined && name.trim().length > 0 && teeName.trim().length > 0 && Number.isFinite(parsedRating) && Number.isInteger(parsedSlope) && holesComplete;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!view || !canSubmit) return;

    setSubmitting(true);
    setError(undefined);
    setNotice(undefined);

    // The ONE assembly point (brief: "the submission is always the entire card"): the tee
    // being edited/added, plus — for edit mode — every OTHER tee from the loaded card passed
    // through VERBATIM (same teeId, same everything), in its original position. Add-tee mode
    // keeps every existing tee unchanged and appends the new one id-less at the end.
    const originalTee = addTee ? undefined : view.card.teeSets.find((t) => t.name === selectedTeeName);
    const submittedTee: TeeSetInput = {
      ...(originalTee?.teeId !== undefined ? { teeId: originalTee.teeId } : {}),
      name: teeName.trim(),
      rating: parsedRating,
      slope: parsedSlope,
      holes: parsedHoles,
    };
    // Mutable (not `readonly TeeSetInput[]`): SupersedeCardRequest's own inferred type is
    // mutable (createCourseRequestSchema/supersedeCardRequestSchema carry no `.readonly()` on
    // teeSets, unlike most other wire arrays), so supersedeCard's parameter expects exactly that.
    // Every existing card is rated today (unrated-courses spec Task 1 is additive-only — this
    // page's whole-card round-trip doesn't yet offer an unrated path), so the `!`s just narrow
    // TeeSet.rating/slope's now-optional type back to the wire's still-required TeeSetInput.
    const carryOver = (tee: TeeSet): TeeSetInput => ({ ...tee, rating: tee.rating!, slope: tee.slope! });
    const teeSets: TeeSetInput[] = addTee
      ? [...view.card.teeSets.map(carryOver), submittedTee]
      : view.card.teeSets.map((tee) => (tee === originalTee ? submittedTee : carryOver(tee)));

    try {
      await auth.withAuth((token) => supersedeCard(id, { name: name.trim(), teeSets, supersedes: view.cardId }, token));
      navigate(`/courses/${id}`);
    } catch (caught) {
      // The spec's own 409 idiom: a stale `supersedes` means someone else's edit landed first
      // — re-fetch the current card, re-seed the form from IT (never silently transplant this
      // golfer's numbers onto a card they never saw), and say so, rather than a raw conflict
      // error the golfer has no way to act on.
      if (caught instanceof ApiError && caught.code === "card-superseded") {
        try {
          const fresh = await getCourse(id);
          setView(fresh.course);
          seedFrom(fresh.course);
          setNotice("This card was just updated — review the new numbers.");
        } catch (refetchCaught) {
          setError({
            code: "unknown",
            message: refetchCaught instanceof ApiError ? refetchCaught.message : "Could not refresh this card — try again.",
          });
        }
        setSubmitting(false);
        return;
      }
      if (caught instanceof ApiError) setError({ code: caught.code, message: caught.message });
      else setError({ code: "unknown", message: "Could not save this card — try again." });
      setSubmitting(false);
    }
  };

  const errorFor = (field: Field): string | undefined => (error && FIELD_FOR_CODE[error.code] === field ? error.message : undefined);
  const generalError = error && FIELD_FOR_CODE[error.code] === undefined ? error.message : undefined;

  const title = addTee ? "Add a tee" : "Edit this card";

  if (loadError) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-slate-950 p-6 text-slate-100">
        <h1 className="text-2xl font-bold">{title}</h1>
        <p role="alert" className="text-red-400">
          {loadError}
        </p>
      </main>
    );
  }

  if (!view) {
    return (
      <div role="status" aria-label="Loading course" className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100">
        Loading…
      </div>
    );
  }

  // The wall: correcting a card is signed-in-only, same SignInCta idiom AddCoursePage uses —
  // loaded AFTER the card fetch (auth:none) so the message can name the specific course.
  if (!auth.signedIn) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-slate-950 p-6 text-slate-100">
        <h1 className="text-2xl font-bold">{title}</h1>
        <SignInCta message={`Sign in to ${addTee ? "add a tee to" : "edit"} ${view.card.courseName}.`} returnTo={`/courses/${id}/edit`} />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-slate-950 p-6 text-slate-100">
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="text-slate-400">{view.card.courseName}</p>

      {notice && (
        <p role="status" className="text-amber-400">
          {notice}
        </p>
      )}

      <form onSubmit={submit} className="flex flex-col gap-4">
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

        {/* Only in edit mode: which of the card's existing tees this submission replaces.
            Add-tee mode has no "which one" to pick — every existing tee already passes through
            untouched, and the tee name below always names the NEW one. */}
        {!addTee && (
          <label className="flex flex-col gap-1">
            Tee to edit
            <select value={selectedTeeName ?? ""} onChange={(event) => changeTeeToEdit(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg">
              {view.card.teeSets.map((teeSet) => (
                <option key={teeSet.name} value={teeSet.name}>
                  {teeSet.name} — rating {teeSet.rating}, slope {teeSet.slope}
                </option>
              ))}
            </select>
          </label>
        )}

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

        {/* hideHoleCountToggle: this card's hole count is fixed by every OTHER tee on it
            (course.ts's validateCard) — there is no toggle here to pin the invariant with. */}
        <HoleGrid
          holeCount={holeCount}
          onChangeHoleCount={() => {}}
          holes={holes}
          onChangeHole={updateHole}
          error={errorFor("holes")}
          hideHoleCountToggle
        />

        {generalError && (
          <p role="alert" className="text-red-400">
            {generalError}
          </p>
        )}

        <button type="submit" disabled={!canSubmit || submitting} className="rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold disabled:opacity-50">
          Save changes
        </button>
      </form>
    </main>
  );
}
