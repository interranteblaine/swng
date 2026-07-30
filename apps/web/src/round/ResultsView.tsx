// cellAt/scoredStrokes are pure structural accessors, not golf compute (the same footing as
// cellKey/findTeeSet — see the ESLint fence's own comment in eslint.config.mjs), so this file
// reads them directly rather than through @swng/client.
import { cellAt, scoredStrokes } from "@swng/domain";
import type { GameState, RosterEntry, RoundState } from "@swng/domain";
import type { FinalizeRoundResponse } from "@swng/contracts";
import { GolferLink } from "../ui/GolferLink";
import { canonicalHoles, ScorecardGrid } from "./ScorecardGrid";
import { ShareButton } from "./ShareButton";
import { StandingsHeader } from "./StandingsHeader";

export interface ResultsViewProps {
  readonly state: RoundState; // caller's own contract: only ever rendered once state.status === "final"
  readonly games: readonly GameState[]; // the session's local games() — same domain, same log as any server response
  // Present only on the tab that itself called finalizeRound (RoundPage's own contract). Kept in
  // the interface for that caller's shape, but no longer read here: "Final totals"/"Final card"
  // below both compute straight off `state`, the same way for every tab, so nothing here ever
  // needed a server-only value to show first (unlike the deleted differential, which had no local
  // GameState equivalent). Left unused rather than deleted — Task 5 removes `handicapping` from
  // the wire entirely, and re-plumbing RoundPage's/WatchPage's own prop is that task's job, not
  // this narrow one.
  readonly response: FinalizeRoundResponse | undefined;
  // M9 Task 3 (share): the caller's OWN participant token, threaded through only so ShareButton
  // can mint a link — OPTIONAL and OMITTED by WatchPage's own reuse of this exact component for
  // a spectator's archived-card view. A spectator holds no participant token (POST .../share is
  // participant-gated) and minting a NEW link isn't something a read-only view offers anyway —
  // leaving this unset is what keeps that reuse edit-affordance-free without a second,
  // spectator-flavored ResultsView.
  readonly shareToken?: string;
}

// strokes is non-negative by construction (resolveStrokes clamps both arms at zero, spec §2a) —
// there is no give-back case left to render here, so this needs no formatter and no grant branch.
// Do NOT reach for formatCourseHandicap: it writes a negative as "+N" (golf's plus-handicap
// convention, a player who GIVES that many), which is exactly backwards for a receiver's own
// strokes count. That convention — and formatCourseHandicap itself — is deleted in Task 5.
const strokesLabel = (strokes: number): string => (strokes > 0 ? `−${strokes}` : "0");

export function ResultsView({ state, games, shareToken }: ResultsViewProps) {
  const holes = canonicalHoles(state.card);
  const parTotal = holes.reduce((sum, hole) => sum + hole.par, 0);

  // Whole-round gross for the headline line below: sums every hole this participant has a
  // decided, scored cell for. scoredStrokes reads a conceded hole exactly like a strokes cell
  // (spec §4) — any other rule would make this line disagree with the same round's own line in
  // the golfer's record, which reads conceded strokes too. A hole with no decided cell (never
  // played, or picked up) contributes nothing; this headline is a summary, not a completeness
  // gate — the full card right below already renders the honest per-segment "–" for anyone whose
  // round isn't fully scored.
  const grossOf = (p: RosterEntry): number =>
    holes.reduce((sum, hole) => {
      const cell = cellAt(state.cells, p.golferId, hole.number);
      return sum + (cell ? (scoredStrokes(cell.result) ?? 0) : 0);
    }, 0);

  return (
    <section className="flex flex-col gap-6 p-4">
      <h1 className="text-xl font-bold text-forest">Final results</h1>

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
        <h2 className="text-lg font-semibold text-forest">Final totals</h2>
        <p className="text-sm text-fairway">Par {parTotal}</p>
        <ul aria-label="Final totals" className="flex flex-col gap-1">
          {state.participants.map((p) => {
            const gross = grossOf(p);
            return (
              <li key={p.golferId} className="text-sm text-fairway">
                <GolferLink golferId={p.golferId} name={p.name} />
                {/* No fourth "vs par" column: net already ranks each player against their own
                    stated level (spec §4) — a scratch player's net IS their vs-par number, and a
                    receiver's net already backed their strokes out, so a separate column would
                    just repeat what net already says. */}
                {` — ${gross} gross · ${strokesLabel(p.strokes)} · ${gross - p.strokes} net`}
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

      {/* Share sits last on results too — same least-used ruling as the live view (spec 2026-07-20 §1). */}
      {shareToken && <ShareButton roundId={state.id} token={shareToken} />}
    </section>
  );
}
