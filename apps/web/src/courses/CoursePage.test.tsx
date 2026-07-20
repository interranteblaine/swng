import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courseId, teeId } from "@swng/domain";
import type { CourseView } from "@swng/contracts";

// Faking the api.ts module boundary (M5's own idiom) — CoursePage only ever calls getCourse.
vi.mock("../api", () => ({
  getCourse: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      readonly code: string,
      readonly status?: number,
      message?: string,
    ) {
      super(message ?? code);
      this.name = "ApiError";
    }
  },
}));

import { getCourse } from "../api";
import { CoursePage } from "./CoursePage";

const mockedGetCourse = vi.mocked(getCourse);

const view: CourseView = {
  courseId: courseId("course-1"),
  cardId: "card-1",
  card: {
    courseName: "Pebble Beach",
    teeSets: [
      {
        teeId: teeId("t-white"),
        name: "white",
        rating: 71.8,
        slope: 130,
        holes: [
          { number: 1, par: 4, yardage: 380, strokeIndex: 5 },
          { number: 2, par: 3, yardage: 165, strokeIndex: 9 },
        ],
      },
      {
        teeId: teeId("t-blue"),
        name: "blue",
        rating: 74.5,
        slope: 145,
        holes: [
          { number: 1, par: 4, yardage: 420, strokeIndex: 3 },
          { number: 2, par: 3, yardage: 175, strokeIndex: 7 },
        ],
      },
    ],
  },
  enteredBy: "Ann",
  updatedAtMs: 1_700_000_000_000,
};

// Stands in for CreateRoundPage — proves the "Start a round here" Link's own router state
// (the courseId preselect CreateRoundPage's own location-state effect reads) rather than just
// its href, which carries no state at all.
function CreateStub() {
  const location = useLocation();
  const state = location.state as { courseId?: string } | null;
  return <div>create page — preselected {state?.courseId ?? "none"}</div>;
}

// Stands in for EditCoursePage — proves which mode (`addTee` or not) each of CoursePage's two
// edit Links actually carries.
function EditStub() {
  const location = useLocation();
  const state = location.state as { addTee?: boolean } | null;
  return <div>edit page — addTee {String(Boolean(state?.addTee))}</div>;
}

const renderPage = (initialEntry = "/courses/course-1") =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/courses/:courseId" element={<CoursePage />} />
        <Route path="/create" element={<CreateStub />} />
        <Route path="/courses/:courseId/edit" element={<EditStub />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  mockedGetCourse.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("CoursePage", () => {
  it("renders the course name, attribution, and populates the tee picker from the loaded card", async () => {
    mockedGetCourse.mockResolvedValue({ course: view });
    renderPage();

    expect(await screen.findByRole("heading", { name: "Pebble Beach" })).toBeTruthy();
    expect(screen.getByText(/entered by Ann/i)).toBeTruthy();
    expect(screen.getByText(/entered by Ann/i).textContent).toMatch(new Date(view.updatedAtMs).toLocaleDateString());
    // Nav infrastructure Task 2: usePageTitle re-runs once the card loads — the course name.
    expect(document.title).toBe("Pebble Beach · swng");

    const select = screen.getByLabelText(/^tee$/i) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["white", "blue"]);
    expect(select.value).toBe("white"); // defaults to the card's first tee
  });

  it("renders a read-only hole table for the selected tee, and switches it via the tee picker", async () => {
    mockedGetCourse.mockResolvedValue({ course: view });
    renderPage();
    await screen.findByRole("heading", { name: "Pebble Beach" });

    const rowsFor = () => screen.getAllByRole("row").slice(1); // drop the header row
    const cellsOf = (row: HTMLElement) => within(row).getAllByRole("cell").map((cell) => cell.textContent);

    expect(cellsOf(rowsFor()[0]!)).toEqual(["1", "4", "380", "5"]);
    expect(cellsOf(rowsFor()[1]!)).toEqual(["2", "3", "165", "9"]);

    fireEvent.change(screen.getByLabelText(/^tee$/i), { target: { value: "blue" } });

    expect(cellsOf(rowsFor()[0]!)).toEqual(["1", "4", "420", "3"]);
    expect(cellsOf(rowsFor()[1]!)).toEqual(["2", "3", "175", "7"]);
  });

  it("shows a load error instead of the page when getCourse rejects", async () => {
    mockedGetCourse.mockRejectedValue(new Error("boom"));
    renderPage();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Pebble Beach" })).toBeNull();
  });

  it('the "Start a round here" link carries the courseId as router state', async () => {
    mockedGetCourse.mockResolvedValue({ course: view });
    renderPage();
    await screen.findByRole("heading", { name: "Pebble Beach" });

    const link = screen.getByRole("link", { name: /start a round here/i });
    expect(link.getAttribute("href")).toBe("/create");

    fireEvent.click(link);
    expect(await screen.findByText(/create page — preselected course-1/)).toBeTruthy();
  });

  it("both edit links are present — plain edit and add-a-tee, each to the same edit route", async () => {
    mockedGetCourse.mockResolvedValue({ course: view });
    renderPage();
    await screen.findByRole("heading", { name: "Pebble Beach" });

    const editLink = screen.getByRole("link", { name: "Edit this card" });
    const addTeeLink = screen.getByRole("link", { name: "Add a tee" });
    expect(editLink.getAttribute("href")).toBe("/courses/course-1/edit");
    expect(addTeeLink.getAttribute("href")).toBe("/courses/course-1/edit");

    fireEvent.click(addTeeLink);
    expect(await screen.findByText(/edit page — addTee true/)).toBeTruthy();
  });

  it('"Edit this card" carries no addTee state (plain edit mode)', async () => {
    mockedGetCourse.mockResolvedValue({ course: view });
    renderPage();
    await screen.findByRole("heading", { name: "Pebble Beach" });

    fireEvent.click(screen.getByRole("link", { name: "Edit this card" }));
    expect(await screen.findByText(/edit page — addTee false/)).toBeTruthy();
  });

  // unrated-courses arc: a tee with no rating/slope renders "unrated" in the picker, not a
  // half-blank "rating , slope " — via the shared teeNumbers helper. A rated tee still reads
  // its numbers. The fixture mixes one of each so both branches are pinned in one place.
  it("the tee picker labels a rated tee with its numbers and an unrated tee with 'unrated'", async () => {
    const mixed: CourseView = {
      ...view,
      card: {
        courseName: "Mixed GC",
        teeSets: [
          { teeId: teeId("t-white"), name: "white", rating: 71.8, slope: 130, holes: [{ number: 1, par: 4, yardage: 380, strokeIndex: 1 }] },
          { teeId: teeId("t-red"), name: "red", holes: [{ number: 1, par: 4, yardage: 300, strokeIndex: 1 }] }, // no rating/slope — unrated
        ],
      },
    };
    mockedGetCourse.mockResolvedValue({ course: mixed });
    renderPage();
    await screen.findByRole("heading", { name: "Mixed GC" });

    expect(screen.getByRole("option", { name: "white — rating 71.8, slope 130" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "red — unrated" })).toBeTruthy();
  });
});
