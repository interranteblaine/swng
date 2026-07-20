import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { foldAndScore } from "@swng/client";
import { roundId as makeRoundId } from "@swng/domain";
import type { GameState, RoundEvent, RoundId, RoundState } from "@swng/domain";
import { getMyLiveRounds, getRoundArchive } from "../api";
import { SignInCta } from "../auth/SignInCta";
import { useAuth } from "../auth/useAuth";
import { roundLabel } from "../roundLabel";
import { openLiveRound } from "../session/openLiveRound";
import { usePageTitle } from "../ui/usePageTitle";
import { ResultsView } from "./ResultsView";

// The genesis event's own wallMs, searched from the raw log — the round's created-at, which the
// canonical designation (accounts-only identity spec §5) renders the round by everywhere. The
// SAME "search the log, never re-derive" discipline the server-side projector applies, mirrored
// here rather than imported (the web app may only import client/contracts/domain — layer law,
// eslint.config.mjs); RoundState itself carries no created timestamp, so it is derived from the
// round-created event on hand (spec §5's own "derive it in the web layer" resolution).
const createdAtMsOf = (events: readonly RoundEvent[]): number | undefined => events.find((event) => event.kind === "round-created")?.hlc.wallMs;

interface ArchiveView {
  readonly state: RoundState;
  readonly games: readonly GameState[];
  readonly createdAtMs: number | undefined;
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
  // Re-runs once the archive loads (usePageTitle's own title-prop-change contract) — "swng"
  // while loading/resolving, then the same course + date designation the page's own header
  // renders below.
  usePageTitle(view ? roundLabel({ courseName: view.state.card.courseName, createdAt: view.createdAtMs }) : undefined);

  useEffect(() => {
    if (!param || !signedIn) return;
    const id: RoundId = makeRoundId(param);
    setView(undefined);
    setUnavailable(false);

    void withAuth((token) => getRoundArchive(token, id))
      .then(({ events }) => {
        const { state, games } = foldAndScore(events);
        setView({ state, games, createdAtMs: createdAtMsOf(events) });
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
            if (rounds.some((round) => round.roundId === id)) {
              await openLiveRound(id, { withAuth, golferName: golfer?.name ?? "", navigate });
              return;
            }
          } catch {
            // falls through to the fallback below
          }
          setUnavailable(true);
        })();
      });
  }, [param, signedIn, withAuth, golfer, navigate]);

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

  return (
    <main className="min-h-screen bg-cream">
      <div className="p-4">
        {/* The canonical designation (spec §5): course + date, rendered the one way it is on the
            home list and the join link. */}
        <p className="font-serif text-sm text-fairway">{roundLabel({ courseName: view.state.card.courseName, createdAt: view.createdAtMs })}</p>
      </div>
      {/* No shareToken: this page's viewer holds only their own golfer Bearer — never a
          round-scoped participant token to mint a NEW share link with (same reasoning as
          WatchPage's own reuse of ResultsView, WatchPage.tsx's doc comment). */}
      <ResultsView state={view.state} games={view.games} response={undefined} />
    </main>
  );
}
