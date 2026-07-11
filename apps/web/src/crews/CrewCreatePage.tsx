import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router";
import { createCrew } from "../api";
import { useAuth } from "../auth/useAuth";

// name → POST /crews → the new crew's page (brief). Crews are golfer-gated end to end
// (routes.ts's crew table), so unlike round creation there is no anonymous arm at all —
// signed out gets a prompt, not a form that would 401 at submit.
export function CrewCreatePage() {
  const navigate = useNavigate();
  const auth = useAuth();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  if (!auth.signedIn) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 bg-slate-950 p-6 text-slate-100">
        <h1 className="text-2xl font-bold">New crew</h1>
        <p className="text-slate-400">Sign in to create a crew.</p>
      </main>
    );
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setError(undefined);
    try {
      const response = await auth.withAuth((token) => createCrew(token, { name: trimmed }));
      navigate(`/crews/${response.crew.crewId}`);
    } catch {
      // Never the raw caught.message (the M7 never-raw-server-text discipline) — a
      // golfer-required 400 names the caller's raw sub, nothing a golfer can act on.
      setError("Could not create the crew — try again.");
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-slate-950 p-6 text-slate-100">
      <h1 className="text-2xl font-bold">New crew</h1>
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          Crew name
          <input value={name} onChange={(event) => setName(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg" />
        </label>

        {error && (
          <p role="alert" className="text-red-400">
            {error}
          </p>
        )}

        <button type="submit" disabled={submitting} className="rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold disabled:opacity-50">
          Create crew
        </button>
      </form>
    </main>
  );
}
