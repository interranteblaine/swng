import { useState } from "react";
import { handicappingFor } from "@swng/domain";
import type { GameId, GameState, RoundState } from "@swng/domain";
import type { FinalizeRoundResponse } from "@swng/contracts";
import { ScorecardGrid } from "./ScorecardGrid";
import { ShareButton } from "./ShareButton";
import { StandingsHeader } from "./StandingsHeader";

export interface ResultsViewProps {
  readonly state: RoundState; // caller's own contract: only ever rendered once state.status === "final"
  readonly games: readonly GameState[]; // the session's local games() — same domain, same log as any server response
  // Present only on the tab that itself called finalizeRound (RoundPage's own contract) — a
  // tab that only observes the status flip via WS (another participant finalized) never gets
  // one. ResultsView must render fully either way: see the two why-comments below.
  readonly response: FinalizeRoundResponse | undefined;
  // M9 Task 3 (share): the caller's OWN participant token, threaded through only so ShareButton
  // can mint a link — OPTIONAL and OMITTED by WatchPage's own reuse of this exact component for
  // a spectator's archived-card view. A spectator holds no participant token (POST .../share is
  // participant-gated) and minting a NEW link isn't something a read-only view offers anyway —
  // leaving this unset is what keeps that reuse edit-affordance-free without a second,
  // spectator-flavored ResultsView.
  readonly shareToken?: string;
}

type HandicappingRow = FinalizeRoundResponse["handicapping"][number];

// A thin delegation to domain's own handicappingFor (packages/domain/src/scoring/
// allocation.ts) — M6 Task 5 deleted this file's own hand-mirrored AGS/differential
// arithmetic (byte-identical to the domain version, now a single source instead of two to
// keep in sync). Still the only way a WS-pushed final ever shows a differential before this
// tab's own finalize response (if it ever calls one) arrives — there is no local GameState
// equivalent for a differential, unlike the per-game results below.
const deriveHandicapping = (state: RoundState): readonly HandicappingRow[] =>
  state.participants.map((participant) => handicappingFor(participant, state.card, state.cells));

export function ResultsView({ state, games, response, shareToken }: ResultsViewProps) {
  const handicapping = response?.handicapping ?? deriveHandicapping(state);
  // Task 5: the archive gets the same chip-selected active game as a live round (RoundPage's
  // LiveRound) instead of a fixed games[0] — StandingsHeader IS the per-game standings display
  // here too (title+line per describeGame), so there's no separate static list beside it. M7
  // Task 6: same terminated-game exclusion from the default as LiveRound's own fallback — a
  // terminated game (kept in the archive for audit) never wins the silent default here either.
  const [activeGameId, setActiveGameId] = useState<GameId | undefined>(undefined);
  const activeGame = games.find((g) => g.id === activeGameId) ?? games.find((g) => !state.terminatedGameIds.has(g.id));

  return (
    <section className="flex flex-col gap-6 p-4 text-slate-100">
      <h1 className="text-xl font-bold">Final results</h1>

      {shareToken && <ShareButton roundId={state.id} token={shareToken} />}

      <div>
        <h2 className="text-lg font-semibold">Roster</h2>
        <ul className="flex flex-col gap-2">
          {state.participants.map((p) => (
            <li key={p.golferId} className="flex items-center gap-2">
              <span>{p.name}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h2 className="text-lg font-semibold">Handicap differentials</h2>
        <ul className="flex flex-col gap-1">
          {handicapping.map((row) => {
            const name = state.participants.find((p) => p.golferId === row.golferId)?.name ?? row.golferId;
            return (
              <li key={row.golferId} className="text-sm text-slate-300">
                {name} —{" "}
                {row.kind === "complete"
                  ? `AGS ${row.ags}, differential ${row.differential.toFixed(1)}`
                  : // unrated-courses arc: an unrated round still has an AGS, it just isn't posted to a
                    // handicap (no rating/slope → no differential). Naming it "unrated (not posted)" keeps
                    // it distinct from a genuinely undecided card, which stays "incomplete".
                    row.kind === "unrated"
                    ? `AGS ${row.ags} · unrated (not posted)`
                    : "incomplete"}
              </li>
            );
          })}
        </ul>
      </div>

      <div>
        <h2 className="text-lg font-semibold">Final card</h2>
        <StandingsHeader state={state} games={games} activeGameId={activeGame?.id} onSelect={setActiveGameId} />
        {/* recordScore is never called — readOnly disables every cell's tap natively (no pad
            ever opens), matching the brief's "the archived card... entry locked". */}
        <ScorecardGrid state={state} activeGame={activeGame} recordScore={() => {}} readOnly />
      </div>
    </section>
  );
}
