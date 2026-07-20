import { handicappingFor } from "@swng/client";
import type { GameState, RoundState } from "@swng/domain";
import type { FinalizeRoundResponse } from "@swng/contracts";
import { GolferLink } from "../ui/GolferLink";
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

  return (
    <section className="flex flex-col gap-6 p-4">
      <h1 className="text-xl font-bold text-forest">Final results</h1>

      {shareToken && <ShareButton roundId={state.id} token={shareToken} />}

      <div>
        <h2 className="text-lg font-semibold text-forest">Roster</h2>
        <ul aria-label="Roster" className="flex flex-col gap-2">
          {state.participants.map((p) => (
            <li key={p.golferId} className="flex items-center gap-2 text-forest">
              <GolferLink golferId={p.golferId} name={p.name} />
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h2 className="text-lg font-semibold text-forest">Posted to handicaps</h2>
        <ul aria-label="Posted to handicaps" className="flex flex-col gap-1">
          {handicapping.map((row) => {
            const name = state.participants.find((p) => p.golferId === row.golferId)?.name ?? row.golferId;
            return (
              <li key={row.golferId} className="text-sm text-fairway">
                <GolferLink golferId={row.golferId} name={name} />
                {row.kind === "complete"
                  ? ` — adjusted score ${row.ags} · posts ${row.differential.toFixed(1)}`
                  : row.kind === "unrated"
                    ? ` — adjusted score ${row.ags} · unrated course, not posted`
                    : ` — card incomplete, nothing posted`}
              </li>
            );
          })}
        </ul>
      </div>

      <div>
        <h2 className="text-lg font-semibold text-forest">Final card</h2>
        {/* No onTerminate: an archived round is never live, so StandingsHeader's own panels
            render with no End affordance — same reuse contract as before, minus the
            activeGameId/onSelect wiring the game-agnostic card (Task 3) made unnecessary. */}
        <StandingsHeader state={state} games={games} />
        {/* recordScore is never called — readOnly disables every cell's tap natively (no pad
            ever opens), matching the brief's "the archived card... entry locked". */}
        <ScorecardGrid state={state} recordScore={() => {}} readOnly />
      </div>
    </section>
  );
}
