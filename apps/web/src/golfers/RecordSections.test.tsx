import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { courseId, roundId } from "@swng/domain";
import type { GolferMetrics, GolferRoundLine } from "@swng/domain";
import { RecordSections } from "./RecordSections";

afterEach(cleanup);

const ZERO_METRICS: GolferMetrics = { typicalEighteen: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 }, indexHistory: [] };

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
