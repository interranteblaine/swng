import type { ReactNode } from "react";
import { Link } from "react-router";
import type { BestRound, GolferMetrics, GolferRoundLine, IndexPoint, Milestone, MilestoneKind, RoundId } from "@swng/domain";
import { formatCourseHandicap, formatHandicapIndex } from "@swng/domain";
import { cardBox, linkEntity } from "../ui/classes";
import { useContainerWidth } from "../ui/useContainerWidth";
import { vsPar } from "../ui/vsPar";

// "Your index over time" (index-chart-polish spec, following the metrics-projection-grows /
// papercut-17 chart this rewrites) — a dependency-free inline SVG (no chart lib: two polylines
// plus per-round markers). `points` is the served metrics projection's own `indexHistory`
// (domain/golfer/metrics.ts's golferMetrics) — one point per round, oldest → newest, each
// carrying the golfer's swng/WHS index AS OF that round; DRAWN is capped to the last
// INDEX_CHART_WINDOW rounds (spec §1.1, the WHS Rule 5.2a window) — a VIEW, not a shorter fold,
// since every point still folds every round before it. Geometry is presentation math, never golf
// compute: `yBounds`/`ticksFor` (spec §1.2) pick a "nice" whole-index axis with a min-span
// honesty rule (a tight cluster of values is padded to a real 4-point span before rounding, so a
// flat week of golf doesn't draw a misleadingly dramatic slope), and tick labels render through
// `formatCourseHandicap` — the model's one integer plus-convention formatter, so a tick below
// scratch reads "+2", never a bare "-2". The svg is FLUID (spec §1.4, `useContainerWidth`) — it
// renders at the column's real CSS-pixel width, no card frame (the chart sits directly on the
// page). The last point of each series draws larger (endpoint emphasis), and the axis anchors the
// first/last DRAWN round's date at the bottom corners (spec §1.6 — a render JOIN against
// `history`, `createdAt` preferred over `finalizedAt`, shown only when BOTH ends have a date, the
// year appended only when the two ends cross a year boundary). This component still never derives
// index math — it renders what the wire already computed. Below INDEX_HISTORY_MIN_ROUNDS rounds
// the chart is GATED, not drawn — a 1-3 point sparkline is noise, not a trend (the exact defect
// the original redesign replaced: the OLD page plotted an unlabeled score-differential line from
// round one).
const INDEX_HISTORY_MIN_ROUNDS = 8;
const INDEX_CHART_WINDOW = 20; // the WHS window (Rule 5.2a) — spec §1.1; slicing is honest: every point folds the whole career before it

// Chart geometry (spec §1.2–§1.4) — presentation math, not golf compute: nice bounds with the
// min-span honesty rule, whole-index ticks, CSS-pixel coordinates.
const yBounds = (values: readonly number[]): { lo: number; hi: number; step: number } => {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < 4) {
    const mid = (hi + lo) / 2;
    lo = mid - 2;
    hi = mid + 2;
  }
  lo = Math.floor(lo);
  hi = Math.ceil(hi);
  const span = hi - lo;
  return { lo, hi, step: span <= 4 ? 1 : span <= 8 ? 2 : 5 };
};
const ticksFor = ({ lo, hi, step }: { lo: number; hi: number; step: number }): readonly number[] => {
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) out.push(t);
  return out;
};

function IndexOverTime({
  points,
  roundsPlayed,
  person,
  history,
}: {
  readonly points: readonly IndexPoint[];
  readonly roundsPlayed: number;
  readonly person: "your" | "their";
  // The render JOIN for anchor dates (spec §1.6) — the same already-fetched response array
  // RecordSections holds (the bests/milestones precedent). GolferRoundLine plus the two OPTIONAL
  // wire fields Task 1 added; a plain GolferRoundLine (missing both) is still structurally
  // assignable here, so RecordSections's own `history` prop type didn't need to change.
  readonly history: readonly (GolferRoundLine & { readonly finalizedAt?: number; readonly createdAt?: number })[];
}) {
  // Person-aware copy (navigation arc review finding: RecordSections rendered second-person text
  // verbatim on GolferPage, addressed to a viewer about someone else's rounds). Mirrors
  // indexSourcePhrase's own "your"/"their" convention (@swng/domain handicap/present.ts). The
  // "their" arm drops the exhortation below the gate ("Keep going.") — a nudge belongs on your
  // own page, not a spectator's.
  const heading = person === "your" ? "Your index over time" : "Their index over time";
  // Called unconditionally, ABOVE the gate's early return (Rules of Hooks) — the gate branch
  // below never mounts the svg, so the measured width goes unused on that path, but the hook
  // itself must run on every render regardless of which branch renders.
  const { ref, width } = useContainerWidth();

  if (roundsPlayed < INDEX_HISTORY_MIN_ROUNDS) {
    return (
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">{heading}</h3>
        <p className="text-sm text-fairway">
          {person === "your"
            ? `Your index history shows up at ${INDEX_HISTORY_MIN_ROUNDS} rounds — you've played ${roundsPlayed}. Keep going.`
            : `Their index history shows up at ${INDEX_HISTORY_MIN_ROUNDS} rounds — they've played ${roundsPlayed}.`}
        </p>
      </div>
    );
  }

  // The drawn window (spec §1.1): the last INDEX_CHART_WINDOW points only — `roundsPlayed` above
  // gates on the FULL career, this slices what's actually plotted.
  const drawn = points.slice(-INDEX_CHART_WINDOW);
  const drawnN = drawn.length;

  // Layout constants (spec §1.2–§1.4), CSS pixels: ML leaves room for tick labels, MB for the
  // date anchors. `width` is the measured column width (useContainerWidth above) — the svg is
  // fluid, never a fixed viewBox rescaled by the browser.
  const ML = 30;
  const MR = 12;
  const MT = 10;
  const MB = 24;
  const height = 150;
  const plotW = width - ML - MR;
  const plotH = height - MT - MB;

  // The SAME drawn index maps to the same x whichever series it belongs to, so the two lines
  // stay comparable; a LOWER index sits LOWER on screen (improving play trends the line down).
  const x = (i: number): number => (drawnN <= 1 ? ML : ML + (i / (drawnN - 1)) * plotW);
  const values = drawn.flatMap((point) => [point.swngIndex, point.whsIndex].filter((value): value is number => value !== undefined));
  const { lo, hi, step } = yBounds(values);
  const ticks = ticksFor({ lo, hi, step });
  const y = (v: number): number => MT + plotH - ((v - lo) / (hi - lo)) * plotH;

  const pointsFor = (key: "swngIndex" | "whsIndex"): readonly { readonly x: number; readonly y: number }[] =>
    drawn
      .map((point, i) => ({ i, value: point[key] }))
      .filter((entry): entry is { i: number; value: number } => entry.value !== undefined)
      .map(({ i, value }) => ({ x: x(i), y: y(value) }));
  const asLine = (pts: readonly { readonly x: number; readonly y: number }[]) => pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  const swngPts = pointsFor("swngIndex");
  const whsPts = pointsFor("whsIndex");
  const swngLine = asLine(swngPts);
  const whsLine = asLine(whsPts);
  const latestSwng = [...drawn].reverse().find((point) => point.swngIndex !== undefined)?.swngIndex;
  const latestWhs = [...drawn].reverse().find((point) => point.whsIndex !== undefined)?.whsIndex;

  // Date anchors (spec §1.6): a render JOIN of the drawn endpoints' roundIds against `history`,
  // createdAt preferred over finalizedAt (the round's own wall-clock start over its finalize
  // time). Both ends must resolve a date, or neither anchor renders — a lone anchor implies a
  // span the chart isn't actually showing.
  const anchorDate = (roundId: RoundId): number | undefined => {
    const row = history.find((line) => line.roundId === roundId);
    return row?.createdAt ?? row?.finalizedAt;
  };
  const firstMs = drawn.length > 0 ? anchorDate(drawn[0]!.roundId) : undefined;
  const lastMs = drawn.length > 0 ? anchorDate(drawn[drawn.length - 1]!.roundId) : undefined;
  const crossYear = firstMs !== undefined && lastMs !== undefined && new Date(firstMs).getFullYear() !== new Date(lastMs).getFullYear();
  const anchorLabel = (ms: number): string =>
    new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(crossYear ? { year: "numeric" } : {}) }).format(new Date(ms));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-base font-semibold">{heading}</h3>
        <span className="text-xs text-fairway/70">
          {person} last {drawnN} round{drawnN === 1 ? "" : "s"}
        </span>
      </div>
      {/* No card frame (spec §1.4) — the chart sits directly on the page, fluid to the column's
          real CSS-pixel width via useContainerWidth (happy-dom has no ResizeObserver, so tests
          see the hook's 320px fallback). */}
      <div ref={ref} className="max-w-xl">
        <svg data-testid="index-chart" role="img" aria-label={heading} viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
          {/* Gridlines + whole-index tick labels (spec §1.2) — formatCourseHandicap is the
              model's own integer plus-convention formatter (a tick below scratch reads "+2"),
              reused here rather than re-deciding the sign convention in this component. */}
          {ticks.map((t) => (
            <g key={`tick-${t}`}>
              <line data-testid="index-gridline" x1={ML} x2={width - MR} y1={y(t)} y2={y(t)} stroke="currentColor" strokeWidth={1} className="text-hairline" />
              <text data-testid="index-tick-label" x={ML - 7} y={y(t)} dominantBaseline="middle" textAnchor="end" fill="currentColor" className="font-mono text-[11px] text-fairway">
                {formatCourseHandicap(t)}
              </text>
            </g>
          ))}
          {whsLine && (
            <polyline
              data-testid="index-line-whs"
              aria-label="WHS index"
              points={whsLine}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeDasharray="3 3"
              className="text-fairway"
            />
          )}
          {swngLine && (
            <polyline data-testid="index-line-swng" aria-label="swng index" points={swngLine} fill="none" stroke="currentColor" strokeWidth={2} className="text-forest" />
          )}
          {/* Per-round markers (● swng filled, ○ WHS hollow) so a single-vertex series stays
              visible: a lone point — e.g. one rated round among unrated play — draws no line, but
              its dot shows. The hollow WHS fill is the cream page color (not "none"), so it reads
              as a punched-out dot rather than a transparent ring over whatever's underneath.
              Endpoint emphasis: the LAST drawn point of each series draws larger. */}
          {whsPts.map((p, i) => (
            <circle
              key={`w${i}`}
              data-testid="index-dot-whs"
              cx={p.x}
              cy={p.y}
              r={i === whsPts.length - 1 ? 4 : 2.5}
              fill="var(--color-cream)"
              stroke="currentColor"
              strokeWidth={1.5}
              className="text-fairway"
            />
          ))}
          {swngPts.map((p, i) => (
            <circle key={`s${i}`} data-testid="index-dot-swng" cx={p.x} cy={p.y} r={i === swngPts.length - 1 ? 4 : 2.5} fill="currentColor" className="text-forest" />
          ))}
          {firstMs !== undefined && lastMs !== undefined && (
            <>
              <text data-testid="index-anchor" x={ML} y={height - 6} textAnchor="start" fill="currentColor" className="font-mono text-[11px] text-fairway">
                {anchorLabel(firstMs)}
              </text>
              <text data-testid="index-anchor" x={width - MR} y={height - 6} textAnchor="end" fill="currentColor" className="font-mono text-[11px] text-fairway">
                {anchorLabel(lastMs)}
              </text>
            </>
          )}
        </svg>
      </div>
      {/* The caption replaces both the old bare "● swng"/"○ WHS" legend row and the old
          value-only summary line — one line, markers AND numbers together. */}
      <p className="text-sm text-fairway">
        ● swng {latestSwng !== undefined ? formatHandicapIndex(latestSwng) : "—"} · ○ WHS {latestWhs !== undefined ? formatHandicapIndex(latestWhs) : "—"}
      </p>
    </div>
  );
}

// Bests + milestones (analytics read-folds spec 2026-07-21 §3): both name a `roundId` only —
// the course name comes from a JOIN against this same response's own `history` (rendering, not
// compute; the domain fold already produced gross/toPar). A `roundId` with no matching history
// row (a corrected fold outrunning a stale card — shouldn't happen in practice) falls back to
// the plain score/label text rather than a crash. `vsPar(best.toPar, 0)` reuses the FILE'S own
// sign convention above: `toPar` already IS a signed relative-to-par delta, so treating it as the
// "ags" against a par of 0 yields the identical "E"/"+n"/"n" formatting, no second sign helper.
const bestLine = (label: string, best: BestRound, history: readonly GolferRoundLine[]): ReactNode => {
  const row = history.find((line) => line.roundId === best.roundId);
  const scoreText = `${label}: ${best.gross} (${vsPar(best.toPar, 0)})`;
  if (!row) return scoreText;
  return (
    <>
      {scoreText} —{" "}
      <Link to={`/rounds/${best.roundId}`} className={linkEntity}>
        {row.courseName}
      </Link>
    </>
  );
};

const MILESTONE_LABELS: Record<MilestoneKind, string> = {
  "first-birdie": "First birdie",
  "first-eagle": "First eagle",
  "broke-100": "Broke 100",
  "broke-90": "Broke 90",
  "broke-80": "Broke 80",
};

const milestoneLine = (milestone: Milestone, history: readonly GolferRoundLine[]): ReactNode => {
  const row = history.find((line) => line.roundId === milestone.roundId);
  const label = MILESTONE_LABELS[milestone.kind];
  if (!row) return label;
  return (
    <>
      {label} —{" "}
      <Link to={`/rounds/${milestone.roundId}`} className={linkEntity}>
        {row.courseName}
      </Link>
    </>
  );
};

// "Your typical 18" (metrics.typicalEighteen — always present, zeroed rather than absent below
// any bootstrap): the career scoring shape normalized to one 18-hole round, so a golfer who
// mostly plays 9s isn't shown a deflated total.
const describeTypicalEighteen = (typical: GolferMetrics["typicalEighteen"]): string => {
  const eaglePrefix = typical.eagles > 0 ? `${typical.eagles} eagle+ · ` : "";
  return `In a typical 18: ${eaglePrefix}${typical.birdies} birdies · ${typical.pars} pars · ${typical.bogeys} bogeys · ${typical.doublePlus} double+`;
};

export interface HistoryListProps {
  readonly history: readonly GolferRoundLine[];
  // Caps the rendered rows to the first N entries (newest-first, per the wire contract — never
  // re-sorted here). Omitted renders every row.
  readonly historyLimit?: number;
}

// The ONE history-row rendering (navigation spec §4b, corrected 2026-07-20 — a history row IS a
// finalized round): ProfilePage/GolferPage use it via RecordSections below; HomePage's own
// "Recent rounds" switchboard section (Task 5) renders it directly, capped to 3, WITHOUT dragging
// in the chart/typical-18 sections below — those only belong on a golfer's full record. Each row
// is ONE whole-row link to the round's own permanent address — tapping anywhere on the row (course
// name included) opens the round; the course stays reachable from the round page's own heading
// link instead (RoundRecordPage), never a second link inside the row.
export function HistoryList({ history, historyLimit }: HistoryListProps) {
  const rows = historyLimit !== undefined ? history.slice(0, historyLimit) : history;

  if (rows.length === 0) return <p className="text-fairway">No rounds yet.</p>;

  return (
    <ul className="flex flex-col gap-1">
      {rows.map((line) => (
        <li key={line.roundId}>
          {/* One row, one link, the whole card — a history row represents a finalized round, so
              tapping anywhere on it goes there, full stop. Score-first (metrics-projection-grows
              spec): the score leads, course/tee follow — a golfer scans results, not metadata.
              `vsPar`/differential are presentation only, no domain compute import. */}
          <Link
            to={`/rounds/${line.roundId}`}
            className={`${cardBox} block px-3 py-2 text-sm text-fairway underline decoration-fairway tabular-nums`}
          >
            {line.courseName} · {line.tee}
            {line.ags !== undefined && ` · ${line.ags} (${vsPar(line.ags, line.par)})`}
            {line.holes === 9 && " · 9 holes"}
            {line.differential !== undefined && ` · ${line.differential.toFixed(1)}`}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export interface RecordSectionsProps {
  readonly metrics: GolferMetrics;
  readonly history: readonly GolferRoundLine[];
  // Caps the rendered HISTORY ROWS to the first N entries (newest-first, per the wire contract —
  // never re-sorted here). The chart/typical-18 above always reflect the FULL career (roundsPlayed
  // is `history.length`, not the capped count) — a limit is a display truncation of the list, not a
  // smaller career. Omitted renders every row (ProfilePage's own contract).
  readonly historyLimit?: number;
  // Who the copy is addressed to — "your" (default, ProfilePage: your own record) or "their"
  // (GolferPage: a signed-in golfer reading someone ELSE's record). Defaults to "your" so
  // ProfilePage's existing render/tests stay byte-identical. Mirrors indexSourcePhrase's own
  // "your"/"their" convention (@swng/domain handicap/present.ts) — the finding this closes: this
  // component previously rendered second-person copy verbatim on GolferPage.
  readonly person?: "your" | "their";
}

// The record sections ProfilePage renders for yourself and GolferPage renders for anyone
// (navigation spec §6c.3) — index-over-time chart, typical 18, history rows — ONE extraction, so
// neither page re-derives a second copy of this presentation.
export function RecordSections({ metrics, history, historyLimit, person = "your" }: RecordSectionsProps) {
  return (
    <>
      <IndexOverTime points={metrics.indexHistory} roundsPlayed={history.length} person={person} history={history} />

      {/* Best rounds + Milestones (analytics read-folds spec 2026-07-21 §3) — render nothing
          when empty (the ledger's own empty-state discipline: no footnote, just absence). */}
      {(metrics.bests.best18 ?? metrics.bests.best9) && (
        <div>
          <h3 className="text-base font-semibold">Best rounds</h3>
          <ul className="flex flex-col gap-1 text-sm text-fairway tabular-nums">
            {metrics.bests.best18 && <li>{bestLine("Best 18", metrics.bests.best18, history)}</li>}
            {metrics.bests.best9 && <li>{bestLine("Best 9", metrics.bests.best9, history)}</li>}
          </ul>
        </div>
      )}
      {metrics.milestones.length > 0 && (
        <div>
          <h3 className="text-base font-semibold">Milestones</h3>
          <ul className="flex flex-col gap-1 text-sm text-fairway">
            {metrics.milestones.map((m) => (
              <li key={m.kind}>{milestoneLine(m, history)}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-sm text-fairway tabular-nums">{describeTypicalEighteen(metrics.typicalEighteen)}</p>

      <div>
        <h3 className="text-base font-semibold">History</h3>
        <HistoryList history={history} historyLimit={historyLimit} />
      </div>
    </>
  );
}
