import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { foldAndScore } from "@swng/client";
import { roundId as makeRoundId } from "@swng/domain";
import type { GameState, RoundId, RoundState } from "@swng/domain";
import { getMyLiveRounds, getRoundArchive } from "../api";
import { SignInCta } from "../auth/SignInCta";
import { useAuth } from "../auth/useAuth";
import { roundLabel } from "@swng/domain";
import { openLiveRound } from "../session/openLiveRound";
import { usePageTitle } from "../ui/usePageTitle";
import { ResultsView } from "./ResultsView";

// No hand-rolled "search the log for the genesis event" helper here anymore (round-played-date
// spec 2026-08-01 §6): `RoundState.playedAtMs` already carries WHEN THE GOLF HAPPENED (domain's
// playedAtMsOf, called once by reduceRound inside foldAndScore below) — a second implementation
// of that same rule living in the web is exactly what playedAt.ts's own doc comment forbids (its
// two sanctioned callers are reduceRound and the projector, no third). `view.state.playedAtMs`
// below reads the fold's own answer instead.
interface ArchiveView {
  readonly state: RoundState;
  readonly games: readonly GameState[];
}

// GET /rounds/:roundId — the round's ONE permanent address (navigation spec §7): unlike the old
// ArchivedRoundPage this page absorbs and replaces, a round's own address doesn't encode its
// lifecycle state. Resolution, signed in, in spec §7's exact order:
//   1. GET /rounds/{roundId}/archive → 200: render the archived card (below) — today's
//      ArchivedRoundPage content, unchanged.
//   2. Any non-200 → check GET /me/rounds/live for this roundId: present → re-mint a device
//      credential (`openLiveRound`, the SAME re-mint HomePage's own live-rounds list uses) →
//      navigate to /round/:roundId (the live scoring session's own address, unchanged).
//   3. Otherwise: the honest fallback — a round that isn't live and didn't archive for this
//      caller (a stranger's round, an unknown id) reads the same either way; no new API is
//      worth minting just to tell them apart.
// Signed out: the SignInCta funnel, returnTo the current path — a texted round link becomes a
// sign-in funnel that lands right back here once it resolves.
export function RoundRecordPage() {
  const { roundId: param } = useParams<{ roundId: string }>();
  const { withAuth, signedIn, golfer } = useAuth();
  const navigate = useNavigate();
  const [view, setView] = useState<ArchiveView | undefined>(undefined);
  const [unavailable, setUnavailable] = useState(false);
  // `golfer` resolves asynchronously (AuthProvider's own once-per-session GET /me — undefined
  // until it settles) and is read ONLY inside the effect's re-mint branch below, never to decide
  // whether to fetch — the tokensRef precedent (useAuth.ts:78). A ref, not a dependency: the
  // effect below must not re-fire just because identity resolved after the archive already
  // loaded (the reviewed duplicate-fetch/loading-flash finding).
  const golferRef = useRef(golfer);
  golferRef.current = golfer;
  // Re-runs once the archive loads (usePageTitle's own title-prop-change contract) — "swng"
  // while loading/resolving, then the same course + date designation the page's own header
  // renders below.
  usePageTitle(view ? roundLabel({ courseName: view.state.card.courseName, playedAt: view.state.playedAtMs }) : undefined);

  useEffect(() => {
    if (!param || !signedIn) return;
    const id: RoundId = makeRoundId(param);
    // Stale-run guard: a second effect run (a real param/signedIn change) or an unmount
    // (navigate() below, or the caller navigating away) must not let THIS run's callbacks
    // setState afterward — every set* and the openLiveRound/navigate call below checks it first.
    let ignore = false;
    setView(undefined);
    setUnavailable(false);

    void withAuth((token) => getRoundArchive(token, id))
      .then(({ events }) => {
        if (ignore) return;
        const { state, games } = foldAndScore(events);
        setView({ state, games });
      })
      .catch(() => {
        // Spec §7 step 2: the archive read failed (never-finalized, still live, or a stranger's
        // round all look the same from here) — check the caller's OWN live rounds before giving
        // up. Found → re-mint + enter, exactly HomePage's own tap-to-enter does. A failure at
        // EITHER step (the live-rounds read itself, or the re-mint) falls through to the same
        // honest fallback as "not live at all" — there's nothing more specific to say.
        void (async () => {
          try {
            const { rounds } = await withAuth((token) => getMyLiveRounds(token));
            if (ignore) return;
            if (rounds.some((round) => round.roundId === id)) {
              await openLiveRound(id, { withAuth, golferName: golferRef.current?.name ?? "", navigate });
              return;
            }
          } catch {
            // falls through to the fallback below
          }
          if (ignore) return;
          setUnavailable(true);
        })();
      });

    return () => {
      ignore = true;
    };
  }, [param, signedIn, withAuth, navigate]);

  if (!param) {
    return (
      <div role="status" className="flex min-h-screen items-center justify-center bg-cream">
        This link looks incomplete.
      </div>
    );
  }

  if (!signedIn) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-cream p-6">
        <SignInCta message="Sign in to see this round." returnTo={`/rounds/${param}`} />
      </main>
    );
  }

  if (unavailable) {
    return (
      <div role="status" className="flex min-h-screen flex-col items-center justify-center gap-2 bg-cream p-6 text-center">
        <p className="text-forest">
          This round isn&apos;t available. If someone sent you a code,{" "}
          <Link to="/join" className="underline decoration-fairway">
            join here
          </Link>
        </p>
      </div>
    );
  }

  if (!view) {
    return (
      <div role="status" aria-label="Loading round" className="flex min-h-screen items-center justify-center bg-cream">
        Loading round…
      </div>
    );
  }

  // The link sweep (navigation spec, task 6): the heading splits into two halves — the course
  // name (linked to /courses/:courseId when the frozen card carries a source, plain text when
  // absent) and the date, which stays plain either way. `dateSuffix` is sliced off `label`
  // (never re-derived) so the exact date FORMATTING logic stays the one copy in roundLabel.ts —
  // `label` always starts with `courseName` verbatim by construction, so the slice is exact. The
  // plain branch renders `courseName` as a bare string (no wrapping element) so the existing
  // "the whole heading is one string" assertions keep working unchanged when there's no link to
  // split around.
  const courseName = view.state.card.courseName;
  const label = roundLabel({ courseName, playedAt: view.state.playedAtMs });
  const dateSuffix = label.slice(courseName.length);
  const courseLinkId = view.state.card.source?.courseId;

  return (
    <main className="min-h-screen bg-cream">
      <div className="p-4">
        {/* The canonical designation (spec §5): course + date, rendered the one way it is on the
            home list and the join link. */}
        <p className="font-serif text-sm text-fairway">
          {courseLinkId ? (
            <Link to={`/courses/${courseLinkId}`} className="underline decoration-fairway">
              {courseName}
            </Link>
          ) : (
            courseName
          )}
          {dateSuffix}
        </p>
      </div>
      {/* No shareToken: this page's viewer holds only their own golfer Bearer — never a
          round-scoped participant token to mint a NEW share link with (same reasoning as
          WatchPage's own reuse of ResultsView, WatchPage.tsx's doc comment). */}
      <ResultsView state={view.state} games={view.games} />
    </main>
  );
}
