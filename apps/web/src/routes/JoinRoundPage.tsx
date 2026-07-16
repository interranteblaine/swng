import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { courseHandicapFromRatingSlopePar, effectiveIndex } from "@swng/domain";
import type { GetMyRecordResponse, PeekRoundResponse } from "@swng/contracts";
import { ApiError, getMyRecord, joinRound, peekRound, updateMe } from "../api";
import { SignInCta } from "../auth/SignInCta";
import { useAuth } from "../auth/useAuth";
import { teeNumbers } from "../courses/teeNumbers";
import { credentialStore } from "../identity";
import { roundLabel } from "../roundLabel";

// >=250ms, same debounce window as CourseSearch's own — long enough that a fast typist never
// fires one request per keystroke.
const DEBOUNCE_MS = 250;

// The peek's per-tee shape — carries `par` and `holes` (the hole count, 9 or 18) always, plus
// rating/slope (a rated tee only), which is exactly what the join-side strokes derivation needs:
// par + rating/slope for the rated conversion, `holes` to make the unrated estimate hole-count-
// correct (the frozen card's holes ARRAY isn't on the peek — only its count is).
type PeekTee = PeekRoundResponse["teeSets"][number];

export function JoinRoundPage() {
  const navigate = useNavigate();
  const auth = useAuth();
  // Destructured for a stable effect dep (withAuth is a useCallback — useAuth.ts).
  const { withAuth } = auth;
  const [searchParams] = useSearchParams();

  // The wall (accounts-only identity spec §3): joining is self-join only, from the caller's own
  // account. The old free-text `name` field and the anonymous/no-golfer join branches are gone.
  // The funnel is a straight line: signed out → sign-in CTA; signed in but identity still loading
  // → a quiet placeholder (the M8 defect class: a submit here once renamed a real profile with
  // stale text); a placeholder golfer → the one name prompt (§2); a real golfer → the join form.
  const isIdentityLoading = auth.signedIn && auth.golfer === undefined;
  // A golfer whose name is still the sub-derived backstop (or the transient no-row case) names
  // themselves before joining. `!auth.golfer` here is only reachable once identity has resolved
  // (isIdentityLoading is checked first), so it means the dead null case, not "still loading".
  // Everything else — signed in, resolved, real name — is the join form itself (the final else
  // of the render chain below).
  const needsName = auth.signedIn && !isIdentityLoading && (!auth.golfer || auth.golfer.namePlaceholder === true);

  // Seeded from the URL (a join link, or the funnel's own returnTo landing) so a code carried
  // across the sign-in round trip lands ready to join without retyping.
  const [code, setCode] = useState(() => (searchParams.get("code") ?? "").toUpperCase());
  const [tee, setTee] = useState("");
  const [courseHandicap, setCourseHandicap] = useState("0");
  // Seed-once flag (unrated-courses T5b): the strokes suggestion pre-fills the field only
  // while untouched — the moment the golfer types, their value wins forever.
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const [courseName, setCourseName] = useState<string | undefined>(undefined);
  // The round-created wall time from the peek — feeds roundLabel so the join-link framing carries
  // the SAME designation (course + date) as home/archive/watch (accounts-only identity spec §5).
  const [createdAt, setCreatedAt] = useState<number | undefined>(undefined);
  // The peek's full tee sets (name + par + rating/slope), not just names — the join-side strokes
  // suggestion (unrated-courses T5b) needs the selected tee's numbers, and the picker shows
  // each tee's rating/slope via teeNumbers.
  const [peekTees, setPeekTees] = useState<readonly PeekTee[] | undefined>(undefined);
  // The golfer's read-time metrics (GET /me/record) — the `computed` input to the suggestion; a
  // failed/absent fetch just falls back to the declared index alone, never blocking the page.
  const [record, setRecord] = useState<GetMyRecordResponse | undefined>(undefined);
  // Only ever true after a peek actually rejected — gates the fallback NOTE (not the fallback
  // input itself, which is simply whatever renders whenever peekTees is absent).
  const [peekFailed, setPeekFailed] = useState(false);

  // joinRoundRequestSchema expects the canonical uppercase 6-char form — uppercase here so a
  // golfer typing lowercase never hits a validation error on something this trivial to fix.
  const upperCode = code.trim().toUpperCase();

  useEffect(() => {
    setCourseName(undefined);
    setCreatedAt(undefined);
    setPeekTees(undefined);
    setPeekFailed(false);
    if (upperCode.length !== 6) return undefined; // peek only once the code looks complete

    const timer = setTimeout(() => {
      peekRound(upperCode)
        .then((response) => {
          setCourseName(response.courseName);
          setCreatedAt(response.createdAt);
          setPeekTees(response.teeSets);
          setTee(response.teeSets[0]?.name ?? "");
        })
        .catch(() => {
          // Peek is a nicety (course name + tee picker), never a gate: a bad/expired code is
          // still caught for real by joinRound itself at submit time, so a failed lookup here
          // just falls back to the free-text tee this page always had — joining must never be
          // blocked by this convenience (why-comment, brief).
          setPeekFailed(true);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [upperCode]);

  // The strokes suggestion's `computed` input (unrated-courses T5b): one GET /me/record
  // when signed in. A nicety — a rejection leaves `record` undefined and the suggestion (if any)
  // falls back to the declared index alone; it never blocks the page.
  useEffect(() => {
    if (!auth.signedIn) return;
    void withAuth((token) => getMyRecord(token))
      .then(setRecord)
      .catch(() => {}); // withAuth already handled a terminal 401; anything else just leaves the record unset
  }, [auth.signedIn, withAuth]);

  // "Strokes you get here" — the golfer's index turned into today's strokes, shown WITH its
  // derivation and editable (handicap-model legibility spec §4/§7). The active index (arc:
  // declared > computed) defaults to the swng index — the SAME "Your index" the profile shows
  // (spec §3), not the rated-only WHS index. The peek carries `par` + `holes` (not the holes
  // array): a rated tee uses courseHandicapFromRatingSlopePar (the numbers-only Rule 6.1a helper);
  // an unrated tee falls back to the index itself, hole-count-correct — round(index) on 18,
  // round(index / 2) on 9 (spec §4; the /2 is a UI presentation of the estimate, not the Rule
  // 6.1a formula). No effective index, or a free-text tee with no peek numbers → no derivation
  // note, so the field stays its plain "0".
  const effective = effectiveIndex({ declared: auth.golfer?.declared, computed: record?.metrics?.swngIndex?.value });
  const selectedTee = peekTees?.find((peekTee) => peekTee.name === tee);
  const suggestion = ((): { readonly value: number; readonly note: string } | undefined => {
    if (!effective || !selectedTee) return undefined;
    const indexText = effective.value.toFixed(1);
    if (selectedTee.rating !== undefined && selectedTee.slope !== undefined) {
      const value = courseHandicapFromRatingSlopePar(effective.value, selectedTee.rating, selectedTee.slope, selectedTee.par);
      return { value, note: `${value} — from your index (${indexText}) on this course` };
    }
    // Unrated: the strokes ≈ index estimate, halved for a 9-hole card (spec §3/§4).
    const value = selectedTee.holes === 9 ? Math.round(effective.value / 2) : Math.round(effective.value);
    return { value, note: `${value} — your index (${indexText}), adjusted for ${selectedTee.holes} holes; unrated course, adjust if it plays hard/easy` };
  })();
  const suggestedValue = suggestion?.value;

  // Seed the field (and re-seed on a tee change) only while untouched — a typed value is never
  // overwritten. Primitive dep, so recomputing the same number doesn't re-fire this.
  useEffect(() => {
    if (touched || suggestedValue === undefined) return;
    setCourseHandicap(String(suggestedValue));
  }, [touched, suggestedValue]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedHandicap = Number.parseInt(courseHandicap, 10);
    const golfer = auth.golfer;
    // Only ever reachable in the asSelf state (the form isn't rendered otherwise), but guarded
    // anyway: a real account golfer, a complete code, a tee and a valid handicap.
    if (upperCode.length !== 6 || !tee.trim() || !Number.isInteger(parsedHandicap) || !golfer || golfer.namePlaceholder === true) return;

    setSubmitting(true);
    setError(undefined);
    try {
      // Accounts-only identity (spec §3): join is always as-self, resolved server-side from the
      // Bearer — the request carries no name/golferId (the server freezes the account golfer's name
      // into the join event).
      const response = await auth.withAuth((token) =>
        joinRound({ code: upperCode, tee: tee.trim(), courseHandicap: parsedHandicap }, token),
      );
      // JoinRoundResponse carries no joinCode (only StartRoundResponse does) — the code the
      // golfer just typed IS the round's join code, so that's what's saved.
      credentialStore.save(response.roundId, { token: response.token, golferId: response.golferId, name: golfer.name, joinCode: upperCode });
      navigate(`/round/${response.roundId}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not join the round — try again.");
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-slate-950 p-6 text-slate-100">
      <h1 className="text-2xl font-bold">Join by code</h1>

      <label className="flex flex-col gap-1">
        Code
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          maxLength={6}
          className="rounded-lg bg-slate-800 p-3 text-lg uppercase tracking-widest"
        />
      </label>

      {courseName && <p className="text-sm text-slate-400">Joining {roundLabel({ courseName, createdAt })}</p>}

      {!auth.signedIn ? (
        // The join link IS the sign-up funnel (spec §3): signing in through the stock Hosted UI
        // is how a new player joins. The returnTo carries the code back so the round trip lands
        // ready to join.
        <SignInCta
          message="Sign in to join this round — new players create their account on the way."
          returnTo={upperCode.length === 6 ? `/join?code=${upperCode}` : "/join"}
        />
      ) : isIdentityLoading ? (
        // A quiet placeholder, not a form — a submit during this window is exactly the M8 defect
        // (a silent rename of a profile that hadn't loaded yet). Nothing here can be submitted.
        <div role="status" aria-label="Loading your profile" className="flex flex-col gap-1">
          <div className="rounded-lg bg-slate-800 p-3 text-lg text-slate-500">Loading your profile…</div>
        </div>
      ) : needsName ? (
        <NamePrompt />
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-sm text-slate-400">Playing as</span>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-800 p-3 text-lg">
              <span>{auth.golfer!.name}</span>
              <Link to="/profile" className="text-sm text-emerald-400 underline">
                Change
              </Link>
            </div>
          </div>

          {peekTees ? (
            <label className="flex flex-col gap-1">
              Tee
              <select value={tee} onChange={(event) => setTee(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg">
                {peekTees.map((peekTee) => (
                  <option key={peekTee.name} value={peekTee.name}>
                    {peekTee.name} — {teeNumbers(peekTee)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="flex flex-col gap-1">
              <label className="flex flex-col gap-1">
                Tee
                <input value={tee} onChange={(event) => setTee(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg" />
              </label>
              {/* Sibling of the <label>, not nested inside it — nesting would fold this note into
                  the label's own accessible name. */}
              {peekFailed && <span className="text-xs text-slate-500">Could not look up this course's tees — type yours from the card.</span>}
            </div>
          )}

          {/* The derivation note is a SIBLING of the <label> (not nested) — nesting would fold it
              into the label's own accessible name. The plain label ("Strokes you get here") plus
              the visible derivation is the legibility rule (spec §4/§7): the index turned into
              today's strokes, never a bare number and never a separate declaration. */}
          <div className="flex flex-col gap-1">
            <label className="flex flex-col gap-1">
              Strokes you get here
              <input
                type="number"
                step={1}
                value={courseHandicap}
                onChange={(event) => {
                  setTouched(true); // a typed value wins over the seed from here on
                  setCourseHandicap(event.target.value);
                }}
                className="rounded-lg bg-slate-800 p-3 text-lg"
              />
            </label>
            {suggestion && <span className="text-xs text-slate-500">{suggestion.note}</span>}
          </div>

          {error && (
            <p role="alert" className="text-red-400">
              {error}
            </p>
          )}

          <button type="submit" disabled={submitting} className="rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold disabled:opacity-50">
            Join round
          </button>
        </form>
      )}
    </main>
  );
}

// The funnel's one required field (accounts-only identity spec §2): a placeholder golfer names
// themselves at the highest-motivation moment — a PUT of the name, nothing more. Only ever
// mounted once identity has resolved (JoinRoundPage gates it behind isIdentityLoading), so it
// can never fire a rename over a still-loading profile. On success the refetch flips the golfer
// to real (namePlaceholder cleared), which re-renders the parent straight into the join form —
// same visit, no navigation hop (controller resolution 2).
function NamePrompt() {
  const auth = useAuth();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || saving) return;

    setSaving(true);
    setError(undefined);
    try {
      await auth.withAuth((token) => updateMe(token, { name: trimmed }));
      await auth.refetch(); // flips auth.golfer to the real name → the join form renders
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not save your name — try again.");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        What should the card call you?
        <input value={name} onChange={(event) => setName(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg" />
      </label>

      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}

      <button type="submit" disabled={saving || !name.trim()} className="rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold disabled:opacity-50">
        Continue
      </button>
    </form>
  );
}
