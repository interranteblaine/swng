import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { reduceRound, roundId as makeRoundId, scoreGame } from "@swng/domain";
import type { GameConfig, GameState, RoundEvent, RoundId, RoundState } from "@swng/domain";
import { ApiError, getRoundArchive } from "../api";
import { useAuth } from "../auth/useAuth";
import { roundLabel } from "../roundLabel";
import { ResultsView } from "./ResultsView";

// Same forward-compat guard as watch/useWatchRound.ts's own KNOWN_GAME_KINDS (its doc comment
// explains why this small, five-literal set is duplicated locally rather than exported from
// @swng/client) — a finalized round holding a future game kind must not crash this read-only
// page.
const KNOWN_GAME_KINDS: ReadonlySet<GameConfig["kind"]> = new Set(["stroke-play", "singles-match", "stableford", "fourball-match", "skins"]);

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

// GET /rounds/{roundId}/archive (projection-realignment Task 6): a read-only page for ONE
// finalized round, reached from ProfilePage's own history links — "golfer"-gated (the
// caller's account Bearer, via useAuth's withAuth), never a round-scoped participant/
// spectator credential the way RoundPage/WatchPage are. No session, no outbox, no edit
// affordances: this fetches the archive's event log exactly once, folds it via the domain
// `reduceRound` (mirroring WatchPage.tsx's own fold-then-ResultsView composition, not a new
// one), and renders ResultsView over the result — the fold never mutates and nothing here
// ever calls a write endpoint.
export function ArchivedRoundPage() {
  const { roundId: param } = useParams<{ roundId: string }>();
  const { withAuth } = useAuth();
  const [view, setView] = useState<ArchiveView | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!param) return;
    const id: RoundId = makeRoundId(param);
    setView(undefined);
    setError(undefined);

    void withAuth((token) => getRoundArchive(token, id))
      .then(({ events }) => {
        const state = reduceRound(events);
        const games = state.games.filter((gameConfig) => KNOWN_GAME_KINDS.has(gameConfig.kind)).map((gameConfig) => scoreGame(gameConfig, state));
        setView({ state, games, createdAtMs: createdAtMsOf(events) });
      })
      .catch((caught) => {
        // Never the raw server text (RoundPage.tsx's finalize error / ProfilePage.tsx's save
        // error are the same discipline) — a 404 (never finalized/never existed) and a 403
        // (a stranger's account) both read the same honestly to a golfer who followed a link
        // to a round they can't open.
        setError(caught instanceof ApiError && caught.code === "round-not-found" ? "This round couldn't be found." : "Could not open this round — try again.");
      });
  }, [param, withAuth]);

  if (!param) {
    return (
      <div role="status" className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100">
        This link looks incomplete.
      </div>
    );
  }

  if (error) {
    return (
      <div role="status" className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100">
        {error}
      </div>
    );
  }

  if (!view) {
    return (
      <div role="status" aria-label="Loading round" className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100">
        Loading round…
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950">
      <div className="p-4 text-slate-100">
        {/* The canonical designation (spec §5): course + date, rendered the one way it is on the
            home list and the join link. */}
        <p className="text-sm text-slate-400">{roundLabel({ courseName: view.state.card.courseName, createdAt: view.createdAtMs })}</p>
      </div>
      {/* No shareToken: this page's viewer holds only their own golfer Bearer — never a
          round-scoped participant token to mint a NEW share link with (same reasoning as
          WatchPage's own reuse of ResultsView, WatchPage.tsx's doc comment). */}
      <ResultsView state={view.state} games={view.games} response={undefined} />
    </main>
  );
}
