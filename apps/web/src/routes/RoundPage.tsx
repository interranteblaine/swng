import { useCallback, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import type { FinalizeRoundResponse, GameConfigInput } from "@swng/contracts";
import { roundId as makeRoundId } from "@swng/domain";
import type { GameId, GameState, GolferId, HoleResult, RoundId, RoundState } from "@swng/domain";
import { abandonRound, addGame, finalizeRound, leaveRound, terminateGame } from "../api";
import { credentialStore } from "../identity";
import type { RoundCredential } from "../identity";
import { unresolvedGames } from "../round/finalizeReadiness";
import { ResultsView } from "../round/ResultsView";
import { ScorecardGrid } from "../round/ScorecardGrid";
import { ShareButton } from "../round/ShareButton";
import { SetupPanel } from "../round/SetupPanel";
import { StandingsHeader } from "../round/StandingsHeader";
import { StatusChrome } from "../round/StatusChrome";
import { useRoundSession as defaultUseRoundSession } from "../session/useRoundSession";
import type { RoundSessionView } from "../session/useRoundSession";

type UseRoundSession = (roundId: RoundId) => RoundSessionView;

interface FinalizeControlProps {
  readonly state: RoundState;
  readonly games: readonly GameState[];
  readonly onFinalize: () => Promise<void>;
  readonly onTerminate: (gameId: GameId) => Promise<void>;
}

// Any participant may finalize (brief) — the confirm dialog here is a SEPARATE affordance
// from ScorePad's two-tap contract, not a third tap added to it: scoring itself stays exactly
// two taps, this is a distinct, rarer action with its own (one-time, whole-round) confirm step.
//
// Papercut 1 (M7 Task 6): the dialog computes unresolved games from the LOCAL fold — the same
// game-config × cells × terminatedGameIds math settleRound applies server-side — so a golfer
// reads "Stableford — holes 2–18 unscored for Pat" BEFORE the server ever gets to 409, and
// "End unfinished games & finalize" (terminate each, then the existing finalize — the plan's
// fixed composition, not a new lifecycle state) resolves it in one tap.
function FinalizeControl({ state, games, onFinalize, onTerminate }: FinalizeControlProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Recomputed from the fold on every render — a score or termination landing mid-dialog (via
  // sync) updates the list live, and after a failed attempt this same recomputation IS the
  // structured explanation the brief demands in place of the old raw caught.message.
  const unresolved = unresolvedGames(state, games);

  const finalizeNow = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onFinalize();
      // No local "done" state to set on success: onFinalize's own session.sync() (RoundPage's
      // implementation below) is what flips session.state.status to "final", which swaps this
      // whole subtree for ResultsView in the parent — this component just stops rendering,
      // matching SetupPanel's own "no optimistic insert, let the fold do it" precedent.
    } catch {
      // NEVER caught.message (papercut 1): the raw server line names games by uuid. The dialog
      // stays open — its unresolved list, recomputed from the fold above, is the real
      // explanation; this line only says the attempt itself failed.
      setError("Could not finalize the round — try again.");
      setBusy(false);
    }
  };

  const endUnfinishedAndFinalize = async () => {
    setBusy(true);
    setError(undefined);
    try {
      // Terminate each unresolved game FIRST, then the ordinary finalize — strictly in this
      // order, or the finalize still lands on an unresolved game and 409s.
      for (const game of unresolved) await onTerminate(game.gameId);
      await onFinalize();
    } catch {
      setError("Could not finalize the round — try again.");
      setBusy(false);
    }
  };

  return (
    <div className="p-3">
      <button
        type="button"
        onClick={() => {
          setError(undefined);
          setConfirming(true);
        }}
        className="min-h-14 w-full rounded-lg bg-red-900 px-4 text-base font-semibold text-slate-100 active:bg-red-800"
      >
        Finalize round
      </button>

      {confirming && (
        <div role="dialog" aria-label="Confirm finalize" className="fixed inset-x-0 bottom-0 z-50 flex flex-col gap-3 rounded-t-2xl bg-slate-900 p-4 shadow-2xl">
          {unresolved.length === 0 ? (
            <>
              <p className="text-sm text-slate-300">Finalize the round? This locks in every score — no more edits.</p>
              <button
                type="button"
                onClick={() => void finalizeNow()}
                disabled={busy}
                className="min-h-14 rounded-lg bg-red-800 px-4 text-base font-semibold text-slate-100 disabled:opacity-50"
              >
                {busy ? "Finalizing…" : "Finalize"}
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-300">Some games aren&apos;t finished:</p>
              <ul className="flex flex-col gap-1 text-sm text-slate-200">
                {unresolved.map((game) => (
                  <li key={game.gameId}>
                    {game.title} — {game.missing}
                  </li>
                ))}
              </ul>
              <p className="text-sm text-slate-400">Ending them stops their scoring — they won&apos;t appear in the final results.</p>
              <button
                type="button"
                onClick={() => void endUnfinishedAndFinalize()}
                disabled={busy}
                className="min-h-14 rounded-lg bg-red-800 px-4 text-base font-semibold text-slate-100 disabled:opacity-50"
              >
                {busy ? "Finalizing…" : "End unfinished games & finalize"}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="min-h-14 rounded-lg bg-slate-800 px-4 text-base font-medium text-slate-300 disabled:opacity-50"
          >
            Cancel
          </button>
          {error && (
            <p role="alert" className="text-red-400">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// "Scrap this round" (task-15): a first-class scrap path — NOT "mark holes picked-up and
// finalize." A scrapped round produces no snapshot and counts nowhere, so this is a distinct,
// rare, destructive action with its own confirm gate (its own dialog, like FinalizeControl's),
// deliberately styled quiet/secondary so it never competes with Finalize for a tap. On success
// the round-abandoned event folds back through the session (onAbandon's own sync()), flipping
// status to "abandoned" — RoundPageContent then swaps this whole subtree for the scrapped-round
// notice, so like FinalizeControl this component simply stops rendering, no local "done" state.
function ScrapControl({ onAbandon }: { readonly onAbandon: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const scrapNow = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onAbandon();
    } catch {
      // The dialog stays open (retry one tap away); a human line, never a raw server message
      // (the same discipline FinalizeControl's own catch follows).
      setError("Could not scrap the round — try again.");
      setBusy(false);
    }
  };

  return (
    <div className="px-3 pb-3">
      <button
        type="button"
        onClick={() => {
          setError(undefined);
          setConfirming(true);
        }}
        className="min-h-12 w-full rounded-lg bg-slate-900 px-4 text-sm font-medium text-slate-500 active:bg-slate-800"
      >
        Scrap this round
      </button>

      {confirming && (
        <div role="dialog" aria-label="Confirm scrap" className="fixed inset-x-0 bottom-0 z-50 flex flex-col gap-3 rounded-t-2xl bg-slate-900 p-4 shadow-2xl">
          <p className="text-sm text-slate-300">
            Scrap this round? It counts nowhere — no results, no handicap posting — and this can&apos;t be undone.
          </p>
          <button
            type="button"
            onClick={() => void scrapNow()}
            disabled={busy}
            className="min-h-14 rounded-lg bg-red-800 px-4 text-base font-semibold text-slate-100 disabled:opacity-50"
          >
            {busy ? "Scrapping…" : "Scrap round"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="min-h-14 rounded-lg bg-slate-800 px-4 text-base font-medium text-slate-300 disabled:opacity-50"
          >
            Cancel
          </button>
          {error && (
            <p role="alert" className="text-red-400">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// "Leave round" (accounts-only identity spec §4): a participant walks off. DELIBERATELY distinct
// from ScrapControl above — leaving is PERSONAL and NON-DESTRUCTIVE: the round plays on for
// everyone else, the golfer's scored holes stay facts in the game, and they can rejoin with the
// same code anytime. So the copy never says "counts nowhere" (that language belongs to Scrap
// alone), and this styles quiet/secondary like Scrap so it never competes with Finalize for a
// tap. On confirm it's one POST then navigation home (onLeave's own impl below) — no presence
// tampering, no outbox/credential touch, no sync(): the leaver simply leaves the page.
function LeaveControl({ onLeave }: { readonly onLeave: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const leaveNow = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onLeave();
      // No local "done" state on success: onLeave navigates home (RoundPage's own impl), so this
      // component just unmounts — same "let the outcome unmount me" precedent as ScrapControl.
    } catch {
      // The dialog stays open (retry one tap away); a human line, never a raw server message.
      setError("Could not leave the round — try again.");
      setBusy(false);
    }
  };

  return (
    <div className="px-3 pb-3">
      <button
        type="button"
        onClick={() => {
          setError(undefined);
          setConfirming(true);
        }}
        className="min-h-12 w-full rounded-lg bg-slate-900 px-4 text-sm font-medium text-slate-500 active:bg-slate-800"
      >
        Leave round
      </button>

      {confirming && (
        <div role="dialog" aria-label="Confirm leave" className="fixed inset-x-0 bottom-0 z-50 flex flex-col gap-3 rounded-t-2xl bg-slate-900 p-4 shadow-2xl">
          <p className="text-sm text-slate-300">
            Leave this round? Your scored holes stay in the game — you just stop scoring. You can rejoin anytime with the round code.
          </p>
          <button
            type="button"
            onClick={() => void leaveNow()}
            disabled={busy}
            className="min-h-14 rounded-lg bg-slate-700 px-4 text-base font-semibold text-slate-100 disabled:opacity-50"
          >
            {busy ? "Leaving…" : "Leave"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="min-h-14 rounded-lg bg-slate-800 px-4 text-base font-medium text-slate-300 disabled:opacity-50"
          >
            Cancel
          </button>
          {error && (
            <p role="alert" className="text-red-400">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// The honest terminal treatment for a scrapped round (task-15): NOT ResultsView — there are no
// results — just a plain statement that the round counts nowhere. Rendered for anyone who lands
// on an abandoned round, whether they scrapped it themselves or only observed the status flip via
// WS/pull (same "status comes from the folded log, not local memory" contract as the final path).
function ScrappedRound() {
  return (
    <div role="status" className="flex min-h-screen flex-col items-center justify-center gap-2 p-6 text-center text-slate-100">
      <p className="text-lg font-semibold">This round was scrapped.</p>
      <p className="max-w-sm text-sm text-slate-400">It counts nowhere — no results, no handicap posting. Start a new round to play again.</p>
    </div>
  );
}

interface LiveRoundProps {
  readonly state: RoundState; // status !== "final" — RoundPageContent's own contract below
  readonly games: readonly GameState[];
  readonly recordScore: (golferId: GolferId, hole: number, result: HoleResult) => void;
  readonly joinCode: string;
  // M9 Task 3 (share): the caller's own participant token — ShareButton's only other input
  // beyond state.id, same "credential.token" this page already threads to every write call.
  readonly token: string;
  readonly onAddGame: (game: GameConfigInput) => Promise<void>;
  readonly onFinalize: () => Promise<void>;
  readonly onTerminate: (gameId: GameId) => Promise<void>;
  readonly onAbandon: () => Promise<void>;
  readonly onLeave: () => Promise<void>;
}

// Everything that's only ever rendered pre-finalize, as its OWN component (not an inline
// branch of RoundPageContent) so its chip-selection state only ever runs while a live round is
// actually mounted: it'd otherwise have to tolerate `state` swapping in and out across the
// live/final boundary — this component simply unmounts once status flips to "final" and
// RoundPageContent renders ResultsView instead.
function LiveRound({ state, games, recordScore, joinCode, token, onAddGame, onFinalize, onTerminate, onAbandon, onLeave }: LiveRoundProps) {
  const [activeGameId, setActiveGameId] = useState<GameId | undefined>(undefined);
  // Falls back to the first game until a chip is tapped (Task 5's fixed default-first-game
  // decision) — also the correct fallback if a previously-active id ever stopped matching. A
  // terminated game never wins the fallback (M7 Task 6 brief: "default active-game selection"
  // is one of the downstream filters) — an explicit chip tap can still land on one (its chip
  // stays, with an "ended" badge), just never the silent default.
  const activeGame = games.find((g) => g.id === activeGameId) ?? games.find((g) => !state.terminatedGameIds.has(g.id));

  return (
    <>
      <ShareButton roundId={state.id} token={token} />
      <StandingsHeader state={state} games={games} activeGameId={activeGame?.id} onSelect={setActiveGameId} onTerminate={onTerminate} />
      <ScorecardGrid state={state} recordScore={recordScore} />
      <FinalizeControl state={state} games={games} onFinalize={onFinalize} onTerminate={onTerminate} />
      <SetupPanel state={state} games={games} joinCode={joinCode} onAddGame={onAddGame} />
      <ScrapControl onAbandon={onAbandon} />
      <LeaveControl onLeave={onLeave} />
    </>
  );
}

// Factory (same DI shape as session/useRoundSession.ts's own createUseRoundSession) so tests
// can bind a scripted session instead of the real network/IndexedDB one, without a second
// hand-rolled fake — `RoundPage` below is just this factory applied to the real hook.
export const createRoundPage = (useRoundSession: UseRoundSession = defaultUseRoundSession) => {
  function RoundPageContent({ roundId, credential }: { roundId: RoundId; credential: RoundCredential }) {
    const session = useRoundSession(roundId);
    const navigate = useNavigate();
    // Present only once THIS tab has called finalize itself — a tab that only observes the
    // status flip via WS/pull (another participant finalized) never sets this, and
    // ResultsView must render fully either way (its own contract; see its doc comment).
    const [finalizeResponse, setFinalizeResponse] = useState<FinalizeRoundResponse | undefined>(undefined);

    // Destructured so useCallback's deps list a stable function reference (sync's own
    // useCallback([]) in useRoundSession.ts) rather than the whole `session` object, which is
    // a fresh literal every render (snapshot spread) and would defeat memoization entirely.
    const { sync, connect } = session;

    const onAddGame = useCallback(
      async (game: GameConfigInput) => {
        await addGame(roundId, credential.token, game);
        // No optimistic insert: the game-added event flows back through the session
        // (pull/WS) and SetupPanel renders it from state.games — game setup is rare and
        // server-authored. Papercut 4 (M9 hardening): sync() explicitly, matching every OTHER
        // mutation on this page (onFinalize/onTerminate below) — without it, this device only
        // sees its own new game once the NEXT unrelated sync happens to fire (there is no
        // periodic poll timer; @swng/client's session only pulls on an explicit sync() or a WS
        // push), which could be a long, confusing wait for the host who just added the game.
        await sync();
      },
      [roundId, credential.token, sync],
    );

    const onFinalize = useCallback(async () => {
      const response = await finalizeRound(roundId, credential.token);
      setFinalizeResponse(response);
      // The response is already in hand, but session.state.status hasn't necessarily folded
      // the resulting round-finalized event yet (it arrives via this tab's own pull/WS, same
      // as any other event) — sync() pulls it now instead of waiting for the next natural
      // tick, so the live→ResultsView swap below follows almost immediately.
      await sync();
    }, [roundId, credential.token, sync]);

    const onTerminate = useCallback(
      async (targetGameId: GameId) => {
        await terminateGame(roundId, credential.token, targetGameId);
        // Same reasoning as onFinalize's sync() above: the game-terminated event arrives via
        // this tab's own pull/WS — sync now so the chip's Ended badge and the dot/digest
        // drop-outs follow immediately, not on the next natural tick.
        await sync();
      },
      [roundId, credential.token, sync],
    );

    const onAbandon = useCallback(async () => {
      await abandonRound(roundId, credential.token);
      // The round-abandoned event arrives via this tab's own pull/WS (same as any other event)
      // — sync() pulls it now so the live→scrapped-notice swap below follows immediately,
      // matching onFinalize/onTerminate's own explicit sync().
      await sync();
    }, [roundId, credential.token, sync]);

    // accounts-only identity spec §4: leaving is one POST then navigation home — deliberately NOT
    // the sync()-then-let-the-fold-swap-the-view pattern the mutations above use. Leaving is
    // personal, not a round state this tab keeps showing: no sync(), and no presence/outbox/
    // credential touch (presence clearing is the server's policy at finalize, not ours). The
    // participant-left event still lands server-side for everyone else's fold; this tab just
    // leaves the page.
    const onLeave = useCallback(async () => {
      await leaveRound(roundId, credential.token);
      navigate("/");
    }, [roundId, credential.token, navigate]);

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
    // client, or one that never called finalize/abandon itself, lands here identically.
    const isFinal = session.state.status === "final";
    const isAbandoned = session.state.status === "abandoned";

    // A scrapped round is terminal and has no scorecard/results to show — swap the whole page
    // for the honest notice, ahead of any scoring chrome (StatusChrome's offline banner / pending
    // badge would be meaningless noise over a round that counts nowhere).
    if (isAbandoned) {
      return (
        <main className="min-h-screen bg-slate-950">
          <ScrappedRound />
        </main>
      );
    }

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
          <ResultsView state={session.state} games={session.games} response={finalizeResponse} shareToken={credential.token} />
        ) : (
          <LiveRound
            state={session.state}
            games={session.games}
            recordScore={session.recordScore}
            joinCode={credential.joinCode}
            token={credential.token}
            onAddGame={onAddGame}
            onFinalize={onFinalize}
            onTerminate={onTerminate}
            onAbandon={onAbandon}
            onLeave={onLeave}
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
