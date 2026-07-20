import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CourseView, GetMyRoundsResponse } from "@swng/contracts";
import { courseId, golferId, roundId } from "@swng/domain";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary (M5's own idiom) — CoursesHubPage (and the CourseSearch it
// composes unchanged) only ever calls these; getMe backs the AuthProvider wrapper.
vi.mock("../api", () => ({
  getMe: vi.fn(),
  getCourse: vi.fn(),
  getMyRounds: vi.fn(),
  searchCourses: vi.fn(),
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

import { getCourse, getMe, getMyRounds, searchCourses } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { CoursesHubPage } from "./CoursesHubPage";

const mockedGetMe = vi.mocked(getMe);
const mockedGetCourse = vi.mocked(getCourse);
const mockedGetMyRounds = vi.mocked(getMyRounds);
const mockedSearchCourses = vi.mocked(searchCourses);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  mockedGetMe.mockReset();
  mockedGetCourse.mockReset();
  mockedGetMyRounds.mockReset();
  mockedSearchCourses.mockReset();
  mockedGetMyRounds.mockResolvedValue({ rounds: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const base64url = (obj: unknown): string =>
  btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const signIn = (): void => {
  const idToken = `${base64url({ alg: "none" })}.${base64url({ sub: "sub-1" })}.sig`;
  tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 3_600_000 });
};

// The /courses/:courseId destination CourseSearch and the "Your home course"/"Courses you've
// played" rows all link to — a probe reporting exactly what it was navigated to, the same
// harness HomePage.test.tsx uses for its own cross-page assertions.
function CourseProbe() {
  const { courseId: id } = useParams();
  return <div>course page probe: {id}</div>;
}

const renderHub = () =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/courses"]}>
        <Routes>
          <Route path="/courses" element={<CoursesHubPage />} />
          <Route path="/courses/:courseId" element={<CourseProbe />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

const line = (
  id: string | undefined,
  courseName: string,
  n: number,
): GetMyRoundsResponse["rounds"][number] => ({
  roundId: roundId(`r-${courseName}-${n}`),
  courseName,
  ...(id ? { courseId: courseId(id) } : {}),
  tee: "white",
  holes: 18,
  par: 72,
  courseHandicap: 10,
  distribution: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  finalizedAt: 1_000 + n,
});

describe("CoursesHubPage", () => {
  it("renders the Courses heading and CourseSearch", () => {
    renderHub();

    expect(screen.getByRole("heading", { name: "Courses" })).toBeTruthy();
    expect(screen.getByLabelText("Course")).toBeTruthy();
  });

  it("selecting a search result navigates to /courses/{id}", async () => {
    mockedSearchCourses.mockResolvedValue({ courses: [{ courseId: courseId("course-1"), name: "Pebble Beach", holeCount: 18 }] });
    renderHub();

    fireEvent.change(screen.getByLabelText("Course"), { target: { value: "pebble" } });

    // Real timers here (CourseSearch's own >=250ms debounce) — findByRole's default 1000ms
    // waitFor polling window comfortably covers it, the same real-time idiom HomePage.test.tsx
    // uses for its own async assertions.
    const result = await screen.findByRole("button", { name: /Pebble Beach · 18 holes/ });
    fireEvent.click(result);

    expect(await screen.findByText("course page probe: course-1")).toBeTruthy();
  });

  it("signed in with a home course: shows a 'Your home course' card linking to its page", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({
      golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann G", homeCourseId: courseId("home-1") },
    });
    const homeCourseView: CourseView = {
      courseId: courseId("home-1"),
      cardId: "card-1",
      card: { courseName: "Casa Verde GC", teeSets: [] },
      enteredBy: "Ann",
      updatedAtMs: 1_700_000_000_000,
    };
    mockedGetCourse.mockResolvedValue({ course: homeCourseView });

    renderHub();

    const link = await screen.findByRole("link", { name: "Casa Verde GC" });
    expect(link.getAttribute("href")).toBe("/courses/home-1");
    expect(mockedGetCourse).toHaveBeenCalledWith(courseId("home-1"));
  });

  it("signed in with round lines: 'Courses you've played' renders coursesPlayed's rows, skipping the courseId-less line", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetMyRounds.mockResolvedValue({
      rounds: [line("casa-verde", "Casa Verde GC", 1), line("walker", "Walker", 2), line(undefined, "Pre-course-cards Muni", 3)],
    });

    renderHub();

    expect(await screen.findByRole("heading", { name: "Courses you've played" })).toBeTruthy();
    const casaVerde = screen.getByRole("link", { name: /Casa Verde GC · 1 round/ });
    expect(casaVerde.getAttribute("href")).toBe("/courses/casa-verde");
    const walker = screen.getByRole("link", { name: /Walker · 1 round/ });
    expect(walker.getAttribute("href")).toBe("/courses/walker");
    expect(screen.queryByText(/Pre-course-cards Muni/)).toBeNull();
  });

  it("signed out: heading + search + 'Add a course' only — no home course or played-courses sections", () => {
    renderHub();

    expect(screen.getByRole("heading", { name: "Courses" })).toBeTruthy();
    expect(screen.getByLabelText("Course")).toBeTruthy();
    const addLinks = screen.getAllByRole("link", { name: /add a course/i });
    expect(addLinks).toHaveLength(1);
    expect(addLinks[0]?.getAttribute("href")).toBe("/courses/new");
    expect(screen.queryByRole("heading", { name: "Your home course" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Courses you've played" })).toBeNull();
  });
});
