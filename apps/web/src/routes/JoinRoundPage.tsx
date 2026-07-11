import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import type { JoinRoundResponse } from "@swng/contracts";
import { ApiError, joinRound, peekRound, updateMe } from "../api";
import { useAuth } from "../auth/useAuth";
import { credentialStore } from "../identity";

// >=250ms, same debounce window as CourseSearch's own — long enough that a fast typist never
// fires one request per keystroke.
const DEBOUNCE_MS = 250;

export function JoinRoundPage() {
  const navigate = useNavigate();
  const auth = useAuth();
  // Same three-state story as CreateRoundPage's own (M8 Task 5): undefined-while-signed-in is
  // the GET /me loading window (isIdentityLoading) — the free-text field must NEVER render
  // there, since typing into it and submitting would fire PUT /me with the typed text over a
  // profile that may already be real once the fetch lands (a silent rename). null is
  // signed-in-with-no-profile-yet (free text, same as signed out, until PUT /me mints one at
  // submit time below). A real GolferView is asSelf.
  const isIdentityLoading = auth.signedIn && auth.golfer === undefined;
  const asSelf = auth.signedIn && Boolean(auth.golfer);

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [tee, setTee] = useState("");
  const [courseHandicap, setCourseHandicap] = useState("0");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const [courseName, setCourseName] = useState<string | undefined>(undefined);
  const [teeOptions, setTeeOptions] = useState<readonly string[] | undefined>(undefined);
  // Only ever true after a peek actually rejected — gates the fallback NOTE (not the fallback
  // input itself, which is simply whatever renders whenever teeOptions is absent).
  const [peekFailed, setPeekFailed] = useState(false);

  // joinRoundRequestSchema expects the canonical uppercase 6-char form — uppercase here so a
  // golfer typing lowercase never hits a validation error on something this trivial to fix.
  const upperCode = code.trim().toUpperCase();

  useEffect(() => {
    setCourseName(undefined);
    setTeeOptions(undefined);
    setPeekFailed(false);
    if (upperCode.length !== 6) return undefined; // peek only once the code looks complete

    const timer = setTimeout(() => {
      peekRound(upperCode)
        .then((response) => {
          setCourseName(response.courseName);
          setTeeOptions(response.teeSets.map((t) => t.name));
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

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedHandicap = Number.parseInt(courseHandicap, 10);
    // Playing as yourself always has a name (auth.golfer.name) — only the free-text path needs
    // one typed. isIdentityLoading blocks submission outright — the button is already disabled
    // during this window, but this guard covers any other way the form could submit (e.g. Enter
    // in a text field).
    if (upperCode.length !== 6 || !tee.trim() || !Number.isInteger(parsedHandicap) || isIdentityLoading || (!asSelf && !name.trim())) return;

    setSubmitting(true);
    setError(undefined);
    try {
      let response: JoinRoundResponse;
      let savedName: string;
      if (asSelf) {
        // Playing as an existing account golfer: golferId + Bearer ride along, the joined
        // name is the account's own name.
        const golfer = auth.golfer!;
        savedName = golfer.name;
        response = await auth.withAuth((token) =>
          joinRound({ code: upperCode, name: golfer.name, tee: tee.trim(), courseHandicap: parsedHandicap, golferId: golfer.golferId }, token),
        );
      } else if (auth.signedIn) {
        // Signed in with NO golfer yet: the typed name first creates the account's golfer (PUT
        // /me), THEN the round is joined as-self with the golferId that mints — strictly in
        // this order (assert-call-order — CreateRoundPage's own headline behavior, mirrored
        // here for join).
        const trimmed = name.trim();
        savedName = trimmed;
        response = await auth.withAuth(async (token) => {
          const created = await updateMe(token, { name: trimmed });
          return joinRound({ code: upperCode, name: trimmed, tee: tee.trim(), courseHandicap: parsedHandicap, golferId: created.golfer.golferId }, token);
        });
        // W1 (controller flow-walk finding, post-gate): PUT /me above just minted this
        // account's golfer, but the auth context's own `golfer` field doesn't update itself —
        // without this refetch, `auth.golfer` stays null until a full reload, so the round
        // page's own roster row for this golfer (ClaimAffordance's own-row check) would render
        // "This is me" instead of "You". Same refetch seam ClaimAffordance's own claim success
        // already uses — never a parallel one.
        await auth.refetch();
      } else {
        // Signed out: byte-identical to before this milestone — no golferId, no Bearer.
        const trimmed = name.trim();
        savedName = trimmed;
        response = await joinRound({ code: upperCode, name: trimmed, tee: tee.trim(), courseHandicap: parsedHandicap });
      }
      // JoinRoundResponse carries no joinCode (only StartRoundResponse does) — the code the
      // golfer just typed IS the round's join code, so that's what's saved.
      credentialStore.save(response.roundId, { token: response.token, golferId: response.golferId, name: savedName, joinCode: upperCode });
      navigate(`/round/${response.roundId}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not join the round — try again.");
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-slate-950 p-6 text-slate-100">
      <h1 className="text-2xl font-bold">Join by code</h1>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          Code
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            maxLength={6}
            className="rounded-lg bg-slate-800 p-3 text-lg uppercase tracking-widest"
          />
        </label>

        {courseName && <p className="text-sm text-slate-400">Joining {courseName}</p>}

        {isIdentityLoading ? (
          // A quiet placeholder, not the free-text field — see isIdentityLoading's own comment
          // above for why the input must not appear here. Deliberately NOT "Playing as" (that
          // label is reserved for the asSelf branch below, once a real name is known).
          <div role="status" aria-label="Loading your profile" className="flex flex-col gap-1">
            <div className="rounded-lg bg-slate-800 p-3 text-lg text-slate-500">Loading your profile…</div>
          </div>
        ) : asSelf ? (
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

        {teeOptions ? (
          <label className="flex flex-col gap-1">
            Tee
            <select value={tee} onChange={(event) => setTee(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg">
              {teeOptions.map((teeName) => (
                <option key={teeName} value={teeName}>
                  {teeName}
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

        <button
          type="submit"
          disabled={submitting || isIdentityLoading}
          className="rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold disabled:opacity-50"
        >
          Join round
        </button>
      </form>
    </main>
  );
}
