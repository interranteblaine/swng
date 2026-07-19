import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { courseId as makeCourseId } from "@swng/domain";
import type { TeeSet } from "@swng/domain";
import type { CourseView, SupersedeCardRequest } from "@swng/contracts";
import { ApiError, getCourse, supersedeCard } from "../api";
import { SignInCta } from "../auth/SignInCta";
import { useAuth } from "../auth/useAuth";
import { btnPrimary, inputBox } from "../ui/classes";
import { HoleGrid, defaultHoles, holesAreComplete, parseHoles } from "./HoleGrid";
import type { HoleCount, HoleInput } from "./HoleGrid";
import { teeNumbers } from "./teeNumbers";

type TeeSetInput = SupersedeCardRequest["teeSets"][number];

type Field = "name" | "teeName" | "rating" | "slope" | "holes";

// AddCoursePage's own FIELD_FOR_CODE, plus "duplicate-tee-name" (a whole-card submission can
// collide two tee names the way a brand-new course never could — AddCoursePage posts exactly
// one tee, so course.ts's own duplicate-name check can never fire there). `rating-slope-paired`
// is routed to BOTH fields via PAIRED_CODE (same idiom as AddCoursePage), not listed here.
const PAIRED_CODE = "rating-slope-paired";
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
    // An unrated tee (rating/slope absent) seeds BLANK inputs, not the string "undefined" — the
    // editor round-trips it back out unrated, and the golfer can fill the numbers to rate it.
    setRating(tee?.rating !== undefined ? String(tee.rating) : "");
    setSlope(tee?.slope !== undefined ? String(tee.slope) : "");
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
  // Optional rating/slope (unrated-courses arc): blank = unrated. Parse only to keep a NaN off the
  // wire — a filled rating must be finite, a filled slope an integer; the pairing is the server's.
  const ratingBlank = rating.trim().length === 0;
  const slopeBlank = slope.trim().length === 0;
  const parsedRating = Number.parseFloat(rating);
  const parsedSlope = Number.parseInt(slope, 10);
  const holeCount: HoleCount = holes.length === 9 ? 9 : 18;

  const canSubmit =
    view !== undefined &&
    name.trim().length > 0 &&
    teeName.trim().length > 0 &&
    (ratingBlank || Number.isFinite(parsedRating)) &&
    (slopeBlank || Number.isInteger(parsedSlope)) &&
    holesComplete;

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
    // Conditional-spread rating/slope: a blank field is OMITTED (never a NaN/undefined on the
    // wire), so an unrated tee submits as `{ name, holes }` and a filled one carries its numbers.
    // A value in exactly one surfaces the server's `rating-slope-paired` on the pair.
    const submittedTee: TeeSetInput = {
      ...(originalTee?.teeId !== undefined ? { teeId: originalTee.teeId } : {}),
      name: teeName.trim(),
      ...(ratingBlank ? {} : { rating: parsedRating }),
      ...(slopeBlank ? {} : { slope: parsedSlope }),
      holes: parsedHoles,
    };
    // Mutable (not `readonly TeeSetInput[]`): SupersedeCardRequest's own inferred type is
    // mutable (createCourseRequestSchema/supersedeCardRequestSchema carry no `.readonly()` on
    // teeSets, unlike most other wire arrays), so supersedeCard's parameter expects exactly that.
    // The write schema now accepts unrated tees (rating/slope optional-as-a-pair), so a carried-
    // over tee round-trips VERBATIM: `{ ...tee }` keeps its teeId + holes and, because TeeSet's
    // rating/slope are optional, omits an absent number by construction rather than carrying an
    // explicit `undefined`. No guard, no assert, no throw — an unrated card's other tees survive a
    // supersede of one tee exactly as written.
    const carryOver = (tee: TeeSet): TeeSetInput => ({ ...tee });
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

  const errorFor = (field: Field): string | undefined => {
    if (!error) return undefined;
    // The paired error lands on BOTH rating and slope (unrated-courses arc) — same routing as
    // AddCoursePage: the golfer set one and not the other, so both are named.
    if (error.code === PAIRED_CODE) return field === "rating" || field === "slope" ? error.message : undefined;
    return FIELD_FOR_CODE[error.code] === field ? error.message : undefined;
  };
  const generalError = error && error.code !== PAIRED_CODE && FIELD_FOR_CODE[error.code] === undefined ? error.message : undefined;

  const title = addTee ? "Add a tee" : "Edit this card";

  if (loadError) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-cream p-6">
        <h1 className="text-2xl font-bold text-forest">{title}</h1>
        <p role="alert" className="text-oxblood">
          {loadError}
        </p>
      </main>
    );
  }

  if (!view) {
    return (
      <div role="status" aria-label="Loading course" className="flex min-h-screen items-center justify-center bg-cream text-forest">
        Loading…
      </div>
    );
  }

  // The wall: correcting a card is signed-in-only, same SignInCta idiom AddCoursePage uses —
  // loaded AFTER the card fetch (auth:none) so the message can name the specific course.
  if (!auth.signedIn) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-cream p-6">
        <h1 className="text-2xl font-bold text-forest">{title}</h1>
        <SignInCta message={`Sign in to ${addTee ? "add a tee to" : "edit"} ${view.card.courseName}.`} returnTo={`/courses/${id}/edit`} />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-cream p-6">
      <h1 className="text-2xl font-bold text-forest">{title}</h1>
      <p className="text-fairway">{view.card.courseName}</p>

      {notice && (
        <p role="status" className="border border-gold bg-goldwash p-3 text-sm text-forest">
          {notice}
        </p>
      )}

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1 text-forest">
            Course name
            <input value={name} onChange={(event) => setName(event.target.value)} className={`${inputBox} text-lg`} />
          </label>
          {errorFor("name") && (
            <span role="alert" className="text-sm text-oxblood">
              {errorFor("name")}
            </span>
          )}
        </div>

        {/* Only in edit mode: which of the card's existing tees this submission replaces.
            Add-tee mode has no "which one" to pick — every existing tee already passes through
            untouched, and the tee name below always names the NEW one. */}
        {!addTee && (
          <label className="flex flex-col gap-1 text-forest">
            Tee to edit
            <select value={selectedTeeName ?? ""} onChange={(event) => changeTeeToEdit(event.target.value)} className={`${inputBox} text-lg`}>
              {view.card.teeSets.map((teeSet) => (
                <option key={teeSet.name} value={teeSet.name}>
                  {teeSet.name} — {teeNumbers(teeSet)}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1 text-forest">
            Tee name
            <input value={teeName} onChange={(event) => setTeeName(event.target.value)} className={`${inputBox} text-lg`} />
          </label>
          {errorFor("teeName") && (
            <span role="alert" className="text-sm text-oxblood">
              {errorFor("teeName")}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1 text-forest">
            Rating
            <input value={rating} onChange={(event) => setRating(event.target.value)} inputMode="decimal" className={`${inputBox} text-lg`} />
          </label>
          {errorFor("rating") && (
            <span role="alert" className="text-sm text-oxblood">
              {errorFor("rating")}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1 text-forest">
            Slope
            <input value={slope} onChange={(event) => setSlope(event.target.value)} inputMode="numeric" className={`${inputBox} text-lg`} />
          </label>
          {errorFor("slope") && (
            <span role="alert" className="text-sm text-oxblood">
              {errorFor("slope")}
            </span>
          )}
        </div>

        {/* rating/slope are optional as a pair (unrated-courses arc) — leaving both blank keeps
            (or makes) this tee unrated; the card's other tees are untouched either way. */}
        <p className="text-sm text-fairway">No course rating on the card? Leave these blank.</p>

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
          <p role="alert" className="text-oxblood">
            {generalError}
          </p>
        )}

        <button type="submit" disabled={!canSubmit || submitting} className={`${btnPrimary} disabled:opacity-50`}>
          Save changes
        </button>
      </form>
    </main>
  );
}
