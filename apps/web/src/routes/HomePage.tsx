import { useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { Link, useNavigate } from "react-router";
import type { GetMyLiveRoundsResponse } from "@swng/contracts";
import type { RoundId } from "@swng/domain";
import { ApiError, getMyLiveRounds, mintParticipantToken } from "../api";
import { SignInCta } from "../auth/SignInCta";
import { useAuth } from "../auth/useAuth";
import { credentialStore } from "../identity";
import { roundDayKey, roundLabel } from "../roundLabel";

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
  // Same isIdentityLoading idiom CreateRoundPage/JoinRoundPage already use:
  // `golfer` stays undefined ONLY while signed in and the initial (or a later) GET /me hasn't
  // resolved yet — signed-out also reports golfer===undefined, but useAuth.ts's own `signedIn`
  // disambiguates the two. Fix for the review finding: `hasGolferIdentity` alone can't tell
  // "auth still resolving" from "signed out," so a signed-in golfer used to see the device
  // credential list (or "No rounds yet") flash for the whole GET /me round trip before the
  // identity list replaced it — the M8 three-state bug shape (CLAUDE.md's M8 note), here.
  const isIdentityLoading = signedIn && golfer === undefined;

  // undefined = not loaded yet (or signed out / no golfer) — the section renders its own
  // loading/empty copy only once this has a real array.
  const [liveRounds, setLiveRounds] = useState<GetMyLiveRoundsResponse["rounds"] | undefined>(undefined);

  useEffect(() => {
    if (!hasGolferIdentity) {
      setLiveRounds(undefined);
      return;
    }
    void withAuth((token) => getMyLiveRounds(token))
      .then((response) => setLiveRounds(response.rounds))
      .catch(() => {}); // degrade silently — a transient failure just leaves the list empty
  }, [hasGolferIdentity, withAuth]);

  // Task 14: a round found by identity may have no local device credential at all — started
  // or joined from a different device/browser. `enteringRoundId` gates a double-tap while the
  // re-mint is in flight; `enterError` is the ONE alert this section shows (never raw server
  // text — the M9 papercut discipline). `finishedRoundId` tracks a 409 round-final error so
  // we can show an archive link instead of a dead-end retry.
  const [enteringRoundId, setEnteringRoundId] = useState<RoundId | undefined>(undefined);
  const [enterError, setEnterError] = useState<string | undefined>(undefined);
  const [finishedRoundId, setFinishedRoundId] = useState<RoundId | undefined>(undefined);

  // Scoring capability derives from PARTICIPATION, not the device that joined (this task's own
  // headline): mint a fresh participant token for THIS device and store it exactly as a join
  // would (credentialStore.save, the SAME shape JoinRoundPage's own submit uses), then enter.
  // `joinCode: ""` — the mint response carries no join code (JoinRoundResponse's own shape),
  // same "no code known" precedent WatchPage/ArchivedRoundPage already established for a
  // credential minted outside the join flow (nothing downstream needs the code here — this
  // device is entering a round its own account golfer already sits in).
  const enterLiveRound = async (id: RoundId) => {
    if (enteringRoundId) return; // a re-mint is already in flight — no double-tap
    setEnterError(undefined);
    setFinishedRoundId(undefined);
    setEnteringRoundId(id);
    try {
      const response = await withAuth((token) => mintParticipantToken(token, id));
      credentialStore.save(response.roundId, { token: response.token, golferId: response.golferId, name: golfer!.name, joinCode: "" });
      navigate(`/round/${response.roundId}`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "round-final") {
        setEnterError("This round has finished.");
        setFinishedRoundId(id);
        // Remove the stale presence entry from liveRounds — the server's projector will delete it;
        // dropping it now matches reality and avoids a dead-end retry row.
        setLiveRounds((prevRounds) => (prevRounds ? prevRounds.filter((r) => r.roundId !== id) : prevRounds));
      } else if (caught instanceof ApiError && caught.code === "not-a-participant") {
        setEnterError("You're not in this round.");
      } else {
        setEnterError("Could not open that round — try again.");
      }
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

  // The canonical designation (spec §5): each live round renders as course + date, with the tee
  // time appended ONLY to tell apart two rounds that share course and day (the "two
  // indistinguishable Walker rounds" bug). Collisions are computed across exactly the rounds this
  // list is rendering, by the shared roundDayKey.
  const dayKeyCounts = new Map<string, number>();
  for (const round of liveRounds ?? []) {
    const key = roundDayKey({ courseName: round.courseName, createdAt: round.createdAt });
    if (key !== undefined) dayKeyCounts.set(key, (dayKeyCounts.get(key) ?? 0) + 1);
  }
  const collidesOnDay = (round: GetMyLiveRoundsResponse["rounds"][number]): boolean => {
    const key = roundDayKey({ courseName: round.courseName, createdAt: round.createdAt });
    return key !== undefined && (dayKeyCounts.get(key) ?? 0) > 1;
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-8 bg-slate-950 p-6 text-slate-100">
      <h1 className="text-3xl font-bold">swng</h1>

      {/* The wall (accounts-only identity spec §3): there is no anonymous "start a round" path.
          Signed out, that action is a sign-in CTA; join-by-code still routes into the funnel
          (which gates its own sign-in), and a shared watch link is the only other way in. */}
      <nav className="flex flex-col gap-3">
        {signedIn ? (
          <Link to="/create" className="rounded-lg bg-emerald-600 px-4 py-4 text-center text-lg font-semibold">
            Start a round
          </Link>
        ) : (
          <SignInCta message="Sign in to start a round." returnTo="/create" />
        )}
        <Link to="/join" className="rounded-lg bg-slate-800 px-4 py-4 text-center text-lg font-semibold">
          Join by code
        </Link>
      </nav>

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
          <>
            {enterError && (
              <div role="alert" className="text-red-400">
                <p>{enterError}</p>
                {finishedRoundId && (
                  <p>
                    <Link to={`/rounds/${finishedRoundId}/archive`} className="underline">
                      View archived round
                    </Link>
                  </p>
                )}
              </div>
            )}
            {!liveRounds || liveRounds.length === 0 ? (
              <p className="text-slate-400">No rounds yet</p>
            ) : (
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
                      {roundLabel({ courseName: round.courseName, createdAt: round.createdAt }, { withTime: collidesOnDay(round) })}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </>
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
