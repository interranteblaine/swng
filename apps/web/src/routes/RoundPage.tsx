import { useCallback, useState } from "react";
import { Navigate, useParams } from "react-router";
import type { FinalizeRoundResponse, GameConfigInput } from "@swng/contracts";
import { roundId as makeRoundId } from "@swng/domain";
import type { GameId, GameState, GolferId, HoleResult, RoundId, RoundState } from "@swng/domain";
import { addGame, finalizeRound } from "../api";
import { credentialStore } from "../identity";
import type { RoundCredential } from "../identity";
import { HoleDigest, useHoleDigest } from "../round/HoleDigest";
import { ResultsView } from "../round/ResultsView";
import { ScorecardGrid } from "../round/ScorecardGrid";
import { SetupPanel } from "../round/SetupPanel";
import { StandingsHeader } from "../round/StandingsHeader";
import { StatusChrome } from "../round/StatusChrome";
import { useRoundSession as defaultUseRoundSession } from "../session/useRoundSession";
import type { RoundSessionView } from "../session/useRoundSession";

type UseRoundSession = (roundId: RoundId) => RoundSessionView;

interface FinalizeControlProps {
  readonly onFinalize: () => Promise<void>;
}

// Any participant may finalize (brief) — the confirm dialog here is a SEPARATE affordance
// from ScorePad's two-tap contract, not a third tap added to it: scoring itself stays exactly
// two taps, this is a distinct, rarer action with its own (one-time, whole-round) confirm step.
function FinalizeControl({ onFinalize }: FinalizeControlProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onFinalize();
      // No local "done" state to set on success: onFinalize's own session.sync() (RoundPage's
      // implementation below) is what flips session.state.status to "final", which swaps this
      // whole subtree for ResultsView in the parent — this component just stops rendering,
      // matching SetupPanel's own "no optimistic insert, let the fold do it" precedent.
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not finalize — try again.");
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="p-3">
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="min-h-14 w-full rounded-lg bg-red-900 px-4 text-base font-semibold text-slate-100 active:bg-red-800"
      >
        Finalize round
      </button>

      {confirming && (
        <div role="dialog" aria-label="Confirm finalize" className="fixed inset-x-0 bottom-0 z-50 flex flex-col gap-3 rounded-t-2xl bg-slate-900 p-4 shadow-2xl">
          <p className="text-sm text-slate-300">Finalize the round? This locks in every score — no more edits.</p>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            className="min-h-14 rounded-lg bg-red-800 px-4 text-base font-semibold text-slate-100 disabled:opacity-50"
          >
            {busy ? "Finalizing…" : "Finalize"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="min-h-14 rounded-lg bg-slate-800 px-4 text-base font-medium text-slate-300 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

interface LiveRoundProps {
  readonly state: RoundState; // status !== "final" — RoundPageContent's own contract below
  readonly games: readonly GameState[];
  readonly recordScore: (golferId: GolferId, hole: number, result: HoleResult) => void;
  readonly joinCode: string;
  readonly onAddGame: (game: GameConfigInput) => Promise<void>;
  readonly onFinalize: () => Promise<void>;
}

// Everything that's only ever rendered pre-finalize, as its OWN component (not an inline
// branch of RoundPageContent) so its hooks — chip selection, the digest's transition
// tracking — only ever run while a live round is actually mounted: they'd otherwise have to
// tolerate `state` swapping in and out across the live/final boundary, which useHoleDigest's
// prev-snapshot ref isn't built to do (and doesn't need to — this component simply unmounts
// once status flips to "final" and RoundPageContent renders ResultsView instead).
function LiveRound({ state, games, recordScore, joinCode, onAddGame, onFinalize }: LiveRoundProps) {
  const [activeGameId, setActiveGameId] = useState<GameId | undefined>(undefined);
  // Falls back to the first game until a chip is tapped (Task 5's fixed default-first-game
  // decision) — also the correct fallback if a previously-active id ever stopped matching.
  const activeGame = games.find((g) => g.id === activeGameId) ?? games[0];
  const { digest, dismiss } = useHoleDigest(state, games);

  return (
    <>
      <StandingsHeader state={state} games={games} activeGameId={activeGame?.id} onSelect={setActiveGameId} />
      <ScorecardGrid state={state} activeGame={activeGame} recordScore={recordScore} />
      {digest && <HoleDigest digest={digest} onDismiss={dismiss} />}
      <FinalizeControl onFinalize={onFinalize} />
      <SetupPanel state={state} games={games} joinCode={joinCode} onAddGame={onAddGame} />
    </>
  );
}

// Factory (same DI shape as session/useRoundSession.ts's own createUseRoundSession) so tests
// can bind a scripted session instead of the real network/IndexedDB one, without a second
// hand-rolled fake — `RoundPage` below is just this factory applied to the real hook.
export const createRoundPage = (useRoundSession: UseRoundSession = defaultUseRoundSession) => {
  function RoundPageContent({ roundId, credential }: { roundId: RoundId; credential: RoundCredential }) {
    const session = useRoundSession(roundId);
    // Present only once THIS tab has called finalize itself — a tab that only observes the
    // status flip via WS/pull (another participant finalized) never sets this, and
    // ResultsView must render fully either way (its own contract; see its doc comment).
    const [finalizeResponse, setFinalizeResponse] = useState<FinalizeRoundResponse | undefined>(undefined);

    const onAddGame = useCallback(
      async (game: GameConfigInput) => {
        await addGame(roundId, credential.token, game);
        // No optimistic insert: the game-added event flows back through the session
        // (pull/WS) and SetupPanel renders it from state.games — game setup is rare and
        // server-authored.
      },
      [roundId, credential.token],
    );

    // Destructured so useCallback's deps list a stable function reference (sync's own
    // useCallback([]) in useRoundSession.ts) rather than the whole `session` object, which is
    // a fresh literal every render (snapshot spread) and would defeat memoization entirely.
    const { sync, connect } = session;
    const onFinalize = useCallback(async () => {
      const response = await finalizeRound(roundId, credential.token);
      setFinalizeResponse(response);
      // The response is already in hand, but session.state.status hasn't necessarily folded
      // the resulting round-finalized event yet (it arrives via this tab's own pull/WS, same
      // as any other event) — sync() pulls it now instead of waiting for the next natural
      // tick, so the live→ResultsView swap below follows almost immediately.
      await sync();
    }, [roundId, credential.token, sync]);

    // StatusChrome's "Sync now" button: connect() re-opens the socket if it dropped (a no-op
    // otherwise — session.ts's own idempotency), then sync() explicitly pushes+pulls once,
    // through the same serialized gate as every other trigger, so it coalesces onto whatever
    // pass connect()'s own opportunistic sync may already have started rather than running
    // twice.
    const reconnect = useCallback(() => {
      connect();
      void sync();
    }, [connect, sync]);

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

    // status comes from the folded log, not local memory (brief) — a refreshed/rejoining
    // client, or one that never called finalize itself, lands here identically.
    const isFinal = session.state.status === "final";

    return (
      <main className="min-h-screen bg-slate-950">
        <StatusChrome
          connected={session.connected}
          pending={session.pending}
          rejected={session.rejected}
          participants={session.state.participants}
          onReconnect={reconnect}
        />
        {isFinal ? (
          <ResultsView state={session.state} games={session.games} response={finalizeResponse} />
        ) : (
          <LiveRound
            state={session.state}
            games={session.games}
            recordScore={session.recordScore}
            joinCode={credential.joinCode}
            onAddGame={onAddGame}
            onFinalize={onFinalize}
          />
        )}
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
