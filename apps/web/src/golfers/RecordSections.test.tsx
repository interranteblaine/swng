import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { courseId, roundId } from "@swng/domain";
import type { GolferMetrics, GolferRoundLine } from "@swng/domain";
import { RecordSections } from "./RecordSections";

afterEach(cleanup);

const ZERO_METRICS: GolferMetrics = {
  typicalEighteen: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  indexHistory: [],
  bests: {},
  milestones: [],
};

const line = (suffix: string, overrides: Partial<GolferRoundLine> = {}): GolferRoundLine => ({
  roundId: roundId(`round-${suffix}`),
  courseName: "Pebble Beach",
  tee: "white",
  holes: 18,
  par: 72,
  courseHandicap: 8,
  ags: 82,
  differential: 9.2,
  distribution: { eagles: 0, birdies: 1, pars: 10, bogeys: 6, doublePlus: 1 },
  ...overrides,
});

const renderSections = (metrics: GolferMetrics, history: readonly GolferRoundLine[], historyLimit?: number) =>
  render(
    <MemoryRouter>
      <RecordSections metrics={metrics} history={history} historyLimit={historyLimit} />
    </MemoryRouter>,
  );

const renderSectionsAs = (person: "your" | "their", metrics: GolferMetrics, history: readonly GolferRoundLine[]) =>
  render(
    <MemoryRouter>
      <RecordSections metrics={metrics} history={history} person={person} />
    </MemoryRouter>,
  );

describe("RecordSections", () => {
  it("no rounds: the chart is gated with a 'keep going' message, typical-18 renders zeroed, history reads 'No rounds yet.'", () => {
    renderSections(ZERO_METRICS, []);

    expect(screen.getByText("Your index history shows up at 8 rounds — you've played 0. Keep going.")).toBeTruthy();
    expect(screen.queryByTestId("index-chart")).toBeNull();
    const typicalLine = screen.getByText(/In a typical 18:/);
    expect(typicalLine.textContent).toContain("0 birdies");
    expect(typicalLine.textContent).not.toMatch(/eagle/); // 0 eagles: prefix omitted
    expect(screen.getByText("No rounds yet.")).toBeTruthy();
  });

  it("8+ rounds: renders the chart with swng and WHS polylines", () => {
    const history = Array.from({ length: 8 }, (_, i) => line(String(i + 1)));
    const indexHistory = history.map((entry, i) => ({ roundId: entry.roundId, swngIndex: 12 - i * 0.2, whsIndex: 12.5 - i * 0.15 }));
    renderSections({ ...ZERO_METRICS, indexHistory }, history);

    expect(screen.getByTestId("index-chart")).toBeTruthy();
    expect(screen.getByTestId("index-line-swng")).toBeTruthy();
    expect(screen.getByTestId("index-line-whs")).toBeTruthy();
  });

  it("a history row is ONE whole-row link to /rounds/:roundId — the course name renders as plain text inside it, never its own anchor", () => {
    const withCourse = line("1", { courseId: courseId("course-1") });
    renderSections(ZERO_METRICS, [withCourse]);

    // Exactly one anchor for the row, named by its full rendered text (course name included).
    const rowLink = screen.getByRole("link", { name: /Pebble Beach · white · 82 \(\+10\) · 9\.2/ });
    expect(rowLink.getAttribute("href")).toBe(`/rounds/${withCourse.roundId}`);
    expect(rowLink.querySelectorAll("a")).toHaveLength(0); // no nested anchor

    // The course name is text INSIDE the row link, not a link of its own — a courseId on the line
    // no longer produces a second, separately-addressable anchor.
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("a history row without a courseId renders identically to one with a courseId — the row link is the whole card either way", () => {
    const withoutCourse = line("1");
    renderSections(ZERO_METRICS, [withoutCourse]);

    expect(screen.getAllByRole("link")).toHaveLength(1);
    const rowLink = screen.getByRole("link", { name: /Pebble Beach · white · 82 \(\+10\) · 9\.2/ });
    expect(rowLink.getAttribute("href")).toBe(`/rounds/${withoutCourse.roundId}`);
  });

  it("a 9-hole, undifferentiated line renders the 9-hole marker and no differential", () => {
    const nine = line("1", { holes: 9, par: 36, ags: 47, differential: undefined });
    renderSections(ZERO_METRICS, [nine]);

    const scoreLink = screen.getByRole("link", { name: /white · 47 \(\+11\) · 9 holes/ });
    expect(scoreLink.textContent).not.toMatch(/\d\.\d/); // no differential digits anywhere
  });

  it("historyLimit caps the rendered rows to the first N (newest-first, no re-sort); roundsPlayed still reflects the FULL history", () => {
    const history = [line("1", { differential: 9.2 }), line("2", { differential: 11.8 }), line("3", { differential: 14.5 })];
    renderSections(ZERO_METRICS, history, 2);

    expect(screen.getAllByRole("link", { name: /white/ })).toHaveLength(2);
    expect(screen.queryByText(/14\.5/)).toBeNull();
    // Below the 8-round gate regardless (3 total rounds) — the gate message names the FULL count,
    // not the capped 2 rows actually rendered.
    expect(screen.getByText(/you've played 3\./)).toBeTruthy();
  });

  it('person="their" (GolferPage viewing someone else): the gate heading/body mirror pronouns and drop the exhortation, with no "Your"/"Keep going." copy anywhere', () => {
    renderSectionsAs("their", ZERO_METRICS, []);

    expect(screen.getByText("Their index over time")).toBeTruthy();
    expect(screen.getByText("Their index history shows up at 8 rounds — they've played 0.")).toBeTruthy();
    expect(screen.queryByText(/Keep going\./)).toBeNull();
    expect(screen.queryByText(/^Your /)).toBeNull();
    expect(screen.queryByText(/you've/)).toBeNull();
  });

  it("renders Best rounds + Milestones from a fixture, each linked to its round via the history join", () => {
    const best18Round = line("b18", { courseId: courseId("course-1") }); // courseName defaults to "Pebble Beach"
    const best9Round = line("b9", { courseId: courseId("course-2"), courseName: "Old Muni", holes: 9, par: 36 });
    const milestoneRound = line("m1", { courseId: courseId("course-3"), courseName: "Sandy Hollow" });
    const metrics: GolferMetrics = {
      ...ZERO_METRICS,
      bests: {
        best18: { roundId: best18Round.roundId, gross: 74, toPar: 2 },
        best9: { roundId: best9Round.roundId, gross: 35, toPar: -1 },
      },
      milestones: [
        { kind: "first-birdie", roundId: milestoneRound.roundId },
        { kind: "broke-90", roundId: milestoneRound.roundId },
      ],
    };
    renderSections(metrics, [best18Round, best9Round, milestoneRound]);

    expect(screen.getByRole("heading", { name: "Best rounds" })).toBeTruthy();
    expect(screen.getByText(/Best 18: 74 \(\+2\)/)).toBeTruthy();
    const best18Link = screen.getByRole("link", { name: "Pebble Beach" });
    expect(best18Link.getAttribute("href")).toBe(`/rounds/${best18Round.roundId}`);

    expect(screen.getByText(/Best 9: 35 \(-1\)/)).toBeTruthy();
    const best9Link = screen.getByRole("link", { name: "Old Muni" });
    expect(best9Link.getAttribute("href")).toBe(`/rounds/${best9Round.roundId}`);

    expect(screen.getByRole("heading", { name: "Milestones" })).toBeTruthy();
    expect(screen.getByText(/First birdie/)).toBeTruthy();
    expect(screen.getByText(/Broke 90/)).toBeTruthy();
    const milestoneLinks = screen.getAllByRole("link", { name: "Sandy Hollow" });
    expect(milestoneLinks).toHaveLength(2); // one per milestone entry, same round
    expect(milestoneLinks[0]!.getAttribute("href")).toBe(`/rounds/${milestoneRound.roundId}`);
  });

  it("no bests/milestones ({bests: {}, milestones: []}): neither section renders, even with history present", () => {
    renderSections(ZERO_METRICS, [line("1")]);

    expect(screen.queryByRole("heading", { name: "Best rounds" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Milestones" })).toBeNull();
  });

  it("a best/milestone roundId with no matching history row falls back to plain text — no crash, no link", () => {
    const metrics: GolferMetrics = {
      ...ZERO_METRICS,
      bests: { best18: { roundId: roundId("missing-round"), gross: 90, toPar: 18 } },
      milestones: [{ kind: "broke-100", roundId: roundId("missing-round") }],
    };
    renderSections(metrics, []);

    expect(screen.getByText("Best 18: 90 (+18)")).toBeTruthy();
    expect(screen.getByText("Broke 100")).toBeTruthy();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it('person="their", 8+ rounds: the chart heading, aria-label, and "last N rounds" caption all mirror pronouns', () => {
    const history = Array.from({ length: 8 }, (_, i) => line(String(i + 1)));
    const indexHistory = history.map((entry, i) => ({ roundId: entry.roundId, swngIndex: 12 - i * 0.2, whsIndex: 12.5 - i * 0.15 }));
    renderSectionsAs("their", { ...ZERO_METRICS, indexHistory }, history);

    expect(screen.getByRole("heading", { name: "Their index over time" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Their index over time" })).toBeTruthy();
    expect(screen.getByText("their last 8 rounds")).toBeTruthy();
    expect(screen.queryByText(/^Your index over time$/)).toBeNull();
    expect(screen.queryByText(/your last/)).toBeNull();
  });
});

// The chart rewrite (index-chart-polish spec §1): a 20-round drawn window (every point still
// folds the whole career — the window is a VIEW), a "nice" whole-index axis with a min-span
// honesty rule and the plus-handicap tick convention, a fluid (no-frame) svg, endpoint-emphasis
// dots, a numeric caption (replacing the old bare "● swng"/"○ WHS" legend), and date anchors
// joined against `history` (createdAt preferred over finalizedAt).
describe("RecordSections — index-over-time chart geometry (index-chart-polish spec)", () => {
  type DatedLine = GolferRoundLine & { readonly finalizedAt?: number; readonly createdAt?: number };
  const dated = (row: GolferRoundLine, extra: { readonly finalizedAt?: number; readonly createdAt?: number } = {}): DatedLine => ({ ...row, ...extra });
  const chartHistory = (n: number): GolferRoundLine[] => Array.from({ length: n }, (_, i) => line(String(i + 1)));

  it("draws at most the last 20 rounds — 25 rounds draws 20 dots and reads 'last 20 rounds'", () => {
    const history = chartHistory(25);
    const indexHistory = history.map((entry, i) => ({ roundId: entry.roundId, swngIndex: 10 + i * 0.1 }));
    renderSections({ ...ZERO_METRICS, indexHistory }, history);

    // INDEX_CHART_WINDOW caps the DRAW, not the career: 25 rounds played, only 20 dots drawn.
    expect(screen.getAllByTestId("index-dot-swng")).toHaveLength(20);
    expect(screen.getByText("your last 20 rounds")).toBeTruthy();
  });

  it("draws every round when there are fewer than the window (existing behavior preserved) — 9 rounds draws 9 dots and reads 'last 9 rounds'", () => {
    const history = chartHistory(9);
    const indexHistory = history.map((entry, i) => ({ roundId: entry.roundId, swngIndex: 10 + i * 0.1 }));
    renderSections({ ...ZERO_METRICS, indexHistory }, history);

    expect(screen.getAllByTestId("index-dot-swng")).toHaveLength(9);
    expect(screen.getByText("your last 9 rounds")).toBeTruthy();
  });

  it("min-span honesty: a tight cluster of values is padded to a real 4-point span before 'nice'-ing the axis — [9.0,9.6] over 9 rounds ticks exactly 8/10/12", () => {
    // Hand-derivation (spec §1.2, run by hand): lo=9.0, hi=9.6 → span=0.6 < 4 → expand about the
    // midpoint 9.3 → 7.3..11.3 → floor/ceil → 7..12 → span=5 → step=2 (4 < 5 <= 8) → ticks start
    // at ceil(7/2)*2=8, then +2 while <= 12: 8, 10, 12.
    const values = [9.0, 9.6, 9.2, 9.4, 9.1, 9.5, 9.3, 9.6, 9.0];
    const history = chartHistory(9);
    const indexHistory = history.map((entry, i) => ({ roundId: entry.roundId, swngIndex: values[i] }));
    renderSections({ ...ZERO_METRICS, indexHistory }, history);

    const tickLabels = screen.getAllByTestId("index-tick-label").map((el) => el.textContent);
    expect(tickLabels).toEqual(["8", "10", "12"]);
    // Gridlines: one per tick, no more, no fewer.
    expect(screen.getAllByTestId("index-gridline")).toHaveLength(tickLabels.length);
  });

  it("plus-handicap convention: a span crossing scratch renders ticks through formatCourseHandicap — never a bare negative", () => {
    // Hand-derivation (spec §1.2, run by hand): lo=-2.4, hi=1.8 → mid=-0.3, span=4.2 >= 4 → no
    // expansion → floor(-2.4)=-3, ceil(1.8)=2 → span=5 → step=2 → ticks start at
    // ceil(-3/2)*2=-2, then 0, 2. formatCourseHandicap renders -2 as "+2" (golf's plus-handicap
    // convention) — never a bare "-2".
    const values = [-2.4, -1.0, 0.0, 1.8, 0.5, -0.5, 1.0, -2.0, 1.5];
    const history = chartHistory(9);
    const indexHistory = history.map((entry, i) => ({ roundId: entry.roundId, swngIndex: values[i] }));
    renderSections({ ...ZERO_METRICS, indexHistory }, history);

    const tickLabels = screen.getAllByTestId("index-tick-label").map((el) => el.textContent);
    expect(tickLabels).toEqual(["+2", "0", "2"]);
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.queryAllByText(/^-\d/)).toHaveLength(0); // no bare negative anywhere on the chart
  });

  it("the svg has no card frame — its class carries neither 'border' nor 'bg-card'", () => {
    const history = chartHistory(8);
    const indexHistory = history.map((entry, i) => ({ roundId: entry.roundId, swngIndex: 10 - i * 0.1 }));
    renderSections({ ...ZERO_METRICS, indexHistory }, history);

    const svgClass = screen.getByTestId("index-chart").getAttribute("class") ?? "";
    expect(svgClass).not.toContain("border");
    expect(svgClass).not.toContain("bg-card");
  });

  it("endpoint emphasis: the last drawn dot is r=4 on both series, every earlier dot is r=2.5", () => {
    const history = chartHistory(8);
    const indexHistory = history.map((entry, i) => ({ roundId: entry.roundId, swngIndex: 10 - i * 0.2, whsIndex: 10.5 - i * 0.15 }));
    renderSections({ ...ZERO_METRICS, indexHistory }, history);

    const swngDots = screen.getAllByTestId("index-dot-swng");
    swngDots.slice(0, -1).forEach((dot) => expect(dot.getAttribute("r")).toBe("2.5"));
    expect(swngDots.at(-1)?.getAttribute("r")).toBe("4");

    const whsDots = screen.getAllByTestId("index-dot-whs");
    whsDots.slice(0, -1).forEach((dot) => expect(dot.getAttribute("r")).toBe("2.5"));
    expect(whsDots.at(-1)?.getAttribute("r")).toBe("4");
  });

  it("the caption reads '● swng V · ○ WHS V' from the latest drawn values — the old bare '● swng'/'○ WHS' legend row is gone", () => {
    const history = chartHistory(8);
    const indexHistory = history.map((entry, i) => ({
      roundId: history[i]!.roundId,
      swngIndex: i === 7 ? 1.2 : 10 - i * 0.2,
      whsIndex: i === 7 ? 0.2 : 10.5 - i * 0.15,
    }));
    renderSections({ ...ZERO_METRICS, indexHistory }, history);

    expect(screen.getByText("● swng 1.2 · ○ WHS 0.2")).toBeTruthy();
    expect(screen.queryByText("● swng")).toBeNull();
    expect(screen.queryByText("○ WHS")).toBeNull();
  });

  it("anchors render the first and last DRAWN rounds' dates, preferring createdAt over finalizedAt", () => {
    const base = chartHistory(9);
    const history: DatedLine[] = base.map((row, i) =>
      i === 0
        ? dated(row, { createdAt: Date.UTC(2026, 0, 5, 12, 0), finalizedAt: Date.UTC(2026, 1, 20, 12, 0) })
        : i === 8
          ? dated(row, { createdAt: Date.UTC(2026, 2, 10, 12, 0), finalizedAt: Date.UTC(2026, 3, 1, 12, 0) })
          : dated(row),
    );
    const indexHistory = base.map((entry, i) => ({ roundId: entry.roundId, swngIndex: 10 - i * 0.1 }));
    renderSections({ ...ZERO_METRICS, indexHistory }, history);

    // Mirrors production's own anchorLabel formatting (locale/timezone left to the environment,
    // exactly as the component does) so the expectation is derived, not hand-typed month text.
    const fmt = (ms: number) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(ms));
    const anchors = screen.getAllByTestId("index-anchor").map((el) => el.textContent);
    expect(anchors).toEqual([fmt(Date.UTC(2026, 0, 5, 12, 0)), fmt(Date.UTC(2026, 2, 10, 12, 0))]); // createdAt, never each round's own finalizedAt
  });

  it("no anchor renders when either drawn endpoint's date is missing — both-or-neither", () => {
    const base = chartHistory(9);
    const history: DatedLine[] = base.map((row, i) => (i === 0 ? dated(row, { createdAt: Date.UTC(2026, 0, 5, 12, 0) }) : row)); // the last round (i===8) carries no date at all
    const indexHistory = base.map((entry, i) => ({ roundId: entry.roundId, swngIndex: 10 - i * 0.1 }));
    renderSections({ ...ZERO_METRICS, indexHistory }, history);

    expect(screen.queryAllByTestId("index-anchor")).toHaveLength(0);
  });

  it("two anchors spanning different years both include the year", () => {
    const base = chartHistory(9);
    const history: DatedLine[] = base.map((row, i) =>
      i === 0 ? dated(row, { createdAt: Date.UTC(2024, 5, 15, 12, 0) }) : i === 8 ? dated(row, { createdAt: Date.UTC(2026, 5, 15, 12, 0) }) : row,
    );
    const indexHistory = base.map((entry, i) => ({ roundId: entry.roundId, swngIndex: 10 - i * 0.1 }));
    renderSections({ ...ZERO_METRICS, indexHistory }, history);

    const anchors = screen.getAllByTestId("index-anchor").map((el) => el.textContent ?? "");
    expect(anchors[0]).toMatch(/2024/);
    expect(anchors[1]).toMatch(/2026/);
  });
});
