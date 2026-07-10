// The hole-count toggle + hole grid, extracted out of AddCoursePage (M7 Task 7, papercut 2)
// so EditCoursePage (I2) pre-fills and validates against the exact same code, not a second
// hand-copy that could drift (engineering-conventions §0: second instance → extract). Both
// pages own their own `holes`/`holeCount` state (this component is fully controlled) and
// call the parse/validate helpers below to gate their own submit buttons — this file owns
// the grid's rendering AND its parsing rules, never a form's surrounding fields (name, tee
// name, rating, slope stay page-owned; they differ between add and edit).

export type HoleCount = 9 | 18;

export interface HoleInput {
  readonly par: string;
  readonly yardage: string;
  readonly strokeIndex: string;
}

export interface ParsedHole {
  readonly number: number;
  readonly par: number;
  readonly yardage: number;
  readonly strokeIndex: number;
}

// Par defaults to 4 (brief) — the modal case on a real card, so a golfer typing straight down
// the grid only has to touch the pars that DIFFER from 4. Yardage/strokeIndex start blank:
// there's no sane default for either (strokeIndex especially — see the "never auto-assign"
// comment below).
export const defaultHoles = (count: HoleCount): readonly HoleInput[] => Array.from({ length: count }, () => ({ par: "4", yardage: "", strokeIndex: "" }));

export const parseHoles = (holes: readonly HoleInput[]): readonly ParsedHole[] =>
  holes.map((hole, index) => ({
    number: index + 1,
    par: Number.parseInt(hole.par, 10),
    yardage: Number.parseInt(hole.yardage, 10),
    strokeIndex: Number.parseInt(hole.strokeIndex, 10),
  }));

// Form-completeness gating only (every existing page's own "is this even parseable" guard,
// e.g. CreateRoundPage's courseHandicap check) — NOT a re-implementation of domain's bounds/
// permutation rules (rating 30..90, slope 55..155, SI a permutation, ...). Those live once,
// in course.ts, and reach the golfer via the server's own coded rejection.
export const holesAreComplete = (parsed: readonly ParsedHole[]): boolean =>
  parsed.every((hole) => Number.isInteger(hole.par) && Number.isInteger(hole.yardage) && Number.isInteger(hole.strokeIndex));

export interface HoleGridProps {
  readonly holeCount: HoleCount;
  readonly onChangeHoleCount: (count: HoleCount) => void;
  readonly holes: readonly HoleInput[];
  readonly onChangeHole: (index: number, patch: Partial<HoleInput>) => void;
  // The "holes" field's own server-coded error (FIELD_FOR_CODE mapping stays page-owned,
  // since the code vocabulary differs slightly between create and revise) — rendered as a
  // single alert under the grid, matching every other field's own error slot.
  readonly error?: string;
}

// The keyboard-first, single-screen hole grid (M6 Task 5, reworked M7 Task 7): tab order runs
// left-to-right top-to-bottom (par, yardage, SI per row) purely from DOM order — no explicit
// tabIndex plumbing — with a visible sticky header row over it (papercut 2: the column order
// previously lived ONLY in aria-labels, so a sighted golfer saw three unlabeled boxes).
export function HoleGrid({ holeCount, onChangeHoleCount, holes, onChangeHole, error }: HoleGridProps) {
  // The unused indexes, as a HINT only — never written back into a hole's own field. Typos in
  // stroke index poison every game's dot allocation for the life of the course, so the one
  // thing this grid must never do is guess: the golfer types exactly what the paper card says,
  // this just tells them what's left to place.
  const usedStrokeIndexes = new Set(holes.map((h) => h.strokeIndex).filter((v) => v !== ""));
  const remainingStrokeIndexes = Array.from({ length: holeCount }, (_, i) => i + 1).filter((n) => !usedStrokeIndexes.has(String(n)));

  // Every column shares one template: a narrow fixed hole-number column, then three equal
  // data columns. `minmax(0,1fr)`, never bare `1fr` (papercut 2's grid blowout) — a bare `1fr`
  // track's default min-width is `auto`, i.e. the widest item's own content size, and a text
  // input's intrinsic width is wider than a quarter of a 375px card; `minmax(0,1fr)` overrides
  // that floor to 0 so the track actually shrinks to the card instead of riding onto the page
  // background outside it.
  const gridCols = "grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]";

  return (
    <div className="flex flex-col gap-2">
      <fieldset role="radiogroup" aria-label="Holes" className="flex gap-4">
        {([9, 18] as const).map((count) => (
          <label key={count} className="flex items-center gap-2">
            <input type="radio" name="holeCount" checked={holeCount === count} onChange={() => onChangeHoleCount(count)} className="h-5 w-5" />
            {count}
          </label>
        ))}
      </fieldset>

      <p aria-label="Stroke index remaining" className="text-xs text-slate-400">
        SI remaining: {remainingStrokeIndexes.length > 0 ? remainingStrokeIndexes.join(", ") : "none"}
      </p>
      {/* Plain-language SI explainer (papercut 2): "SI" alone is jargon a golfer has to already
          know — most US scorecards print this row as "Handicap"/"HDCP". A typo here poisons
          every game's dot allocation for the life of the course, so this line says both what
          it is and why exactness matters, rather than assuming the "SI remaining" hint above
          is self-explanatory. */}
      <p className="text-xs text-slate-400">SI = the Handicap/HDCP row on your scorecard — 1 is the hardest hole. Type it exactly as printed.</p>

      <div className="overflow-hidden rounded-lg border border-slate-800" data-testid="hole-grid-card">
        <div
          className={`grid ${gridCols} sticky top-0 z-10 gap-2 bg-slate-900 px-2 py-1 text-xs font-semibold text-slate-400`}
          data-testid="hole-grid-header"
        >
          <span>Hole</span>
          <span>Par</span>
          <span>Yards</span>
          <span>SI</span>
        </div>
        <div className="flex flex-col gap-1 p-2">
          {holes.map((hole, index) => {
            const n = index + 1;
            return (
              <div key={n} className={`grid ${gridCols} items-center gap-2`} data-testid="hole-row">
                <span className="text-sm text-slate-400">{n}</span>
                <input
                  aria-label={`Hole ${n} par`}
                  value={hole.par}
                  onChange={(event) => onChangeHole(index, { par: event.target.value })}
                  inputMode="numeric"
                  className="w-full min-w-0 rounded-md bg-slate-800 p-2 text-center"
                />
                <input
                  aria-label={`Hole ${n} yardage`}
                  value={hole.yardage}
                  onChange={(event) => onChangeHole(index, { yardage: event.target.value })}
                  inputMode="numeric"
                  className="w-full min-w-0 rounded-md bg-slate-800 p-2 text-center"
                />
                <input
                  aria-label={`Hole ${n} stroke index`}
                  value={hole.strokeIndex}
                  onChange={(event) => onChangeHole(index, { strokeIndex: event.target.value })}
                  inputMode="numeric"
                  className="w-full min-w-0 rounded-md bg-slate-800 p-2 text-center"
                />
              </div>
            );
          })}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
