import type { Hole } from "@swng/domain";
import type { HoleResult, Participant } from "@swng/domain";
import { btnDanger, btnSecondary, cardBox } from "../ui/classes";

// "Par-first" so the values a golfer is most likely to have shot are the closest tap targets
// — distance-from-par ascending, ties (equidistant above/below) broken toward the lower value.
// Exported for its own direct test (product.md §9's "par±window" contract) rather than only
// asserted indirectly through ScorePad's rendered button order.
// Capped at 12, not the wire schema's unbounded gross score: gross 10-12 are routine for a
// high-handicap golfer on a hard hole, so they must be one tap away like any other value, but
// 12 is a pragmatic v1 UI cap — a triple-digit-adjacent score is rare enough, and a genuinely
// worse hole is picked-up/conceded territory, not a bigger button grid.
export const orderedStrokeValues = (par: number): readonly number[] => {
  const values = Array.from({ length: 12 }, (_, index) => index + 1);
  return values.sort((a, b) => Math.abs(a - par) - Math.abs(b - par) || a - b);
};

export interface ScorePadProps {
  readonly golfer: Participant;
  readonly hole: Hole;
  // The tapped cell's current result, if any (round/state.ts's cellAt — never a raw
  // state.cells[...] read at the call site). Gates the `Clear score` button below: undefined
  // (an unscored cell) means there's nothing to clear, so the button doesn't render at all.
  readonly current?: HoleResult;
  readonly onSubmit: (result: HoleResult) => void;
  readonly onCancel: () => void;
}

// The two-tap bottom sheet (product.md §9): every button here posts and closes in one tap —
// there is no separate confirm step. `Clear selection` is the only button that does NOT call
// onSubmit — it exists purely to back out without posting anything.
export function ScorePad({ golfer, hole, current, onSubmit, onCancel }: ScorePadProps) {
  const values = orderedStrokeValues(hole.par);

  const valueButtonClass = `${cardBox} flex min-h-14 min-w-14 items-center justify-center px-3 text-lg font-semibold text-forest active:bg-goldwash`;
  // Picked up / Conceded: same cardBox square, oxblood ink — a distinct action from a plain
  // numeric score, never the numeral color.
  const specialButtonClass = `${cardBox} flex min-h-14 min-w-20 items-center justify-center px-3 text-base font-semibold text-oxblood active:bg-goldwash`;

  return (
    <div role="dialog" aria-label={`Score for ${golfer.name}, hole ${hole.number}`} className="fixed inset-x-0 bottom-0 z-50 flex flex-col gap-3 border-t-2 border-forest bg-card p-4 shadow-2xl">
      <p className="text-center text-sm text-fairway">
        {golfer.name} — hole {hole.number} · par {hole.par}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {values.map((value) => (
          <button key={value} type="button" className={valueButtonClass} onClick={() => onSubmit({ kind: "strokes", strokes: value })}>
            {value}
          </button>
        ))}
        <button type="button" className={specialButtonClass} onClick={() => onSubmit({ kind: "picked-up" })}>
          Picked up
        </button>
        <button type="button" className={specialButtonClass} onClick={() => onSubmit({ kind: "conceded" })}>
          Conceded
        </button>
        {current !== undefined && (
          <button type="button" className={`${btnDanger} min-h-14 min-w-20`} onClick={() => onSubmit({ kind: "cleared" })}>
            Clear score
          </button>
        )}
      </div>
      <button type="button" className={`${btnSecondary} min-h-14`} onClick={onCancel}>
        Clear selection
      </button>
    </div>
  );
}
