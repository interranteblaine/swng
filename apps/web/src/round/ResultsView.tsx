import { adjustedGrossScore, cellKey, DomainError, findTeeSet, scoreDifferential } from "@swng/domain";
import type { GameState, HoleResult, RoundState } from "@swng/domain";
import type { FinalizeRoundResponse } from "@swng/contracts";
import { describeGame } from "../games/describeGame";
import { ScorecardGrid } from "./ScorecardGrid";

export interface ResultsViewProps {
  readonly state: RoundState; // caller's own contract: only ever rendered once state.status === "final"
  readonly games: readonly GameState[]; // the session's local games() — same domain, same log as any server response
  // Present only on the tab that itself called finalizeRound (RoundPage's own contract) — a
  // tab that only observes the status flip via WS (another participant finalized) never gets
  // one. ResultsView must render fully either way: see the two why-comments below.
  readonly response: FinalizeRoundResponse | undefined;
}

type HandicappingRow = FinalizeRoundResponse["handicapping"][number];

// Mirrors domain/round/archive.ts's private handicappingFor exactly — same exported
// primitives (adjustedGrossScore, scoreDifferential), same holes-undecided -> "incomplete"
// mapping. Not a re-derivation of different math: every input this needs (card, cells,
// participant.tee/courseHandicap) already lives in folded RoundState, so it's the one place
// the "prefer deriving what IS derivable" call (vs. a permanent placeholder) actually applies
// — unlike the per-game results below, there is no local GameState equivalent for a
// differential, so this is the only way a WS-pushed final ever shows one before this tab's
// own finalize response (if it ever calls one) arrives.
const deriveHandicapping = (state: RoundState): readonly HandicappingRow[] =>
  state.participants.map((participant): HandicappingRow => {
    const teeSet = findTeeSet(state.card, participant.tee);
    const holes = new Map<number, HoleResult>();
    for (const hole of teeSet.holes) {
      const recorded = state.cells[cellKey(participant.golferId, hole.number)];
      if (recorded) holes.set(hole.number, recorded.result);
    }
    try {
      const ags = adjustedGrossScore(teeSet, participant.courseHandicap, holes);
      return { golferId: participant.golferId, kind: "complete", ags, differential: scoreDifferential(teeSet, ags) };
    } catch (error) {
      if (error instanceof DomainError && error.code === "holes-undecided") return { golferId: participant.golferId, kind: "incomplete" };
      throw error; // any other failure (e.g. an unknown tee set) is a corrupt round, not a partial card — let it surface
    }
  });

export function ResultsView({ state, games, response }: ResultsViewProps) {
  const handicapping = response?.handicapping ?? deriveHandicapping(state);

  return (
    <section className="flex flex-col gap-6 p-4 text-slate-100">
      <h1 className="text-xl font-bold">Final results</h1>

      <ul className="flex flex-col gap-2">
        {/* Per-game results render from LOCAL games()+describeGame, never response.results
            directly — describeGame is the UI's ONLY kind-switch site (brief), and the
            "agreement" test proves local games() and the finalize response always carry the
            identical numbers (same domain, same log), so there is no second results path to
            keep in sync. response is consulted below for handicapping only — the one field
            genuinely absent from GameState. */}
        {games.map((game) => {
          const { title, line } = describeGame(game, state);
          return (
            <li key={game.id} className="rounded-lg bg-slate-900 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</p>
              <p className="text-base font-medium">{line}</p>
            </li>
          );
        })}
      </ul>

      <div>
        <h2 className="text-lg font-semibold">Handicap differentials</h2>
        <ul className="flex flex-col gap-1">
          {handicapping.map((row) => {
            const name = state.participants.find((p) => p.golferId === row.golferId)?.name ?? row.golferId;
            return (
              <li key={row.golferId} className="text-sm text-slate-300">
                {name} — {row.kind === "complete" ? `AGS ${row.ags}, differential ${row.differential.toFixed(1)}` : "incomplete"}
              </li>
            );
          })}
        </ul>
      </div>

      <div>
        <h2 className="text-lg font-semibold">Final card</h2>
        {/* recordScore is never called — readOnly disables every cell's tap natively (no pad
            ever opens), matching the brief's "the archived card... entry locked". */}
        <ScorecardGrid state={state} activeGame={games[0]} recordScore={() => {}} readOnly />
      </div>
    </section>
  );
}
