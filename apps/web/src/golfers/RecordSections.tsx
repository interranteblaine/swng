import type { ReactNode } from "react";
import { Link } from "react-router";
import type { AveragePoint, BestRound, GolferMetrics, GolferRoundLine, Milestone, MilestoneKind, RoundId } from "@swng/domain";
import { formatOverPar } from "@swng/domain";
import { nineHoleContribution } from "@swng/client";
import { cardBox, linkEntity } from "../ui/classes";
import { useContainerWidth } from "../ui/useContainerWidth";

// "Your average over time" (spec 2026-07-29 §5, keeping the index-chart-polish geometry the
// two-line index chart it replaces already had) — a dependency-free inline SVG (no chart lib: ONE
// polyline plus per-round markers). `points` is the served metrics projection's own
// `averageHistory` (domain/golfer/metrics.ts's golferMetrics) — one point per CONTRIBUTING round,
// oldest → newest, each the golfer's rolling average AS OF that round; a round with a pickup has
// no score and so is not a data point at all. DRAWN is capped to the last AVERAGE_CHART_WINDOW
// rounds — a VIEW, not a shorter fold, since every point still folds every round before it.
// Geometry is presentation math, never golf compute: `yBounds`/`ticksFor` pick a "nice" whole-number
// axis with a min-span honesty rule (a tight cluster of values is padded to a real 4-point span
// before rounding, so a flat month of golf doesn't draw a misleadingly dramatic slope), and tick
// labels render through `formatOverPar` — the ONE vs-par renderer (spec §4), so a tick below par
// reads "-2" and one above reads "+26". (That FLIPS the old chart's sign rendering, which used the
// plus-handicap convention: a tick at -2 on an average chart means two under par, not a plus-2
// handicap.) The svg is FLUID (`useContainerWidth`) — it renders at the column's real CSS-pixel
// width, no card frame (the chart sits directly on the page). The last point draws larger
// (endpoint emphasis), and the axis anchors the first/last DRAWN round's date at the bottom
// corners (a render JOIN against `history`, `createdAt` preferred over `finalizedAt`, shown only
// when BOTH ends have a date, the year appended only when the two ends cross a year boundary).
// This component derives no golf result — it renders what the wire already computed. Below
// AVERAGE_HISTORY_MIN_ROUNDS rounds the chart is GATED, not drawn — a 1-3 point sparkline is
// noise, not a trend. A second gate covers the case the first one misses: 8+ rounds played but
// NO contributing round (every one contains a pickup), which would otherwise reach the plot as an
// empty series and draw a blank svg with no reason given.
const AVERAGE_HISTORY_MIN_ROUNDS = 8;
const AVERAGE_CHART_WINDOW = 20; // slicing is honest: every point folds the whole career before it

// Chart geometry — presentation math, not golf compute: nice bounds with the min-span honesty
// rule, whole-number ticks, CSS-pixel coordinates.
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

function AverageOverTime({
  points,
  roundsPlayed,
  person,
  history,
}: {
  readonly points: readonly AveragePoint[];
  readonly roundsPlayed: number;
  readonly person: "your" | "their";
  // The render JOIN for anchor dates — the same already-fetched response array RecordSections
  // holds (the bests/milestones precedent). GolferRoundLine plus the two OPTIONAL wire fields; a
  // plain GolferRoundLine (missing both) is still structurally assignable here, so
  // RecordSections's own `history` prop type doesn't need to change.
  readonly history: readonly (GolferRoundLine & { readonly finalizedAt?: number; readonly createdAt?: number })[];
}) {
  // Person-aware copy (navigation arc review finding: RecordSections rendered second-person text
  // verbatim on GolferPage, addressed to a viewer about someone else's rounds). The "their" arm
  // drops the exhortation below the gate ("Keep going.") — a nudge belongs on your own page, not a
  // spectator's.
  const heading = person === "your" ? "Your average over time" : "Their average over time";
  // Called unconditionally, ABOVE the gate's early return (Rules of Hooks) — the gate branch
  // below never mounts the svg, so the measured width goes unused on that path, but the hook
  // itself must run on every render regardless of which branch renders.
  const { ref, width } = useContainerWidth();

  if (roundsPlayed < AVERAGE_HISTORY_MIN_ROUNDS) {
    return (
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">{heading}</h3>
        <p className="text-sm text-fairway">
          {person === "your"
            ? `Your average over time shows up at ${AVERAGE_HISTORY_MIN_ROUNDS} rounds — you've played ${roundsPlayed}. Keep going.`
            : `Their average over time shows up at ${AVERAGE_HISTORY_MIN_ROUNDS} rounds — they've played ${roundsPlayed}.`}
        </p>
      </div>
    );
  }

  // The gate above counts ROUNDS PLAYED; this one counts POINTS. They come apart for a golfer
  // whose every round contains a pickup — 8+ rounds, no scored one, so `averageHistory` is empty
  // (spec §5: a round with a pickup is not a data point). Without this branch an empty series
  // reached the plot and drew a heading, an empty svg and "your last 0 rounds": no crash, no NaN,
  // but nothing said WHY the chart was blank. Same register as the under-8 gate — say the honest
  // reason.
  if (points.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">{heading}</h3>
        <p className="text-sm text-fairway">No rounds with a score yet — a round needs every hole scored to plot a point.</p>
      </div>
    );
  }

  // The drawn window: the last AVERAGE_CHART_WINDOW points only — `roundsPlayed` above gates on
  // the FULL career, this slices what's actually plotted.
  const drawn = points.slice(-AVERAGE_CHART_WINDOW);
  const drawnN = drawn.length;

  // Layout constants, CSS pixels: ML leaves room for tick labels, MB for the date anchors.
  // `width` is the measured column width (useContainerWidth above) — the svg is fluid, never a
  // fixed viewBox rescaled by the browser.
  const ML = 30;
  const MR = 12;
  const MT = 10;
  const MB = 24;
  const height = 150;
  const plotW = width - ML - MR;
  const plotH = height - MT - MB;

  // A LOWER average sits LOWER on screen (improving play trends the line down).
  const x = (i: number): number => (drawnN <= 1 ? ML : ML + (i / (drawnN - 1)) * plotW);
  const values = drawn.map((point) => point.average);
  const { lo, hi, step } = yBounds(values);
  const ticks = ticksFor({ lo, hi, step });
  const y = (v: number): number => MT + plotH - ((v - lo) / (hi - lo)) * plotH;

  const plotted = drawn.map((point, i) => ({ x: x(i), y: y(point.average) }));
  const line = plotted.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  // Date anchors: a render JOIN of the drawn endpoints' roundIds against `history`, createdAt
  // preferred over finalizedAt (the round's own wall-clock start over its finalize time). Both
  // ends must resolve a date, or neither anchor renders — a lone anchor implies a span the chart
  // isn't actually showing.
  const anchorDate = (roundId: RoundId): number | undefined => {
    const row = history.find((entry) => entry.roundId === roundId);
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
      {/* No card frame — the chart sits directly on the page, fluid to the column's real
          CSS-pixel width via useContainerWidth (happy-dom has no ResizeObserver, so tests see the
          hook's 320px fallback). */}
      <div ref={ref} className="max-w-xl">
        <svg data-testid="average-chart" role="img" aria-label={heading} viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
          {/* Gridlines + whole-number tick labels — formatOverPar is the ONE vs-par renderer
              (spec §4), reused here rather than re-deciding the sign convention in this component. */}
          {ticks.map((t) => (
            <g key={`tick-${t}`}>
              <line data-testid="average-gridline" x1={ML} x2={width - MR} y1={y(t)} y2={y(t)} stroke="currentColor" strokeWidth={1} className="text-hairline" />
              <text data-testid="average-tick-label" x={ML - 7} y={y(t)} dominantBaseline="middle" textAnchor="end" fill="currentColor" className="font-mono text-[11px] text-fairway">
                {formatOverPar(t)}
              </text>
            </g>
          ))}
          {line && <polyline data-testid="average-line" aria-label="average" points={line} fill="none" stroke="currentColor" strokeWidth={2} className="text-forest" />}
          {/* Per-round markers so a single-point series stays visible: one point draws no line, but
              its dot shows. Endpoint emphasis: the LAST drawn point draws larger — it IS the number
              the headline names. */}
          {plotted.map((p, i) => (
            <circle key={`p${i}`} data-testid="average-dot" cx={p.x} cy={p.y} r={i === plotted.length - 1 ? 4 : 2.5} fill="currentColor" className="text-forest" />
          ))}
          {firstMs !== undefined && lastMs !== undefined && (
            <>
              <text data-testid="average-anchor" x={ML} y={height - 6} textAnchor="start" fill="currentColor" className="font-mono text-[11px] text-fairway">
                {anchorLabel(firstMs)}
              </text>
              <text data-testid="average-anchor" x={width - MR} y={height - 6} textAnchor="end" fill="currentColor" className="font-mono text-[11px] text-fairway">
                {anchorLabel(lastMs)}
              </text>
            </>
          )}
        </svg>
      </div>
    </div>
  );
}

// Bests + milestones (analytics read-folds spec 2026-07-21 §3): both name a `roundId` only —
// the course name comes from a JOIN against this same response's own `history` (rendering, not
// compute; the domain fold already produced gross/toPar). A `roundId` with no matching history
// row (a corrected fold outrunning a stale card — shouldn't happen in practice) falls back to
// the plain score/label text rather than a crash. `toPar` already IS a signed vs-par delta, so it
// renders straight through `formatOverPar` — the ONE renderer for every signed number on screen.
const bestLine = (label: string, best: BestRound, history: readonly GolferRoundLine[]): ReactNode => {
  const row = history.find((line) => line.roundId === best.roundId);
  const scoreText = `${label}: ${best.gross} (${formatOverPar(best.toPar)})`;
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
              tapping anywhere on it goes there, full stop. The score and its vs-par figure are the
              row's own numbers (spec 2026-07-29 §5: ten rows and one headline, and you can add
              them up yourself), so no extra column is needed — the subtraction is already on
              screen. A round with a pickup carries no `score` and shows none; the differential
              column is gone with the index.

              A NINE states what it CONTRIBUTES, in spec §5's own register
              ("52 +16 (9 holes, counts +32)"). That is not decoration: the headline averages a nine
              DOUBLED (spec §2d), so a row showing only its un-doubled +16 would make the subtitle's
              whole promise — add the rows up and check the number — silently fail to reconcile for
              anyone who plays nines. The `· 9 holes` marker alone does not carry the missing
              information; the doubled figure does. `score - par` is presentation arithmetic over
              two served numbers (the same figures the served average was folded from), and
              `formatOverPar` is a formatter — but the DOUBLING is a model rule (spec §2d, same one
              `golfer/average.ts`'s `overPar` applies), so it runs through `nineHoleContribution`
              from @swng/client rather than being re-derived here as a second `* 2` (task 5: this
              was exactly that second copy, closed). */}
          <Link
            to={`/rounds/${line.roundId}`}
            className={`${cardBox} block px-3 py-2 text-sm text-fairway underline decoration-fairway tabular-nums`}
          >
            {line.courseName} · {line.tee}
            {line.score !== undefined && ` · ${line.score} (${formatOverPar(line.score - line.par)})`}
            {line.holes === 9 &&
              (line.score !== undefined ? ` · 9 holes, counts ${formatOverPar(nineHoleContribution(line.score - line.par))}` : " · 9 holes")}
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
  // ProfilePage's existing render/tests stay byte-identical. Mirrors the "your"/"their" convention
  // the deleted indexSourcePhrase established (@swng/domain handicap/present.ts, gone with the
  // index — the convention outlived the function) — the finding this closes: this component
  // previously rendered second-person copy verbatim on GolferPage.
  readonly person?: "your" | "their";
}

// The record sections ProfilePage renders for yourself and GolferPage renders for anyone
// (navigation spec §6c.3) — the headline average, the average-over-time chart, typical 18, history
// rows — ONE extraction, so neither page re-derives a second copy of this presentation.
export function RecordSections({ metrics, history, historyLimit, person = "your" }: RecordSectionsProps) {
  return (
    <>
      {/* The headline (spec 2026-07-29 §5): ONE number, what the golfer normally shoots relative
          to par, with the sentence that says exactly how it was arrived at — so it can be checked
          against the rows below by hand. `—` when there is no scored round yet: absent is the
          honest answer, never a 0 and never a guess.

          The subtitle names the set that is actually averaged: `averageOf` is
          `scoredOverPar(lines).slice(-10)`, so it is the last ten rounds WITH A SCORE, not the last
          ten rounds full stop (spec §2d — a round containing a pickup has no score and does not
          feed it). §5's mock said "finished rounds", which for a golfer with pickups names a
          different ten rows than the ones summed, and quietly breaks §5's own "you can add them up
          yourself" promise; the spec carries a dated correction. This wording stays checkable
          against the rows below, because a row with a pickup shows no score at all. */}
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-base font-semibold">{person === "your" ? "What you shoot" : "What they shoot"}</h3>
          <span className="text-3xl font-bold tabular-nums">{metrics.average !== undefined ? formatOverPar(metrics.average) : "—"}</span>
        </div>
        <p className="text-sm text-fairway">
          {person === "your" ? "your last 10 rounds with every hole scored, score minus par" : "their last 10 rounds with every hole scored, score minus par"}
        </p>
      </div>

      <AverageOverTime points={metrics.averageHistory} roundsPlayed={history.length} person={person} history={history} />

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
