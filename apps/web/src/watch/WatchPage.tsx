import { useState } from "react";
import { useLocation, useParams } from "react-router";
import { roundId as makeRoundId } from "@swng/domain";
import type { GameId, RoundId } from "@swng/domain";
import { roundLabel } from "../roundLabel";
import { ResultsView } from "../round/ResultsView";
import { ScorecardGrid } from "../round/ScorecardGrid";
import { StandingsHeader } from "../round/StandingsHeader";
import { useWatchRound as defaultUseWatchRound } from "./useWatchRound";
import type { WatchRoundView } from "./useWatchRound";

type UseWatchRound = (roundId: RoundId, token: string) => WatchRoundView;

// Everything that's only ever rendered pre-finalize, its own component for the same reason
// RoundPage's own LiveRound is one (chip-selection state shouldn't have to survive the
// live -> final swap). Deliberately NOT RoundPage's LiveRound reused wholesale: that component
// wires SetupPanel/FinalizeControl/recordScore — every one of those IS an edit
// affordance (add a game, finalize, score) — so this is its own, narrower
// composition of just the two READ-ONLY presentational pieces a spectator needs:
// StandingsHeader (no onTerminate — omitting it is what hides the "End game…" overflow, same
// contract ResultsView's own reuse of StandingsHeader already relies on) and ScorecardGrid in
// `readOnly` mode (every cell renders `disabled` — no tap ever opens ScorePad, so the two-tap
// score entry UI structurally never appears; ResultsView's own archived-card precedent for
// this exact readOnly reuse).
function LiveWatch({ view }: { view: WatchRoundView }) {
  const [activeGameId, setActiveGameId] = useState<GameId | undefined>(undefined);
  const state = view.state!; // caller's own contract: only rendered once view.state is defined
  const activeGame = view.games.find((g) => g.id === activeGameId) ?? view.games.find((g) => !state.terminatedGameIds.has(g.id));

  return (
    <>
      <StandingsHeader state={state} games={view.games} activeGameId={activeGame?.id} onSelect={setActiveGameId} />
      <ScorecardGrid state={state} activeGame={activeGame} recordScore={() => {}} readOnly />
    </>
  );
}

// /watch/{roundId}#{token} (M9 Task 3 brief): the immortal, read-only spectator view. Reads
// its token from the URL FRAGMENT, never a query param — fragments never leave the browser
// (they're stripped before a request line is built and never appear in server/proxy access
// logs), which is exactly the property a non-expiring capability token needs. No sign-in, no
// session/outbox (useWatchRound's own doc comment), no edit affordances anywhere in this file
// — WatchPageTest structurally asserts no score buttons render.
export const createWatchPage = (useWatchRound: UseWatchRound = defaultUseWatchRound) => {
  function WatchPageContent({ roundId, token }: { roundId: RoundId; token: string }) {
    const view = useWatchRound(roundId, token);

    if (!view.hydrated || !view.state) {
      // Papercut 14 (M9 hardening): a mistyped/dead link's every pull fails identically to a
      // transient blip at the hook layer — view.error is the one signal that distinguishes
      // "still loading" from "this link is broken," so a golfer stops staring at a spinner
      // that will never resolve. Kept honest (never a raw error/exception string) and quiet
      // (role="status", the same tone as the fragment-missing message below — not an alarming
      // role="alert").
      if (view.error) {
        return (
          <div role="status" className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100">
            This share link isn&apos;t valid — ask for a fresh one.
          </div>
        );
      }
      return (
        <div role="status" aria-label="Loading round" className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100">
          Loading round…
        </div>
      );
    }

    const isFinal = view.state.status === "final";
    const isAbandoned = view.state.status === "abandoned";

    // task-15: a scrapped round is terminal with nothing to show a spectator — no results, no
    // live scorecard. Render an honest notice rather than crash or show a stale live grid (the
    // fold reports "abandoned"; useWatchRound's reduceRound handles the kind by the append-only
    // rule, so a spectator whose round is scrapped mid-watch simply lands here on the next poll).
    if (isAbandoned) {
      return (
        <main className="min-h-screen bg-slate-950">
          <div role="status" className="flex min-h-screen items-center justify-center p-6 text-center text-slate-100">
            This round was scrapped — there&apos;s nothing to show.
          </div>
        </main>
      );
    }

    return (
      <main className="min-h-screen bg-slate-950">
        {/* The canonical designation (accounts-only identity spec §5): the spectator sees WHICH
            round this is — course + date, rendered the one way the home list and archive render
            it, replacing the bare course name. */}
        <div className="p-4 text-slate-100">
          <p className="text-sm text-slate-400">{roundLabel({ courseName: view.state.card.courseName, createdAt: view.createdAt })}</p>
        </div>
        {/* No shareToken: a spectator holds no participant token to mint a NEW share link with —
            ResultsView.tsx's own doc comment explains why shareToken is optional and omitted
            here. */}
        {isFinal ? <ResultsView state={view.state} games={view.games} response={undefined} /> : <LiveWatch view={view} />}
      </main>
    );
  }

  return function WatchPage() {
    const { roundId: param } = useParams<{ roundId: string }>();
    const location = useLocation();
    // location.hash carries the leading "#" (matches window.location.hash) — stripped once,
    // here, so every downstream consumer gets a bare token.
    const token = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;

    if (!param || !token) {
      return (
        <div role="status" className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100">
          This share link looks incomplete — ask for a fresh one.
        </div>
      );
    }

    return <WatchPageContent roundId={makeRoundId(param)} token={token} />;
  };
};

export const WatchPage = createWatchPage();
