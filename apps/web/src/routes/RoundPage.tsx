import { useCallback } from "react";
import { Navigate, useParams } from "react-router";
import type { GameConfigInput } from "@swng/contracts";
import { roundId as makeRoundId } from "@swng/domain";
import type { RoundId } from "@swng/domain";
import { addGame } from "../api";
import { credentialStore } from "../identity";
import type { RoundCredential } from "../identity";
import { ScorecardGrid } from "../round/ScorecardGrid";
import { SetupPanel } from "../round/SetupPanel";
import { StatusChrome } from "../round/StatusChrome";
import { useRoundSession as defaultUseRoundSession } from "../session/useRoundSession";
import type { RoundSessionView } from "../session/useRoundSession";

type UseRoundSession = (roundId: RoundId) => RoundSessionView;

// Factory (same DI shape as session/useRoundSession.ts's own createUseRoundSession) so tests
// can bind a scripted session instead of the real network/IndexedDB one, without a second
// hand-rolled fake — `RoundPage` below is just this factory applied to the real hook.
export const createRoundPage = (useRoundSession: UseRoundSession = defaultUseRoundSession) => {
  function RoundPageContent({ roundId, credential }: { roundId: RoundId; credential: RoundCredential }) {
    const session = useRoundSession(roundId);

    const onAddGame = useCallback(
      async (game: GameConfigInput) => {
        await addGame(roundId, credential.token, game);
        // No optimistic insert: the game-added event flows back through the session
        // (pull/WS) and SetupPanel renders it from state.games — game setup is rare and
        // server-authored.
      },
      [roundId, credential.token],
    );

    // session.state is only guaranteed once hydrated() is true (RoundSessionView's own
    // contract, mirroring @swng/client's render guard) — checked together so TS narrows
    // `session.state` to RoundState, not RoundState | undefined, below.
    if (!session.hydrated || !session.state) {
      return (
        <div role="status" aria-label="Loading round" className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100">
          Loading round…
        </div>
      );
    }

    return (
      <main className="min-h-screen bg-slate-950">
        <StatusChrome connected={session.connected} pending={session.pending} rejected={session.rejected} participants={session.state.participants} />
        {/* Task 6 picks the active game via a standings chip; until then it defaults to the
            first game (or undefined with none yet) — see ScorecardGrid's own doc comment on
            the `activeGame` prop for what that seam does and doesn't need. */}
        <ScorecardGrid state={session.state} activeGame={session.games[0]} recordScore={session.recordScore} />
        <SetupPanel state={session.state} games={session.games} joinCode={credential.joinCode} onAddGame={onAddGame} />
      </main>
    );
  }

  // Guard rail: no saved credential for this round on this device — nothing to authenticate a
  // session with, so bounce to Join rather than rendering a session that can only ever stay
  // idle (the brief's contract).
  function RoundPageForId({ roundIdParam }: { roundIdParam: string }) {
    const id = makeRoundId(roundIdParam);
    const credential = credentialStore.load(id);
    if (!credential) return <Navigate to="/join" replace />;
    return <RoundPageContent roundId={id} credential={credential} />;
  }

  return function RoundPage() {
    const { roundId: param } = useParams<{ roundId: string }>();
    if (!param) return <Navigate to="/" replace />; // unreachable given the route pattern; keeps TS/runtime honest

    // useRoundSession keeps its live session in refs that persist across re-renders of the
    // SAME component instance — changing the :roundId param alone does NOT reset them (a
    // flagged Task 3 gap: a brief stale-snapshot window before the new session's first
    // notify()). Keying this inner component by the route param forces a full unmount/remount
    // on every round change, which is the only currently-safe way to switch rounds without
    // carrying stale state.
    return <RoundPageForId key={param} roundIdParam={param} />;
  };
};

export const RoundPage = createRoundPage();
