import { useEffect, useState } from "react";
import type { FormEvent, MouseEvent } from "react";
import { Link, useNavigate } from "react-router";
import type { GetMyLiveRoundsResponse, ListMyCrewsResponse } from "@swng/contracts";
import type { RoundId } from "@swng/domain";
import { ApiError, getMyLiveRounds, joinCrew, listMyCrews, mintParticipantToken } from "../api";
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

  // Task 14: a round found by identity may have no local device credential at all — started
  // or joined from a different device/browser. `enteringRoundId` gates a double-tap while the
  // re-mint is in flight; `enterError` is the ONE alert this section shows (never raw server
  // text — the M9 papercut discipline).
  const [enteringRoundId, setEnteringRoundId] = useState<RoundId | undefined>(undefined);
  const [enterError, setEnterError] = useState<string | undefined>(undefined);

  // Scoring capability derives from PARTICIPATION, not the device that joined (this task's own
  // headline): mint a fresh participant token for THIS device and store it exactly as a join
  // would (credentialStore.save, the SAME shape JoinRoundPage's own submit uses), then enter.
  // `joinCode: ""` — the mint response carries no join code (JoinRoundResponse's own shape),
  // same "no code known" precedent WatchPage/ArchivedRoundPage already established for a
  // credential minted outside the join flow; ClaimAffordance's own empty-code guard already
  // treats "" as "no claim affordance here" (harmless — this device's own row already reads
  // as "You", never "This is me", since the caller IS this account's own golfer).
  const enterLiveRound = async (id: RoundId) => {
    if (enteringRoundId) return; // a re-mint is already in flight — no double-tap
    setEnterError(undefined);
    setEnteringRoundId(id);
    try {
      const response = await withAuth((token) => mintParticipantToken(token, id));
      credentialStore.save(response.roundId, { token: response.token, golferId: response.golferId, name: golfer!.name, joinCode: "" });
      navigate(`/round/${response.roundId}`);
    } catch (caught) {
      setEnterError(
        caught instanceof ApiError && caught.code === "not-a-participant" ? "You're not in this round." : "Could not open that round — try again.",
      );
      setEnteringRoundId(undefined);
    }
  };

  // A device that already holds a scoring credential for this round navigates exactly as
  // before this task — no network call at all. Only an ABSENT credential triggers the re-mint.
  const handleLiveRoundClick = (id: RoundId) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (credentialStore.load(id)) return;
    event.preventDefault();
    void enterLiveRound(id);
  };

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
            <>
              {enterError && (
                <p role="alert" className="text-red-400">
                  {enterError}
                </p>
              )}
              <ul className="flex flex-col gap-2">
                {liveRounds.map((round) => (
                  <li key={round.roundId}>
                    {/* Task 14: a round found by identity may have no local device credential
                        at all (started/joined from a different device or browser) —
                        handleLiveRoundClick re-mints one before navigating whenever this
                        device holds none; a device that already holds one navigates exactly
                        as a plain Link would, no network call. */}
                    <Link
                      to={`/round/${round.roundId}`}
                      onClick={handleLiveRoundClick(round.roundId)}
                      aria-busy={enteringRoundId === round.roundId}
                      className="block rounded-lg bg-slate-800 px-4 py-3"
                    >
                      {round.courseName}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
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
