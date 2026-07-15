import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cardId, courseId, teeId } from "@swng/domain";
import type { CourseView } from "@swng/contracts";
import { CourseSummaryCard } from "./CourseSummaryCard";
import type { CourseSummaryCardProps } from "./CourseSummaryCard";

// The card carries no router affordances anymore (course-cards spec §8: attribution only, no
// "Edit this card" Link) — so a plain render is enough, no MemoryRouter wrapper needed.
const renderCard = (props: CourseSummaryCardProps) => render(<CourseSummaryCard {...props} />);

const course: CourseView = {
  courseId: courseId("course-1"),
  cardId: "card-1",
  card: {
    courseName: "Pebble Beach",
    source: { cardId: cardId("card-1"), courseId: courseId("course-1") },
    teeSets: [
      { teeId: teeId("t-white"), name: "white", rating: 71.8, slope: 130, holes: [{ number: 1, par: 4, yardage: 380, strokeIndex: 1 }] },
      { teeId: teeId("t-blue"), name: "blue", rating: 74.5, slope: 145, holes: [{ number: 1, par: 4, yardage: 420, strokeIndex: 1 }] },
    ],
  },
  enteredBy: "Ann",
  updatedAtMs: 1_700_000_000_000,
};

afterEach(() => {
  cleanup();
});

describe("CourseSummaryCard", () => {
  it("renders the course name from card.courseName", () => {
    renderCard({ course, selectedTee: "white", onSelectTee: vi.fn() });
    expect(screen.getByText("Pebble Beach")).toBeTruthy();
  });

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

  // Attribution only (course-cards spec §8): who entered the card and when — no verify badge,
  // no verify button, and no "Edit this card" link (T6 restores editing from the new CoursePage).
  it("shows attribution without any verification badge or edit affordance", () => {
    renderCard({ course, selectedTee: "white", onSelectTee: vi.fn() });

    expect(screen.getByText(/entered by Ann/i)).toBeTruthy();
    expect(screen.queryByText(/verified/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /verify/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /edit this card/i })).toBeNull();
  });
});
