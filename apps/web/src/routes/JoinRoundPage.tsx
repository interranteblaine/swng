import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router";
import { ApiError, joinRound, peekRound } from "../api";
import { credentialStore } from "../identity";

// >=250ms, same debounce window as CourseSearch's own — long enough that a fast typist never
// fires one request per keystroke.
const DEBOUNCE_MS = 250;

export function JoinRoundPage() {
  const navigate = useNavigate();
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
    if (upperCode.length !== 6 || !name.trim() || !tee.trim() || !Number.isInteger(parsedHandicap)) return;

    setSubmitting(true);
    setError(undefined);
    try {
      const response = await joinRound({ code: upperCode, name: name.trim(), tee: tee.trim(), courseHandicap: parsedHandicap });
      // JoinRoundResponse carries no joinCode (only StartRoundResponse does) — the code the
      // golfer just typed IS the round's join code, so that's what's saved.
      credentialStore.save(response.roundId, { token: response.token, golferId: response.golferId, name: name.trim(), joinCode: upperCode });
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

        <label className="flex flex-col gap-1">
          Your name
          <input value={name} onChange={(event) => setName(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg" />
        </label>

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

        <button type="submit" disabled={submitting} className="rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold disabled:opacity-50">
          Join round
        </button>
      </form>
    </main>
  );
}
