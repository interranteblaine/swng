import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { courseId, roundId } from "@swng/domain";
import type { GolferMetrics, GolferRoundLine } from "@swng/domain";
import { RecordSections } from "./RecordSections";

afterEach(cleanup);

const ZERO_METRICS: GolferMetrics = {
  typicalEighteen: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  averageHistory: [],
  bests: {},
  milestones: [],
};

const line = (suffix: string, overrides: Partial<GolferRoundLine> = {}): GolferRoundLine => ({
  roundId: roundId(`round-${suffix}`),
  courseName: "Pebble Beach",
  tee: "white",
  holes: 18,
  par: 72,
  strokes: 8,
  score: 82,
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

// The chart's own fixture shape: one point per round, each an INTEGER average — `averageOfValues`
// rounds (domain/golfer/average.ts), so a fractional point can never reach this component.
const averagePoints = (history: readonly GolferRoundLine[], values: readonly number[]) => history.map((entry, i) => ({ roundId: entry.roundId, average: values[i]! }));

describe("RecordSections", () => {
  // The headline (spec 2026-07-29 §5): ONE number, what the golfer normally shoots relative to par,
  // with the sentence that says how it was arrived at — so it can be checked against the rows below.
  it("leads with 'What you shoot' and the average rendered vs par, over its own derivation sentence", () => {
    renderSections({ ...ZERO_METRICS, average: 26 }, [line("1")]);

    expect(screen.getByRole("heading", { name: "What you shoot" })).toBeTruthy();
    expect(screen.getByText("+26")).toBeTruthy();
    expect(screen.getByText("your last 10 finished rounds, score minus par")).toBeTruthy();
  });

  it("renders an UNDER-par average with its minus — one sign convention, no plus-handicap notation", () => {
    renderSections({ ...ZERO_METRICS, average: -2 }, [line("1")]);

    expect(screen.getByText("-2")).toBeTruthy();
    expect(screen.queryByText("+2")).toBeNull();
  });

  it("shows a dash when there is no average yet — absent is the honest answer, never a 0", () => {
    renderSections(ZERO_METRICS, []);

    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText("E")).toBeNull(); // an average of exactly par would read "E"; absent must not
  });

  it("no rounds: the chart is gated with a 'keep going' message, typical-18 renders zeroed, history reads 'No rounds yet.'", () => {
    renderSections(ZERO_METRICS, []);

    expect(screen.getByText("Your average over time shows up at 8 rounds — you've played 0. Keep going.")).toBeTruthy();
    expect(screen.queryByTestId("average-chart")).toBeNull();
    const typicalLine = screen.getByText(/In a typical 18:/);
    expect(typicalLine.textContent).toContain("0 birdies");
    expect(typicalLine.textContent).not.toMatch(/eagle/); // 0 eagles: prefix omitted
    expect(screen.getByText("No rounds yet.")).toBeTruthy();
  });

  it("8+ rounds: renders the chart with ONE polyline — there is no second series", () => {
    const history = Array.from({ length: 8 }, (_, i) => line(String(i + 1)));
    renderSections({ ...ZERO_METRICS, averageHistory: averagePoints(history, [31, 30, 30, 29, 28, 28, 27, 26]) }, history);

    expect(screen.getByTestId("average-chart")).toBeTruthy();
    expect(screen.getAllByTestId("average-line")).toHaveLength(1);
  });

  it("a history row is ONE whole-row link to /rounds/:roundId — the course name renders as plain text inside it, never its own anchor", () => {
    const withCourse = line("1", { courseId: courseId("course-1") });
    renderSections(ZERO_METRICS, [withCourse]);

    // Exactly one anchor for the row, named by its full rendered text (course name included).
    const rowLink = screen.getByRole("link", { name: /Pebble Beach · white · 82 \(\+10\)/ });
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
    const rowLink = screen.getByRole("link", { name: /Pebble Beach · white · 82 \(\+10\)/ });
    expect(rowLink.getAttribute("href")).toBe(`/rounds/${withoutCourse.roundId}`);
  });

  it("a 9-hole line renders the 9-hole marker beside its own score", () => {
    const nine = line("1", { holes: 9, par: 36, score: 47 });
    renderSections(ZERO_METRICS, [nine]);

    expect(screen.getByRole("link", { name: /white · 47 \(\+11\) · 9 holes/ })).toBeTruthy();
  });

  // A round with a pickup carries no `score` (spec §2d) — the row still lists the round, it just has
  // no number to show, because none was invented for it.
  it("a line with no score renders course and tee only — no number, no placeholder", () => {
    const noScore = line("1", { score: undefined });
    renderSections(ZERO_METRICS, [noScore]);

    const rowLink = screen.getByRole("link", { name: /Pebble Beach · white/ });
    expect(rowLink.textContent).toBe("Pebble Beach · white");
  });

  it("historyLimit caps the rendered rows to the first N (newest-first, no re-sort); roundsPlayed still reflects the FULL history", () => {
    const history = [line("1"), line("2"), line("3", { score: 95 })];
    renderSections(ZERO_METRICS, history, 2);

    expect(screen.getAllByRole("link", { name: /white/ })).toHaveLength(2);
    expect(screen.queryByText(/95/)).toBeNull();
    // Below the 8-round gate regardless (3 total rounds) — the gate message names the FULL count,
    // not the capped 2 rows actually rendered.
    expect(screen.getByText(/you've played 3\./)).toBeTruthy();
  });

  it('person="their" (GolferPage viewing someone else): the headline and gate copy mirror pronouns and drop the exhortation', () => {
    renderSectionsAs("their", { ...ZERO_METRICS, average: 26 }, []);

    expect(screen.getByRole("heading", { name: "What they shoot" })).toBeTruthy();
    expect(screen.getByText("their last 10 finished rounds, score minus par")).toBeTruthy();
    expect(screen.getByText("Their average over time")).toBeTruthy();
    expect(screen.getByText("Their average over time shows up at 8 rounds — they've played 0.")).toBeTruthy();
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
    renderSectionsAs("their", { ...ZERO_METRICS, averageHistory: averagePoints(history, [31, 30, 30, 29, 28, 28, 27, 26]) }, history);

    expect(screen.getByRole("heading", { name: "Their average over time" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Their average over time" })).toBeTruthy();
    expect(screen.getByText("their last 8 rounds")).toBeTruthy();
    expect(screen.queryByText(/^Your average over time$/)).toBeNull();
    expect(screen.queryByText(/your last/)).toBeNull();
  });
});

// The chart geometry survives the model change intact (it was always presentation math): a
// 20-round drawn window (every point still folds the whole career — the window is a VIEW), a
// "nice" whole-number axis with a min-span honesty rule, a fluid (no-frame) svg, endpoint-emphasis
// dots, and date anchors joined against `history` (createdAt preferred over finalizedAt). What
// CHANGED is the sign convention on the tick labels: `formatOverPar`, not the retired
// plus-handicap formatter.
describe("RecordSections — average-over-time chart geometry", () => {
  type DatedLine = GolferRoundLine & { readonly finalizedAt?: number; readonly createdAt?: number };
  const dated = (row: GolferRoundLine, extra: { readonly finalizedAt?: number; readonly createdAt?: number } = {}): DatedLine => ({ ...row, ...extra });
  const chartHistory = (n: number): GolferRoundLine[] => Array.from({ length: n }, (_, i) => line(String(i + 1)));
  const descending = (n: number, from: number): number[] => Array.from({ length: n }, (_, i) => from - i);

  it("draws at most the last 20 rounds — 25 rounds draws 20 dots and reads 'last 20 rounds'", () => {
    const history = chartHistory(25);
    renderSections({ ...ZERO_METRICS, averageHistory: averagePoints(history, descending(25, 40)) }, history);

    // AVERAGE_CHART_WINDOW caps the DRAW, not the career: 25 rounds played, only 20 dots drawn.
    expect(screen.getAllByTestId("average-dot")).toHaveLength(20);
    expect(screen.getByText("your last 20 rounds")).toBeTruthy();
  });

  it("draws every round when there are fewer than the window — 9 rounds draws 9 dots and reads 'last 9 rounds'", () => {
    const history = chartHistory(9);
    renderSections({ ...ZERO_METRICS, averageHistory: averagePoints(history, descending(9, 30)) }, history);

    expect(screen.getAllByTestId("average-dot")).toHaveLength(9);
    expect(screen.getByText("your last 9 rounds")).toBeTruthy();
  });

  it("min-span honesty: a tight cluster is padded to a real 4-point span before 'nice'-ing the axis — [26..28] over 9 rounds ticks exactly +25..+29", () => {
    // Hand-derivation, run by hand: lo=26, hi=28 → span=2 < 4 → expand about the midpoint 27 →
    // 25..29 → floor/ceil leaves 25..29 → span=4 → step=1 (span <= 4) → ticks start at
    // ceil(25/1)*1=25, then +1 while <= 29: 25, 26, 27, 28, 29. formatOverPar renders each "+N".
    const values = [26, 27, 26, 28, 27, 26, 27, 28, 26];
    const history = chartHistory(9);
    renderSections({ ...ZERO_METRICS, averageHistory: averagePoints(history, values) }, history);

    const tickLabels = screen.getAllByTestId("average-tick-label").map((el) => el.textContent);
    expect(tickLabels).toEqual(["+25", "+26", "+27", "+28", "+29"]);
    // Gridlines: one per tick, no more, no fewer.
    expect(screen.getAllByTestId("average-gridline")).toHaveLength(tickLabels.length);
  });

  // The sign FLIP this arc introduces, pinned deliberately: a tick at −2 on an average chart means
  // two UNDER par, and it renders "-2". The old chart put that same tick through
  // formatCourseHandicap and drew "+2" (better than scratch) — the exact collision spec §4 deletes.
  it("a span crossing par renders ticks through formatOverPar: minus means UNDER par, and E is level", () => {
    // Hand-derivation, run by hand: lo=-2, hi=2 → span=4, not < 4 → no expansion → floor(-2)=-2,
    // ceil(2)=2 → span=4 → step=1 → ticks start at ceil(-2/1)*1=-2, then +1 while <= 2:
    // -2, -1, 0, 1, 2. formatOverPar: "-2", "-1", "E", "+1", "+2".
    const values = [-2, -1, 0, 2, 1, -1, 1, -2, 2];
    const history = chartHistory(9);
    renderSections({ ...ZERO_METRICS, averageHistory: averagePoints(history, values) }, history);

    const tickLabels = screen.getAllByTestId("average-tick-label").map((el) => el.textContent);
    expect(tickLabels).toEqual(["-2", "-1", "E", "+1", "+2"]);
    // The retired convention would have shown "+2" for the -2 tick AND for the +2 tick — two ticks
    // reading identically. Exactly one "+2" on the axis is the proof that it's gone.
    expect(screen.getAllByTestId("average-tick-label").filter((el) => el.textContent === "+2")).toHaveLength(1);
  });

  it("the svg has no card frame — its class carries neither 'border' nor 'bg-card'", () => {
    const history = chartHistory(8);
    renderSections({ ...ZERO_METRICS, averageHistory: averagePoints(history, descending(8, 30)) }, history);

    const svgClass = screen.getByTestId("average-chart").getAttribute("class") ?? "";
    expect(svgClass).not.toContain("border");
    expect(svgClass).not.toContain("bg-card");
  });

  it("endpoint emphasis: the last drawn dot is r=4, every earlier dot is r=2.5", () => {
    const history = chartHistory(8);
    renderSections({ ...ZERO_METRICS, averageHistory: averagePoints(history, descending(8, 30)) }, history);

    const dots = screen.getAllByTestId("average-dot");
    dots.slice(0, -1).forEach((dot) => expect(dot.getAttribute("r")).toBe("2.5"));
    expect(dots.at(-1)?.getAttribute("r")).toBe("4");
  });

  // The two-line caption (the old "● swng V · ○ WHS V" row) is deleted with the second series: with
  // ONE line there is no legend to render, and the headline above already states the current number.
  it("renders no legend or caption row beneath the chart", () => {
    const history = chartHistory(8);
    renderSections({ ...ZERO_METRICS, average: 26, averageHistory: averagePoints(history, descending(8, 30)) }, history);

    expect(screen.queryByText(/swng/)).toBeNull();
    expect(screen.queryByText(/WHS/)).toBeNull();
    expect(screen.queryByText(/●/)).toBeNull();
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
    renderSections({ ...ZERO_METRICS, averageHistory: averagePoints(base, descending(9, 30)) }, history);

    // Mirrors production's own anchorLabel formatting (locale/timezone left to the environment,
    // exactly as the component does) so the expectation is derived, not hand-typed month text.
    const fmt = (ms: number) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(ms));
    const anchors = screen.getAllByTestId("average-anchor").map((el) => el.textContent);
    expect(anchors).toEqual([fmt(Date.UTC(2026, 0, 5, 12, 0)), fmt(Date.UTC(2026, 2, 10, 12, 0))]); // createdAt, never each round's own finalizedAt
  });

  it("no anchor renders when either drawn endpoint's date is missing — both-or-neither", () => {
    const base = chartHistory(9);
    const history: DatedLine[] = base.map((row, i) => (i === 0 ? dated(row, { createdAt: Date.UTC(2026, 0, 5, 12, 0) }) : row)); // the last round (i===8) carries no date at all
    renderSections({ ...ZERO_METRICS, averageHistory: averagePoints(base, descending(9, 30)) }, history);

    expect(screen.queryAllByTestId("average-anchor")).toHaveLength(0);
  });

  it("two anchors spanning different years both include the year", () => {
    const base = chartHistory(9);
    const history: DatedLine[] = base.map((row, i) =>
      i === 0 ? dated(row, { createdAt: Date.UTC(2024, 5, 15, 12, 0) }) : i === 8 ? dated(row, { createdAt: Date.UTC(2026, 5, 15, 12, 0) }) : row,
    );
    renderSections({ ...ZERO_METRICS, averageHistory: averagePoints(base, descending(9, 30)) }, history);

    const anchors = screen.getAllByTestId("average-anchor").map((el) => el.textContent ?? "");
    expect(anchors[0]).toMatch(/2024/);
    expect(anchors[1]).toMatch(/2026/);
  });
});
