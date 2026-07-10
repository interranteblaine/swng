import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courseId } from "@swng/domain";
import type { CourseView } from "@swng/contracts";

// Faking the api.ts module boundary — CourseSummaryCard only ever calls verifyTeeSet.
vi.mock("../api", () => ({
  verifyTeeSet: vi.fn(),
}));

import { verifyTeeSet } from "../api";
import { CourseSummaryCard } from "./CourseSummaryCard";

const mockedVerifyTeeSet = vi.mocked(verifyTeeSet);

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

beforeEach(() => {
  mockedVerifyTeeSet.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CourseSummaryCard", () => {
  it("populates the tee picker from card.teeSets and shows verification badges from CourseView.teeSets", () => {
    render(<CourseSummaryCard course={course} selectedTee="white" onSelectTee={vi.fn()} />);

    const select = screen.getByLabelText(/^tee$/i) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["white", "blue"]);
    expect(select.value).toBe("white");

    expect(screen.getByText(/entered by ann/i)).toBeTruthy();
    expect(screen.getByText(/not yet verified/i)).toBeTruthy();
    expect(screen.getByText(/entered by bo/i)).toBeTruthy();
    expect(screen.getByText(/✓ 2 verified/i)).toBeTruthy();
  });

  it("reports a tee change via onSelectTee", () => {
    const onSelectTee = vi.fn();
    render(<CourseSummaryCard course={course} selectedTee="white" onSelectTee={onSelectTee} />);

    fireEvent.change(screen.getByLabelText(/^tee$/i), { target: { value: "blue" } });

    expect(onSelectTee).toHaveBeenCalledWith("blue");
  });

  it("'Verify this card' prompts for a name, then POSTs verify and refreshes the badges from the response", async () => {
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "Ed"),
    );
    mockedVerifyTeeSet.mockResolvedValue({
      course: { ...course, teeSets: course.teeSets.map((t) => (t.name === "white" ? { ...t, verifiedBy: ["Ed"] } : t)) },
    });

    render(<CourseSummaryCard course={course} selectedTee="white" onSelectTee={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /verify this card/i }));

    await screen.findByText(/✓ 1 verified/i);
    expect(mockedVerifyTeeSet).toHaveBeenCalledWith(courseId("course-1"), { teeName: "white", verifierName: "Ed" });
  });

  it("a blank/cancelled name prompt never calls verify", () => {
    vi.stubGlobal(
      "prompt",
      vi.fn(() => null),
    );
    render(<CourseSummaryCard course={course} selectedTee="white" onSelectTee={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /verify this card/i }));

    expect(mockedVerifyTeeSet).not.toHaveBeenCalled();
  });
});
