import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { courseId } from "@swng/domain";
import type { CourseView } from "@swng/contracts";
import { CourseSummaryCard } from "./CourseSummaryCard";
import type { CourseSummaryCardProps } from "./CourseSummaryCard";

// Reads back whatever "Edit this card" navigated to, so a test can assert the router state
// the Link hands EditCoursePage (teeName + returnTo) without pulling the real EditCoursePage
// into this file — the same idiom as AddCoursePage.test.tsx's own CreateStub for
// AddCoursePage's success navigation.
function EditStub() {
  const location = useLocation();
  return <div>edit page — state {JSON.stringify(location.state)}</div>;
}

// "Edit this card" is a real <Link>, and reading the current location for its own `returnTo`
// state needs a router context (useLocation) too — a plain MemoryRouter is enough now: the
// verify affordance that once needed an AuthProvider (for the signed-in golfer's name) is gone.
const renderCard = (props: CourseSummaryCardProps, initialEntry: string | { pathname: string; search?: string } = "/create") =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/create" element={<CourseSummaryCard {...props} />} />
        <Route path="/courses/:courseId/edit" element={<EditStub />} />
      </Routes>
    </MemoryRouter>,
  );

const course: CourseView = {
  courseId: courseId("course-1"),
  name: "Pebble Beach",
  card: {
    courseName: "Pebble Beach",
    teeSets: [
      { name: "white", rating: 71.8, slope: 130, holes: [{ number: 1, par: 4, yardage: 380, strokeIndex: 1 }] },
      { name: "blue", rating: 74.5, slope: 145, holes: [{ number: 1, par: 4, yardage: 420, strokeIndex: 1 }] },
    ],
  },
  teeSets: [
    { name: "white", version: 1, provenance: "community", enteredBy: "Ann", verifiedBy: [] },
    { name: "blue", version: 1, provenance: "community", enteredBy: "Bo", verifiedBy: ["Cal", "Dee"] },
  ],
};

afterEach(() => {
  cleanup();
});

describe("CourseSummaryCard", () => {
  it("populates the tee picker from card.teeSets", () => {
    renderCard({ course, selectedTee: "white", onSelectTee: vi.fn() });

    const select = screen.getByLabelText(/^tee$/i) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["white", "blue"]);
    expect(select.value).toBe("white");
  });

  it("reports a tee change via onSelectTee", () => {
    const onSelectTee = vi.fn();
    renderCard({ course, selectedTee: "white", onSelectTee });

    fireEvent.change(screen.getByLabelText(/^tee$/i), { target: { value: "blue" } });

    expect(onSelectTee).toHaveBeenCalledWith("blue");
  });

  // The verify affordance is gone (course-cards spec §8) — a tee's own metadata line names
  // who entered it, never a self-typed verify count or badge, and there is no verify button.
  it("shows attribution without any verification badge", () => {
    renderCard({ course, selectedTee: "white", onSelectTee: vi.fn() });

    expect(screen.getAllByText(/entered by/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/verified/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /verify/i })).toBeNull();
  });

  // M7 Task 7 (I2, papercut 3): the revise endpoint shipped in M6 with zero web callers.
  // "Edit this card" is the first — a real navigation (never a callback, since correcting a
  // card is a whole separate form), carrying which tee to edit and where to come back to.
  it("'Edit this card' links to the course's edit route, carrying the selected tee and a return path", () => {
    renderCard({ course, selectedTee: "blue", onSelectTee: vi.fn() }, { pathname: "/create", search: "?foo=bar" });

    const link = screen.getByRole("link", { name: /edit this card/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/courses/course-1/edit");

    fireEvent.click(link);
    // EditCoursePage's own pre-fill (which tee) and success hand-off (where to return, with
    // the search string intact) both read this state back out — see EditCoursePage.test.tsx.
    expect(screen.getByText(/edit page — state/).textContent).toBe(`edit page — state ${JSON.stringify({ teeName: "blue", returnTo: "/create?foo=bar" })}`);
  });
});
