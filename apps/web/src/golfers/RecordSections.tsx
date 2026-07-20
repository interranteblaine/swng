import { Link } from "react-router";
import type { GolferMetrics, GolferRoundLine, IndexPoint } from "@swng/domain";
import { formatHandicapIndex } from "@swng/domain";
import { cardBox } from "../ui/classes";

// "Your index over time" (metrics-projection-grows spec, papercut 17's follow-on) — a
// dependency-free inline SVG (no chart lib needed: two plain polylines are enough to show
// swng drifting under/over WHS). `points` is the served metrics projection's own `indexHistory`
// (domain/golfer/metrics.ts's golferMetrics) — one point per round, oldest → newest, each
// carrying the golfer's swng/WHS index AS OF that round; this component only renders it, it
// never derives index math (SVG coordinate placement is presentation, not golf compute). Below
// INDEX_HISTORY_MIN_ROUNDS rounds the chart is GATED, not drawn — a 1-3 point sparkline is noise,
// not a trend (the exact defect this redesign replaces: the OLD page plotted an unlabeled
// score-differential line from round one).
const INDEX_HISTORY_MIN_ROUNDS = 8;

function IndexOverTime({ points, roundsPlayed }: { readonly points: readonly IndexPoint[]; readonly roundsPlayed: number }) {
  if (roundsPlayed < INDEX_HISTORY_MIN_ROUNDS) {
    return (
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">Your index over time</h3>
        <p className="text-sm text-fairway">
          {`Your index history shows up at ${INDEX_HISTORY_MIN_ROUNDS} rounds — you've played ${roundsPlayed}. Keep going.`}
        </p>
      </div>
    );
  }

  const width = 280;
  const height = 96;
  const n = points.length;
  const values = points.flatMap((point) => [point.swngIndex, point.whsIndex].filter((value): value is number => value !== undefined));
  const min = Math.min(...values);
  const max = Math.max(...values);

  // The SAME point index maps to the same x whichever series it belongs to, so the two lines
  // stay comparable; a LOWER index sits LOWER on screen (improving play trends the line down).
  const pointsFor = (key: "swngIndex" | "whsIndex"): readonly { readonly x: number; readonly y: number }[] =>
    points
      .map((point, i) => ({ i, value: point[key] }))
      .filter((entry): entry is { i: number; value: number } => entry.value !== undefined)
      .map(({ i, value }) => ({
        x: n <= 1 ? 0 : (i / (n - 1)) * width,
        y: max === min ? height / 2 : height - ((value - min) / (max - min)) * height,
      }));
  const asLine = (pts: readonly { readonly x: number; readonly y: number }[]) => pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  const swngPts = pointsFor("swngIndex");
  const whsPts = pointsFor("whsIndex");
  const swngLine = asLine(swngPts);
  const whsLine = asLine(whsPts);
  const latestSwng = [...points].reverse().find((point) => point.swngIndex !== undefined)?.swngIndex;
  const latestWhs = [...points].reverse().find((point) => point.whsIndex !== undefined)?.whsIndex;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-base font-semibold">Your index over time</h3>
        <span className="text-xs text-fairway/70">
          your last {n} round{n === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex items-center gap-3 text-xs text-fairway">
        <span>● swng</span>
        <span>○ WHS</span>
      </div>
      <svg
        data-testid="index-chart"
        role="img"
        aria-label="Your index over time"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className={cardBox}
      >
        {swngLine && (
          <polyline data-testid="index-line-swng" aria-label="swng index" points={swngLine} fill="none" stroke="currentColor" strokeWidth={2} className="text-forest" />
        )}
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
        {/* Per-round markers (● swng filled, ○ WHS hollow) so a single-vertex series stays visible:
            a lone point — e.g. one rated round among unrated play — draws no line, but its dot shows. */}
        {swngPts.map((p, i) => (
          <circle key={`s${i}`} data-testid="index-dot-swng" cx={p.x} cy={p.y} r={2.5} fill="currentColor" className="text-forest" />
        ))}
        {whsPts.map((p, i) => (
          <circle key={`w${i}`} data-testid="index-dot-whs" cx={p.x} cy={p.y} r={2.5} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-fairway" />
        ))}
      </svg>
      <p className="text-sm text-fairway">
        swng {latestSwng !== undefined ? formatHandicapIndex(latestSwng) : "—"} · WHS {latestWhs !== undefined ? formatHandicapIndex(latestWhs) : "—"}
      </p>
    </div>
  );
}

// Local presentation-only helpers for the record section below — arithmetic view logic over
// numbers the wire already computed (ags − par; a literal join of already-summed typicalEighteen
// buckets), never golf rules, so no `@swng/domain` compute import is warranted (the ESLint
// compute fence stays clean).
const vsPar = (ags: number, par: number): string => {
  const d = ags - par;
  return d === 0 ? "E" : d > 0 ? `+${d}` : `${d}`;
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

// The ONE history-row rendering (navigation spec §4b): ProfilePage/GolferPage use it via
// RecordSections below; HomePage's own "Recent rounds" switchboard section (Task 5) renders it
// directly, capped to 3, WITHOUT dragging in the chart/typical-18 sections below — those only
// belong on a golfer's full record. Rows are TWO SIBLING links, never nested: the course name
// (when `courseId` is present — absent renders plain text, never a dead link) opens the course
// page; the score/remainder opens the round's own permanent address.
export function HistoryList({ history, historyLimit }: HistoryListProps) {
  const rows = historyLimit !== undefined ? history.slice(0, historyLimit) : history;

  if (rows.length === 0) return <p className="text-fairway">No rounds yet.</p>;

  return (
    <ul className="flex flex-col gap-1">
      {rows.map((line) => (
        <li key={line.roundId}>
          {/* Two sibling links, never nested — the course name (when courseId is known) opens
              the course page; the score/remainder opens the round. Score-first
              (metrics-projection-grows spec): the score leads, course/tee follow — a golfer
              scans results, not metadata. `vsPar`/differential are presentation only, no
              domain compute import. */}
          <div className={`${cardBox} block px-3 py-2 text-sm text-fairway tabular-nums`}>
            {line.courseId ? (
              <Link to={`/courses/${line.courseId}`} className="underline decoration-fairway">
                {line.courseName}
              </Link>
            ) : (
              <span>{line.courseName}</span>
            )}{" "}
            <Link to={`/rounds/${line.roundId}`} className="underline decoration-fairway">
              · {line.tee}
              {line.ags !== undefined && ` · ${line.ags} (${vsPar(line.ags, line.par)})`}
              {line.holes === 9 && " · 9 holes"}
              {line.differential !== undefined && ` · ${line.differential.toFixed(1)}`}
            </Link>
          </div>
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
}

// The record sections ProfilePage renders for yourself and GolferPage renders for anyone
// (navigation spec §6c.3) — index-over-time chart, typical 18, history rows — ONE extraction, so
// neither page re-derives a second copy of this presentation.
export function RecordSections({ metrics, history, historyLimit }: RecordSectionsProps) {
  return (
    <>
      <IndexOverTime points={metrics.indexHistory} roundsPlayed={history.length} />

      <p className="text-sm text-fairway tabular-nums">{describeTypicalEighteen(metrics.typicalEighteen)}</p>

      <div>
        <h3 className="text-base font-semibold">History</h3>
        <HistoryList history={history} historyLimit={historyLimit} />
      </div>
    </>
  );
}
