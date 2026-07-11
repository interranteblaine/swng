import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import type { ListMyCrewsResponse } from "@swng/contracts";
import { ApiError, joinCrew, listMyCrews } from "../api";
import { useAuth } from "../auth/useAuth";
import { credentialStore } from "../identity";

// Reads localStorage directly on render rather than through useRoundSession/state — Home
// never opens a live session (that's per-round, from RoundPage), it only needs the flat list
// of rounds this device already holds a credential for.
export function HomePage() {
  const rounds = credentialStore.list();
  const { withAuth, signedIn } = useAuth();
  const navigate = useNavigate();

  // undefined = signed out / not loaded (yet or failed) — the list renders only from a real
  // response. The fetch is a nicety: a transient failure just leaves the section's list empty
  // rather than blocking the "New crew"/"Join a crew" affordances that need no data at all.
  const [crews, setCrews] = useState<ListMyCrewsResponse["crews"] | undefined>(undefined);
  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | undefined>(undefined);
  // golfer-required is its own arm, not folded into joinError (M8 close-out fix #2): this
  // form collects no name, so "try again" is a dead end — the honest fix is a link to /profile.
  const [joinGolferRequired, setJoinGolferRequired] = useState(false);

  useEffect(() => {
    if (!signedIn) {
      setCrews(undefined);
      return;
    }
    void withAuth((token) => listMyCrews(token))
      .then((response) => setCrews(response.crews))
      .catch(() => {}); // degrade silently — see the state's own comment
  }, [signedIn, withAuth]);

  // joinCrewRequestSchema expects the canonical uppercase 6-char form — uppercase here so a
  // golfer typing lowercase never hits a validation error on something this trivial to fix
  // (JoinRoundPage's own code-input precedent).
  const upperCode = joinCode.trim().toUpperCase();

  const submitJoin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (upperCode.length !== 6 || joining) return;

    setJoining(true);
    setJoinError(undefined);
    setJoinGolferRequired(false);
    try {
      const response = await withAuth((token) => joinCrew(token, { code: upperCode }));
      navigate(`/crews/${response.crew.crewId}`);
    } catch (caught) {
      // Humanized 404 copy, never the raw server text (the M7 discipline — the raw message
      // echoes the typed code back in server vocabulary, not something a golfer acts on).
      // golfer-required gets its own honest arm below instead of the generic retry: this form
      // collects no name, so retrying can never fix it — only a profile visit can.
      if (caught instanceof ApiError && caught.code === "golfer-required") {
        setJoinGolferRequired(true);
      } else {
        setJoinError(
          caught instanceof ApiError && caught.code === "unknown-crew"
            ? "No crew found with that code — check it with whoever shared it."
            : "Could not join the crew — try again.",
        );
      }
      setJoining(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-8 bg-slate-950 p-6 text-slate-100">
      <h1 className="text-3xl font-bold">swng</h1>

      <nav className="flex flex-col gap-3">
        <Link to="/create" className="rounded-lg bg-emerald-600 px-4 py-4 text-center text-lg font-semibold">
          Start a round
        </Link>
        <Link to="/join" className="rounded-lg bg-slate-800 px-4 py-4 text-center text-lg font-semibold">
          Join by code
        </Link>
      </nav>

      {signedIn && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-slate-300">Your crews</h2>
          {crews && crews.length > 0 && (
            <ul className="flex flex-col gap-2">
              {crews.map((crew) => (
                <li key={crew.crewId}>
                  <Link to={`/crews/${crew.crewId}`} className="flex items-center justify-between rounded-lg bg-slate-800 px-4 py-3">
                    <span>{crew.name}</span>
                    <span className="text-sm text-slate-400">
                      {crew.memberCount} member{crew.memberCount === 1 ? "" : "s"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <Link to="/crews/new" className="self-start text-emerald-400 underline">
            New crew
          </Link>

          <form onSubmit={(event) => void submitJoin(event)} className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              Crew code
              <input
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value)}
                maxLength={6}
                className="rounded-lg bg-slate-800 p-3 text-lg uppercase tracking-widest"
              />
            </label>
            {joinGolferRequired && (
              <p role="alert" className="text-red-400">
                Set your name on your profile before joining a crew.{" "}
                <Link to="/profile" className="underline">
                  Go to profile
                </Link>
              </p>
            )}
            {joinError && (
              <p role="alert" className="text-red-400">
                {joinError}
              </p>
            )}
            <button type="submit" disabled={joining} className="self-start rounded-lg bg-slate-800 px-4 py-3 font-semibold disabled:opacity-50">
              Join crew
            </button>
          </form>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-slate-300">Your rounds</h2>
        {rounds.length === 0 ? (
          <p className="text-slate-400">No rounds yet</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rounds.map((round) => (
              <li key={round.roundId}>
                <Link to={`/round/${round.roundId}`} className="block rounded-lg bg-slate-800 px-4 py-3">
                  {round.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
