import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courseId } from "@swng/domain";

// Faking the api.ts module boundary — CourseSearch only ever calls searchCourses.
vi.mock("../api", () => ({
  searchCourses: vi.fn(),
}));

import { searchCourses } from "../api";
import { CourseSearch } from "./CourseSearch";

const mockedSearchCourses = vi.mocked(searchCourses);

const renderSearch = (onSelect = vi.fn()) => {
  render(
    <MemoryRouter>
      <CourseSearch onSelect={onSelect} />
    </MemoryRouter>,
  );
  return onSelect;
};

beforeEach(() => {
  mockedSearchCourses.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CourseSearch", () => {
  it("debounces at least 250ms after the last keystroke before searching", async () => {
    mockedSearchCourses.mockResolvedValue({ courses: [] });
    renderSearch();

    fireEvent.change(screen.getByLabelText(/course/i), { target: { value: "pebble" } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(mockedSearchCourses).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockedSearchCourses).toHaveBeenCalledTimes(1);
    expect(mockedSearchCourses).toHaveBeenCalledWith("pebble");
  });

  it("never searches for an empty (untyped) query", async () => {
    mockedSearchCourses.mockResolvedValue({ courses: [] });
    renderSearch();

    fireEvent.change(screen.getByLabelText(/course/i), { target: { value: "" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(mockedSearchCourses).not.toHaveBeenCalled();
  });

  it("resets the debounce on every keystroke — only the last one within the window fires", async () => {
    mockedSearchCourses.mockResolvedValue({ courses: [] });
    renderSearch();

    const input = screen.getByLabelText(/course/i);
    fireEvent.change(input, { target: { value: "p" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fireEvent.change(input, { target: { value: "pe" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(mockedSearchCourses).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(mockedSearchCourses).toHaveBeenCalledTimes(1);
    expect(mockedSearchCourses).toHaveBeenCalledWith("pe");
  });

  it("renders tappable results and reports the picked courseId + name", async () => {
    mockedSearchCourses.mockResolvedValue({ courses: [{ courseId: courseId("course-1"), name: "Pebble Beach" }] });
    const onSelect = renderSearch();

    fireEvent.change(screen.getByLabelText(/course/i), { target: { value: "pebble" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    const result = screen.getByRole("button", { name: "Pebble Beach" });
    fireEvent.click(result);

    expect(onSelect).toHaveBeenCalledWith(courseId("course-1"), "Pebble Beach");
  });

  it("an empty result set offers 'Add a course', linking /courses/new", async () => {
    mockedSearchCourses.mockResolvedValue({ courses: [] });
    renderSearch();

    fireEvent.change(screen.getByLabelText(/course/i), { target: { value: "nowhere golf club" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    const link = screen.getByRole("link", { name: /add a course/i });
    expect(link.getAttribute("href")).toBe("/courses/new");
  });

  it("never shows the empty-state before any search has actually run", () => {
    renderSearch();
    expect(screen.queryByRole("link", { name: /add a course/i })).toBeNull();
  });
});
