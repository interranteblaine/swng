import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router";
import { ApiError, joinRound } from "../api";
import { credentialStore } from "../identity";

export function JoinRoundPage() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [tee, setTee] = useState("");
  const [courseHandicap, setCourseHandicap] = useState("0");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedHandicap = Number.parseInt(courseHandicap, 10);
    // joinRoundRequestSchema expects the canonical uppercase 6-char form — uppercase here so
    // a golfer typing lowercase never hits a validation error on something this trivial to fix.
    const upperCode = code.trim().toUpperCase();
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

        <label className="flex flex-col gap-1">
          Your name
          <input value={name} onChange={(event) => setName(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg" />
        </label>

        <label className="flex flex-col gap-1">
          Tee
          <input value={tee} onChange={(event) => setTee(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg" />
        </label>

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
