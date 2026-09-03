import { useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { Link, useNavigate } from "react-router";
import type { GetMyLiveRoundsResponse, GetMyRoundsResponse } from "@swng/contracts";
import type { RoundId } from "@swng/domain";
import { ApiError, getMyLiveRounds, getMyRounds } from "../api";
import { SignInCta } from "../auth/SignInCta";
import { useAuth } from "../auth/useAuth";
import { HistoryList } from "../golfers/RecordSections";
import { credentialStore } from "../identity";
import { dayCollisionChecker, roundLabel } from "@swng/domain";
import { openLiveRound } from "../session/openLiveRound";
import { btnCreamOutline, btnPrimary, btnSecondary, cardBox, eyebrow, inputCode } from "../ui/classes";
import { usePageTitle } from "../ui/usePageTitle";

export function HomePage() {
  usePageTitle();
  const { withAuth, signedIn, golfer, signIn } = useAuth();
  const navigate = useNavigate();
  // The door's own code input (brand reskin spec §3) — the ONLY new state this task adds;
  // useAuth gains no new surface. Lives above the early signed-out return so hook order stays
  // fixed across the signed-in/signed-out branch (same reason every other piece of state here
  // is declared before any conditional return).
  const [doorCode, setDoorCode] = useState("");

  // A real account golfer (not undefined = signed out, not null = signed in but no golfer row
  // yet — useAuth.ts's own three-state doc comment) is the ONE condition for the identity-based
  // "Your rounds" list; every other state shows the sign-in CTA instead (spec §5's own binding
  // resolution — papercut 10 deletes the pre-wall device-credential round list entirely).
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
  // A failed read is NOT an empty list (2026-09-03 ticket). This used to `.catch(() => {})`, which
  // left `liveRounds` undefined and rendered "No rounds yet" — a claim about an answer the server
  // never gave. To a golfer whose round is live that reads exactly like the round disappearing,
  // which is the ticket this arc exists to answer; getting there via a dropped fetch instead of a
  // deleted pointer makes it no less wrong. The two states are distinguishable, so they must read
  // differently.
  const [liveRoundsFailed, setLiveRoundsFailed] = useState(false);

  useEffect(() => {
    if (!hasGolferIdentity) {
      setLiveRounds(undefined);
      setLiveRoundsFailed(false);
      return;
    }
    setLiveRoundsFailed(false);
    void withAuth((token) => getMyLiveRounds(token))
      .then((response) => {
        setLiveRounds(response.rounds);
        setLiveRoundsFailed(false);
      })
      .catch(() => setLiveRoundsFailed(true));
  }, [hasGolferIdentity, withAuth]);

  // Navigation Task 5 (spec §4b): home becomes the switchboard — "Recent rounds" is the latest 3
  // of GET /me/rounds, rendered by the SAME history-row component ProfilePage/GolferPage use
  // (RecordSections' extracted `HistoryList`), never a second vs-par/score composition here.
  const [recentRounds, setRecentRounds] = useState<GetMyRoundsResponse["rounds"] | undefined>(undefined);

  useEffect(() => {
    if (!hasGolferIdentity) {
      setRecentRounds(undefined);
      return;
    }
    void withAuth((token) => getMyRounds(token))
      .then((response) => setRecentRounds(response.rounds))
      .catch(() => {}); // degrade silently — same precedent as liveRounds above
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
  // would, then enter — navigation Task 5 extracted the mint+store+navigate body to the shared
  // `openLiveRound` (RoundRecordPage's own live-check branch, spec §7 step 2, is the second
  // caller). The catch below (ApiError branching into human copy) stays here — it's this
  // section's own UI, not part of the re-mint itself.
  const enterLiveRound = async (id: RoundId) => {
    if (enteringRoundId) return; // a re-mint is already in flight — no double-tap
    setEnterError(undefined);
    setFinishedRoundId(undefined);
    setEnteringRoundId(id);
    try {
      await openLiveRound(id, { withAuth, golferName: golfer!.name, navigate });
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

  // The canonical designation (spec §5): course + date, tee time appended only to disambiguate two
  // rounds that share course and day, computed across exactly the rounds this list renders — the
  // ONE shared dayCollisionChecker (spec 2026-07-22 §4).
  const collidesOnDay = dayCollisionChecker(liveRounds ?? []);

  // Brand reskin spec §3: signed out, `/` IS the landing page — no app header (Layout suppresses
  // it), no "Your rounds" section (a heading whose only content is a locked-feature sign-in box
  // just enumerates a locked feature), exactly one sign-in affordance. `doorCode` pre-fills the
  // join funnel, which keeps ALL of its own logic (sign-in gating, peek, tee picker) — the door
  // just navigates there with the trimmed code.
  if (!signedIn) {
    return (
      <main className="flex min-h-screen flex-col bg-cream">
        <section className="flex flex-1 flex-col gap-4 p-7 pt-11">
          <h1 className="text-3xl font-extrabold tracking-tight text-forest text-balance">
            swng is the app for the golf you actually play.
          </h1>
          <p className="font-serif text-lg text-fairway">Fair matches, layered games, a record that lasts.</p>
          <button type="button" onClick={() => signIn()} className={`${btnPrimary} mt-3`}>
            Sign in
          </button>
          <p className="font-serif text-sm text-fairway">New here? Signing in creates your account.</p>
        </section>
        <section className="flex flex-col gap-2.5 bg-forest p-7">
          <h2 className="text-xl font-bold text-cream">Playing today?</h2>
          <p className="font-serif text-sm text-cream/70">Join a round with the code from your group.</p>
          <form
            className="mt-2 flex gap-2.5"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = doorCode.trim();
              navigate(trimmed ? `/join?code=${encodeURIComponent(trimmed)}` : "/join");
            }}
          >
            <input
              aria-label="Round code"
              placeholder="ROUND CODE"
              value={doorCode}
              onChange={(event) => setDoorCode(event.target.value)}
              className={`${inputCode} min-w-0 flex-1`}
            />
            <button type="submit" className={btnCreamOutline}>
              Join
            </button>
          </form>
          <p className="mt-4 font-mono text-[11px] text-cream/45">swng &copy; 2026</p>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-8 bg-cream p-6">
      {/* The wall (accounts-only identity spec §3): there is no anonymous "start a round" path
          — the signed-out door (above) is the whole sign-in-first funnel now, so this branch
          only ever renders signed in. */}
      <nav className="flex flex-col gap-3">
        <Link to="/create" className={btnPrimary}>
          Start a round
        </Link>
        <Link to="/join" className={btnSecondary}>
          Join by code
        </Link>
      </nav>

      <section className="flex flex-col gap-2">
        <h2 className={eyebrow}>Your rounds</h2>
        {isIdentityLoading ? (
          // A quiet placeholder — NEVER the device list and never "No rounds yet" (both are
          // claims about data this render doesn't have yet). Same role/label idiom as
          // CreateRoundPage/JoinRoundPage's own "Loading your profile" placeholder.
          <div role="status" aria-label="Loading your rounds" className={`${cardBox} p-3 text-fairway`}>
            Loading your rounds…
          </div>
        ) : hasGolferIdentity ? (
          <>
            {enterError && (
              <div role="alert" className="text-oxblood">
                <p>{enterError}</p>
                {finishedRoundId && (
                  <p>
                    <Link to={`/rounds/${finishedRoundId}`} className="underline">
                      View archived round
                    </Link>
                  </p>
                )}
              </div>
            )}
            {liveRoundsFailed ? (
              // Says what is true — the read failed — and deliberately does NOT claim the list is
              // empty. The join code still works from here (it is an idempotent way back into any
              // round you are seated in), so the door out of this state is already on the page.
              <p role="status" aria-label="Your rounds could not be loaded" className="text-fairway">
                Your rounds could not be loaded. Check your connection, or use the code from your group to rejoin.
              </p>
            ) : !liveRounds || liveRounds.length === 0 ? (
              <p className="text-fairway">No rounds yet</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {liveRounds.map((round) => {
                  const label = roundLabel({ courseName: round.courseName, playedAt: round.playedAt }, { withTime: collidesOnDay(round) });
                  // The date/time segment is the label MINUS the course-name prefix and its one
                  // separating space, so the bullet stays on the date span — getByRole's own
                  // accessible-name computation re-inserts exactly one space between block
                  // siblings, reproducing roundLabel's own "Course · Date" string byte-for-byte
                  // (verified: two block children "Course" + "· Date" name as "Course · Date").
                  const dateLine = label.length > round.courseName.length ? label.slice(round.courseName.length + 1) : undefined;
                  return (
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
                        className={`${cardBox} block border-l-[3px] border-l-fairway px-4 py-3`}
                      >
                        <span className="block font-serif text-forest">{round.courseName}</span>
                        {dateLine && <span className="block font-mono text-sm text-fairway">{dateLine}</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        ) : (
          // Papercut 10: post-wall (accounts-only identity), nothing writes new device
          // credentials, so the old device-list branch here could only ever surface pre-wall
          // relic localStorage tokens. Signed in with no golfer row yet — the dead-loading
          // window above already excludes the resolving case — the funnel is the one way onto
          // a card.
          <SignInCta message="Sign in to see your rounds." returnTo="/" />
        )}
      </section>

      {/* Navigation Task 5: the switchboard's second section — the latest 3 finalized rounds, via
          the SAME row rendering ProfilePage/GolferPage use (RecordSections' extracted
          HistoryList), plus a quiet pointer to the full record. Only shown once a real account
          golfer exists — the loading/no-identity states above already gate "Your rounds"; there's
          nothing distinct to add here for those windows. */}
      {hasGolferIdentity && (
        <section className="flex flex-col gap-2">
          <h2 className={eyebrow}>Recent rounds</h2>
          <HistoryList history={recentRounds ?? []} historyLimit={3} />
          <Link to="/profile" className="font-mono text-xs text-fairway underline decoration-fairway">
            all rounds → your profile
          </Link>
        </section>
      )}
    </main>
  );
}
