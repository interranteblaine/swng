import { grossForHoles, netStrokes } from "@swng/client";
import type { GameState, RoundState } from "@swng/domain";
import { GolferLink } from "../ui/GolferLink";
import { canonicalHoles, ScorecardGrid } from "./ScorecardGrid";
import { ShareButton } from "./ShareButton";
import { StandingsHeader } from "./StandingsHeader";

export interface ResultsViewProps {
  readonly state: RoundState; // caller's own contract: only ever rendered once state.status === "final"
  readonly games: readonly GameState[]; // the session's local games() — same domain, same log as any server response
  // M9 Task 3 (share): the caller's OWN participant token, threaded through only so ShareButton
  // can mint a link — OPTIONAL and OMITTED by WatchPage's own reuse of this exact component for
  // a spectator's archived-card view. A spectator holds no participant token (POST .../share is
  // participant-gated) and minting a NEW link isn't something a read-only view offers anyway —
  // leaving this unset is what keeps that reuse edit-affordance-free without a second,
  // spectator-flavored ResultsView.
  readonly shareToken?: string;
}

// U+2212, this codebase's own glyph for a negative number (ScorecardGrid's dots) — never the
// ASCII hyphen a bare number interpolation gives a negative
// value. Strokes and net are the two signed numbers on the Final-totals line and must never wear
// two different minus signs on the same row.
const signedNumber = (n: number): string => (n < 0 ? `−${-n}` : String(n));

// strokes is non-negative by construction (resolveStrokes clamps both arms at zero, spec §2a), so
// there is no give-back case left to render here — no formatter, no grant branch, no plus
// convention. And deliberately NOT `formatOverPar`: this is a strokes count being SUBTRACTED on the
// totals line ("96 −20 76"), not a vs-par figure, so it wears a leading minus where formatOverPar
// would write a plus. Written as `=== 0` rather than `> 0`, deliberately: a negative strokes value would be an
// invariant break (review fix, task-4 fix round 1) — `> 0`'s else-branch would have silently
// rendered it as the plausible-looking "0"; this way it prints the visibly malformed `−${strokes}`
// instead, failing loudly rather than lying quietly.
const strokesLabel = (strokes: number): string => (strokes === 0 ? "0" : `−${strokes}`);

export function ResultsView({ state, games, shareToken }: ResultsViewProps) {
  const holes = canonicalHoles(state.card);
  const parTotal = holes.reduce((sum, hole) => sum + hole.par, 0);

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
            // grossForHoles (@swng/client) is spec §2d's own rule ("a card either has a score or
            // it doesn't") extended to a whole card: undefined the instant ANY hole lacks a
            // decided cell — a pickup, a cleared cell, or a hole nobody ever recorded — never a
            // silent partial sum. The card right below (ScorecardGrid's own TOT row) calls the
            // SAME function, so the two can never print two different numbers for one round
            // (review fix, task-4 fix round 1: printing a partial "gross" here — while the card
            // beneath correctly dashed — was the exact invented-number dishonesty this arc exists
            // to delete).
            const gross = grossForHoles(state.cells, p.golferId, holes);
            return (
              <li key={p.golferId} className="text-sm text-fairway">
                <GolferLink golferId={p.golferId} name={p.name} />
                {gross === undefined ? (
                  " — –"
                ) : (
                  // No fourth "vs par" column: net already ranks each player against their own
                  // stated level (spec §4) — a scratch player's net IS their vs-par number, and a
                  // receiver's net already backed their strokes out, so a separate column would
                  // just repeat what net already says.
                  ` — ${gross} gross · ${strokesLabel(p.strokes)} · ${signedNumber(netStrokes(gross, p.strokes))} net`
                )}
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
