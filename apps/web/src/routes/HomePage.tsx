import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import type { GetMyLiveRoundsResponse, ListMyCrewsResponse } from "@swng/contracts";
import { ApiError, getMyLiveRounds, joinCrew, listMyCrews } from "../api";
import { useAuth } from "../auth/useAuth";
import { credentialStore } from "../identity";

// Reads localStorage directly on render rather than through useRoundSession/state — Home
// never opens a live session (that's per-round, from RoundPage), it only needs the flat list
// of rounds this device already holds a credential for. This is now the ANONYMOUS/ghost path
// only (architecture-realignment Task 13, spec §5) — a signed-in golfer's "Your rounds"
// instead reads live rounds by IDENTITY (GET /me/rounds/live), below.
export function HomePage() {
  const rounds = credentialStore.list();
  const { withAuth, signedIn, golfer } = useAuth();
  const navigate = useNavigate();

  // A real account golfer (not undefined = signed out, not null = signed in but no golfer row
  // yet — useAuth.ts's own three-state doc comment) is the ONE condition for the identity-based
  // "Your rounds" list; every other state keeps the device credentialStore list exactly as
  // before this task (spec §5's own binding resolution).
  const hasGolferIdentity = Boolean(golfer);
  // Same isIdentityLoading idiom CreateRoundPage/JoinRoundPage/ClaimAffordance already use:
  // `golfer` stays undefined ONLY while signed in and the initial (or a later) GET /me hasn't
  // resolved yet — signed-out also reports golfer===undefined, but useAuth.ts's own `signedIn`
  // disambiguates the two. Fix for the review finding: `hasGolferIdentity` alone can't tell
  // "auth still resolving" from "signed out," so a signed-in golfer used to see the device
  // credential list (or "No rounds yet") flash for the whole GET /me round trip before the
  // identity list replaced it — the M8 three-state bug shape (CLAUDE.md's M8 note), here.
  const isIdentityLoading = signedIn && golfer === undefined;

  // undefined = not loaded yet (or signed out / no golfer) — the section renders its own
  // loading/empty copy only once this has a real array, same idiom as `crews` below.
  const [liveRounds, setLiveRounds] = useState<GetMyLiveRoundsResponse["rounds"] | undefined>(undefined);

  useEffect(() => {
    if (!hasGolferIdentity) {
      setLiveRounds(undefined);
      return;
    }
    void withAuth((token) => getMyLiveRounds(token))
      .then((response) => setLiveRounds(response.rounds))
      .catch(() => {}); // degrade silently — same discipline as the crews fetch below
  }, [hasGolferIdentity, withAuth]);

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
        {isIdentityLoading ? (
          // A quiet placeholder — NEVER the device list and never "No rounds yet" (both are
          // claims about data this render doesn't have yet). Same role/label idiom as
          // CreateRoundPage/JoinRoundPage's own "Loading your profile" placeholder.
          <div role="status" aria-label="Loading your rounds" className="rounded-lg bg-slate-800 p-3 text-slate-500">
            Loading your rounds…
          </div>
        ) : hasGolferIdentity ? (
          !liveRounds || liveRounds.length === 0 ? (
            <p className="text-slate-400">No rounds yet</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {liveRounds.map((round) => (
                <li key={round.roundId}>
                  {/* TODO(Task 14): a round found by identity may have no local device
                      credential at all (started/joined from a different device or browser) —
                      re-mint a scoring token here, before navigating, once that capability
                      exists. For now this link navigates unconditionally; RoundPage's existing
                      no-credential path (bounce to /join) covers the gap until then. */}
                  <Link to={`/round/${round.roundId}`} className="block rounded-lg bg-slate-800 px-4 py-3">
                    {round.courseName}
                  </Link>
                </li>
              ))}
            </ul>
          )
        ) : rounds.length === 0 ? (
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
