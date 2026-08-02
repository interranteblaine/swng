import { useCallback, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import type { GameConfigInput } from "@swng/contracts";
import { roundId as makeRoundId } from "@swng/domain";
import type { GameId, GameState, GolferId, HoleResult, HoleSelection, RoundId, RoundState } from "@swng/domain";
import { abandonRound, addGame, finalizeRound, leaveRound, setHoles, setPlayedAt, setStrokes, terminateGame } from "../api";
import { credentialStore } from "../identity";
import type { RoundCredential } from "../identity";
import { unresolvedGames } from "../round/finalizeReadiness";
import { ResultsView } from "../round/ResultsView";
import { ScorecardGrid } from "../round/ScorecardGrid";
import { ShareButton } from "../round/ShareButton";
import { SetupPanel } from "../round/SetupPanel";
import { StandingsHeader } from "../round/StandingsHeader";
import { StatusChrome } from "../round/StatusChrome";
import { roundLabel } from "../roundLabel";
import { useRoundSession as defaultUseRoundSession } from "../session/useRoundSession";
import type { RoundSessionView } from "../session/useRoundSession";
import { btnDanger, btnDangerSolid, btnPrimary, btnSecondary } from "../ui/classes";
import { usePageTitle } from "../ui/usePageTitle";

type UseRoundSession = (roundId: RoundId) => RoundSessionView;

// What a finalize ATTEMPT can come back as. `round-finalized` is terminal, so a score still
// sitting in this device's outbox when it lands is refused by the server and dropped for good —
// which is why "the queue wouldn't drain" is a first-class outcome here rather than an error:
// nothing was attempted, nothing was lost, and the golfer needs to be told exactly that.
type FinalizeOutcome = { readonly ok: true } | { readonly ok: false; readonly unsent: number };

interface FinalizeControlProps {
  readonly state: RoundState;
  readonly games: readonly GameState[];
  // Outbox depth, for the dialog's own honesty about what hasn't sent yet. Only ever read at
  // render time — the ACTING count comes back from onFinalize, which reads it live (a snapshot
  // taken before an await can't be trusted afterwards; session/useRoundSession.ts's flush()).
  readonly pending: number;
  // True for exactly as long as a finalize attempt is in flight. LiveRound owns it because the
  // CARD has to lock on the very same flag (see its own comment), so this component only reads
  // it — one flag, and the buttons and the card can never disagree about whether an attempt is
  // running.
  readonly busy: boolean;
  // Ends `endFirst` (in order) and finalizes, but only after this device's outbox is confirmed
  // empty — see RoundPageContent's own implementation for the ordering rule.
  readonly onFinalize: (endFirst?: readonly GameId[]) => Promise<FinalizeOutcome>;
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
function FinalizeControl({ state, games, pending, busy, onFinalize }: FinalizeControlProps) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [unsent, setUnsent] = useState<number | undefined>(undefined);

  // Recomputed from the fold on every render — a score or termination landing mid-dialog (via
  // sync) updates the list live, and after a failed attempt this same recomputation IS the
  // structured explanation the brief demands in place of the old raw caught.message.
  const unresolved = unresolvedGames(state, games);

  // Both buttons below are the SAME guarded attempt, differing only in which games it ends on
  // the way through — so the drain-first rule can't be true of one path and forgotten on the
  // other.
  const attemptFinalize = async (endFirst: readonly GameId[]) => {
    setError(undefined);
    setUnsent(undefined);
    try {
      const outcome = await onFinalize(endFirst);
      // No local "done" state to set on success: onFinalize's own session.sync() (RoundPage's
      // implementation below) is what flips session.state.status to "final", which swaps this
      // whole subtree for ResultsView in the parent — this component just stops rendering,
      // matching SetupPanel's own "no optimistic insert, let the fold do it" precedent.
      if (outcome.ok) return;
      setUnsent(outcome.unsent);
    } catch {
      // NEVER caught.message (papercut 1): the raw server line names games by uuid. The dialog
      // stays open — its unresolved list, recomputed from the fold above, is the real
      // explanation; this line only says the attempt itself failed.
      setError("Could not finalize the round — try again.");
    }
  };

  return (
    <div className="p-3">
      <button
        type="button"
        onClick={() => {
          setError(undefined);
          setUnsent(undefined);
          setConfirming(true);
        }}
        className={`${btnDanger} min-h-14 w-full`}
      >
        Finalize round
      </button>

      {confirming && (
        <div role="dialog" aria-label="Confirm finalize" className="fixed inset-x-0 bottom-0 z-50 flex flex-col gap-3 border-t-2 border-forest bg-card p-4 shadow-2xl">
          {/* Stated before the tap, not discovered after it: "locks in every score" below is only
              true because the attempt sends what's queued first, so the dialog says so out loud
              whenever there is anything to send. */}
          {pending > 0 && (
            <p className="text-sm text-fairway">
              {pending} score{pending === 1 ? "" : "s"} {pending === 1 ? "hasn't" : "haven't"} sent yet — finalizing sends {pending === 1 ? "it" : "them"} first.
            </p>
          )}
          {unresolved.length === 0 ? (
            <>
              <p className="text-sm text-fairway">Finalize the round? This locks in every score — no more edits.</p>
              <button type="button" onClick={() => void attemptFinalize([])} disabled={busy} className={`${btnPrimary} min-h-14 disabled:opacity-50`}>
                {busy ? "Finalizing…" : "Finalize"}
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-fairway">Some games aren&apos;t finished:</p>
              <ul className="flex flex-col gap-1 text-sm text-forest">
                {unresolved.map((game) => (
                  <li key={game.gameId}>
                    {game.title} — {game.missing}
                  </li>
                ))}
              </ul>
              <p className="text-sm text-fairway">Ending them stops their scoring — they won&apos;t appear in the final results.</p>
              <button
                type="button"
                onClick={() => void attemptFinalize(unresolved.map((game) => game.gameId))}
                disabled={busy}
                className={`${btnDangerSolid} min-h-14 disabled:opacity-50`}
              >
                {busy ? "Finalizing…" : "End unfinished games & finalize"}
              </button>
            </>
          )}
          <button type="button" onClick={() => setConfirming(false)} disabled={busy} className={`${btnSecondary} min-h-14 disabled:opacity-50`}>
            Cancel
          </button>
          {unsent !== undefined && (
            <p role="alert" className="text-oxblood">
              Nothing was finalized — {unsent} score{unsent === 1 ? "" : "s"} {unsent === 1 ? "hasn't" : "haven't"} sent yet. No score is lost; check your signal, then finalize
              again.
            </p>
          )}
          {error && (
            <p role="alert" className="text-oxblood">
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
        className="min-h-12 w-full px-4 text-sm font-medium text-fairway/70"
      >
        Scrap this round
      </button>

      {confirming && (
        <div role="dialog" aria-label="Confirm scrap" className="fixed inset-x-0 bottom-0 z-50 flex flex-col gap-3 border-t-2 border-forest bg-card p-4 shadow-2xl">
          <p className="text-sm text-fairway">Scrap this round? It counts nowhere — no results, nothing added to your record — and this can&apos;t be undone.</p>
          <button type="button" onClick={() => void scrapNow()} disabled={busy} className={`${btnDanger} min-h-14 disabled:opacity-50`}>
            {busy ? "Scrapping…" : "Scrap round"}
          </button>
          <button type="button" onClick={() => setConfirming(false)} disabled={busy} className={`${btnSecondary} min-h-14 disabled:opacity-50`}>
            Cancel
          </button>
          {error && (
            <p role="alert" className="text-oxblood">
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
        className="min-h-12 w-full px-4 text-sm font-medium text-fairway/70"
      >
        Leave round
      </button>

      {confirming && (
        <div role="dialog" aria-label="Confirm leave" className="fixed inset-x-0 bottom-0 z-50 flex flex-col gap-3 border-t-2 border-forest bg-card p-4 shadow-2xl">
          <p className="text-sm text-fairway">
            Leave this round? Your scored holes stay in the game — you just stop scoring. You can rejoin anytime with the round code.
          </p>
          <button type="button" onClick={() => void leaveNow()} disabled={busy} className="min-h-14 bg-fairway px-4 text-base font-semibold text-cream disabled:opacity-50">
            {busy ? "Leaving…" : "Leave"}
          </button>
          <button type="button" onClick={() => setConfirming(false)} disabled={busy} className={`${btnSecondary} min-h-14 disabled:opacity-50`}>
            Cancel
          </button>
          {error && (
            <p role="alert" className="text-oxblood">
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
    <div role="status" className="flex min-h-screen flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-lg font-semibold text-forest">This round was scrapped.</p>
      <p className="max-w-sm text-sm text-fairway">It counts nowhere — no results, nothing added to your record. Start a new round to play again.</p>
    </div>
  );
}

interface LiveRoundProps {
  readonly state: RoundState; // status !== "final" — RoundPageContent's own contract below
  readonly games: readonly GameState[];
  readonly recordScore: (golferId: GolferId, hole: number, result: HoleResult) => void;
  readonly pending: number;
  readonly joinCode: string;
  // M9 Task 3 (share): the caller's own participant token — ShareButton's only other input
  // beyond state.id, same "credential.token" this page already threads to every write call.
  readonly token: string;
  readonly onAddGame: (game: GameConfigInput) => Promise<void>;
  readonly onFinalize: (endFirst?: readonly GameId[]) => Promise<FinalizeOutcome>;
  readonly onTerminate: (gameId: GameId) => Promise<void>;
  readonly onAbandon: () => Promise<void>;
  readonly onLeave: () => Promise<void>;
  readonly onSetStrokes: (golferId: GolferId, strokes: number) => Promise<void>;
  readonly onSetPlayedAt: (playedAtMs: number) => Promise<void>;
  readonly onSetHoles: (holes: HoleSelection) => Promise<void>;
}

// Everything that's only ever rendered pre-finalize, as its OWN component (not an inline
// branch of RoundPageContent) — spec 2026-07-19: the card is game-agnostic (Task 3) and
// StandingsHeader no longer needs an active-game selection threaded down to it at all (its own
// chips are pure disclosure toggles now), so this component's only remaining job is composing
// the live-only chrome that unmounts once status flips to "final".
function LiveRound({ state, games, recordScore, pending, joinCode, token, onAddGame, onFinalize, onTerminate, onAbandon, onLeave, onSetStrokes, onSetPlayedAt, onSetHoles }: LiveRoundProps) {
  // The card locks for exactly as long as a finalize attempt is in flight, and not a moment
  // longer. onFinalize drains the outbox and only then seals — but a score tapped INSIDE that
  // window joins the outbox too late for the drain that already ran, so it pushes after
  // `round-finalized` and is refused forever: the same silent loss the drain-first rule exists
  // to prevent, in a narrower window. The dialog is a bottom sheet with no scrim, so the grid
  // behind it stays tappable; locking the card is what closes it.
  //
  // Keyed to the ATTEMPT, not to the dialog being open: a golfer reading the confirm, one who
  // cancels it, and one whose offline attempt was refused all keep a fully live card.
  const [finalizing, setFinalizing] = useState(false);

  const attemptFinalize = useCallback(
    async (endFirst?: readonly GameId[]) => {
      setFinalizing(true);
      try {
        return await onFinalize(endFirst);
      } finally {
        setFinalizing(false);
      }
    },
    [onFinalize],
  );

  // Order is the owner's ruling (spec 2026-07-20 §1): the card and its setup first, then
  // Finalize (the round's one big action), then the personal/destructive pair, then Share —
  // the least-used affordance — dead last.
  return (
    <>
      <StandingsHeader state={state} games={games} onTerminate={onTerminate} />
      <ScorecardGrid state={state} recordScore={recordScore} readOnly={finalizing} />
      <SetupPanel state={state} games={games} joinCode={joinCode} onAddGame={onAddGame} onSetStrokes={onSetStrokes} onSetPlayedAt={onSetPlayedAt} onSetHoles={onSetHoles} />
      <FinalizeControl state={state} games={games} pending={pending} busy={finalizing} onFinalize={attemptFinalize} />
      <LeaveControl onLeave={onLeave} />
      <ScrapControl onAbandon={onAbandon} />
      <ShareButton roundId={state.id} token={token} />
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

    // Destructured so useCallback's deps list a stable function reference (sync's own
    // useCallback([]) in useRoundSession.ts) rather than the whole `session` object, which is
    // a fresh literal every render (snapshot spread) and would defeat memoization entirely.
    const { sync, connect, flush } = session;

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

    const onSetStrokes = useCallback(
      async (golferId: GolferId, strokes: number) => {
        // Server-authored append, then sync() — the new number re-strikes that player's dots and
        // every standing they appear in when the fold re-renders, matching every other mutation's
        // sync()-then-let-the-fold-swap pattern.
        await setStrokes(roundId, credential.token, { golferId, strokes });
        await sync();
      },
      [roundId, credential.token, sync],
    );

    const onSetPlayedAt = useCallback(
      async (playedAtMs: number) => {
        // Server-authored append, then sync() — the corrected instant re-renders SetupPanel's own
        // display and, wherever a card+date title reads state.playedAtMs (this page's own
        // usePageTitle below), the same sync()-then-let-the-fold-swap pattern every other
        // mutation on this page follows. No optimistic local write.
        await setPlayedAt(roundId, credential.token, { playedAtMs });
        await sync();
      },
      [roundId, credential.token, sync],
    );

    const onSetHoles = useCallback(
      async (holes: HoleSelection) => {
        // Server-authored append, then sync() — the corrected selection re-draws the card (every
        // engine already filters cells by selection) and SetupPanel's own display, matching every
        // other roster/round-level mutation's sync()-then-let-the-fold-swap pattern. No
        // optimistic local write: switching front → all restores holes 10–18 exactly as typed,
        // via the fold, never a local rewrite here.
        await setHoles(roundId, credential.token, { holes });
        await sync();
      },
      [roundId, credential.token, sync],
    );

    // THE finalize boundary — the one place the endpoint is called, so the drain-first rule
    // below cannot be bypassed by adding another button. Scoring is offline-first: a tap folds
    // optimistically and queues, and the sync loop pushes on its own schedule. `round-finalized`
    // is terminal, so a score still queued when it lands is permanently refused by the server —
    // it was entered, it renders locally, and it silently never existed. So: push the outbox and
    // wait, and if anything is STILL queued afterwards, do nothing at all and say so. Nothing
    // after this line runs on a refusal — not the terminations either — so a tap that can't
    // succeed leaves the round exactly as the golfer left it, with every score still safely
    // queued on the device.
    const onFinalize = useCallback(
      async (endFirst: readonly GameId[] = []): Promise<FinalizeOutcome> => {
        const stillQueued = await flush();
        if (stillQueued > 0) return { ok: false, unsent: stillQueued };
        // Strictly before the finalize, or it lands on an unresolved game and 409s. No per-game
        // sync(): the one below covers every append this call made.
        for (const targetGameId of endFirst) await terminateGame(roundId, credential.token, targetGameId);
        await finalizeRound(roundId, credential.token);
        // The call has already landed server-side, but session.state.status hasn't necessarily
        // folded the resulting round-finalized event yet (it arrives via this tab's own pull/WS,
        // same as any other event) — sync() pulls it now instead of waiting for the next natural
        // tick, so the live→ResultsView swap below follows almost immediately.
        await sync();
        return { ok: true };
      },
      [roundId, credential.token, flush, sync],
    );

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

    // StatusChrome's "Try now" backstop (shown only once the outbox's own backoff loop is
    // `stalled`): connect() re-opens the socket if it dropped (a no-op otherwise — session.ts's
    // own idempotency), then sync() explicitly pushes+pulls once, through the same serialized
    // gate as every other trigger, so it coalesces onto whatever pass connect()'s own
    // opportunistic sync may already have started rather than running twice.
    const reconnect = useCallback(() => {
      connect();
      void sync();
    }, [connect, sync]);

    // Re-runs once the session hydrates (usePageTitle's own title-prop-change contract) — "swng"
    // while loading, then the same canonical course + date designation every other round surface
    // renders (round-played-date spec 2026-08-01 §6): RoundState.playedAtMs now carries WHEN THE
    // GOLF HAPPENED directly (domain's playedAtMsOf, folded in by reduceRound), so this is no
    // longer the bare course name the old "RoundState carries no created-at" limitation left it
    // with.
    usePageTitle(session.state ? roundLabel({ courseName: session.state.card.courseName, playedAt: session.state.playedAtMs }) : undefined);

    // session.state is only guaranteed once hydrated() is true (RoundSessionView's own
    // contract, mirroring @swng/client's render guard) — checked together so TS narrows
    // `session.state` to RoundState, not RoundState | undefined, below.
    if (!session.hydrated || !session.state) {
      return (
        <div role="status" aria-label="Loading round" className="flex min-h-screen items-center justify-center bg-cream">
          Loading round…
        </div>
      );
    }

    // status comes from the folded log, not local memory (brief) — a refreshed/rejoining
    // client, or one that never called finalize/abandon itself, lands here identically.
    const isFinal = session.state.status === "final";
    const isAbandoned = session.state.status === "abandoned";

    // A scrapped round is terminal and has no scorecard/results to show — swap the whole page
    // for the honest notice, ahead of any scoring chrome (StatusChrome's queue/stalled banner
    // would be meaningless noise over a round that counts nowhere).
    if (isAbandoned) {
      return (
        <main className="min-h-screen bg-cream">
          <ScrappedRound />
        </main>
      );
    }

    return (
      <main className="min-h-screen bg-cream">
        <StatusChrome
          stalled={session.stalled}
          pending={session.pending}
          rejected={session.rejected}
          participants={session.state.participants}
          onReconnect={reconnect}
        />
        {isFinal ? (
          <ResultsView state={session.state} games={session.games} shareToken={credential.token} />
        ) : (
          <LiveRound
            state={session.state}
            games={session.games}
            recordScore={session.recordScore}
            pending={session.pending}
            joinCode={credential.joinCode}
            token={credential.token}
            onAddGame={onAddGame}
            onFinalize={onFinalize}
            onTerminate={onTerminate}
            onAbandon={onAbandon}
            onLeave={onLeave}
            onSetStrokes={onSetStrokes}
            onSetPlayedAt={onSetPlayedAt}
            onSetHoles={onSetHoles}
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
