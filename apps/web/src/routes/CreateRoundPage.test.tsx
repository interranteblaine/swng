import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courseId, fixtureLinks18, golferId, roundId } from "@swng/domain";
import { startRoundRequestSchema } from "@swng/contracts";
import type { CourseView } from "@swng/contracts";
import { credentialStore } from "../identity";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary (M5's own idiom) — CreateRoundPage (and the CourseSearch/
// CourseSummaryCard it composes) only ever calls these four; getMe is here because the
// AuthProvider wrapper below (CourseSummaryCard's verifier auto-fill, M7 Task 6) resolves
// the signed-in golfer through the same mocked module.
vi.mock("../api", () => ({
  createRound: vi.fn(),
  getCourse: vi.fn(),
  searchCourses: vi.fn(),
  verifyTeeSet: vi.fn(),
  getMe: vi.fn(),
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

import { createRound, getCourse, searchCourses } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { CreateRoundPage } from "./CreateRoundPage";

const mockedCreateRound = vi.mocked(createRound);
const mockedGetCourse = vi.mocked(getCourse);
const mockedSearchCourses = vi.mocked(searchCourses);

const courseView: CourseView = {
  courseId: courseId("course-18"),
  name: fixtureLinks18.courseName,
  card: fixtureLinks18,
  teeSets: [{ name: "white", version: 1, provenance: "community", enteredBy: "Ann", verifiedBy: [] }],
};

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  mockedCreateRound.mockReset();
  mockedGetCourse.mockReset();
  mockedSearchCourses.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const renderCreate = (initialEntry: string | { pathname: string; state?: unknown } = "/create") =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/create" element={<CreateRoundPage />} />
          <Route path="/round/:roundId" element={<div>round view</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

describe("CreateRoundPage", () => {
  it("a preselected courseId (router state) fetches the course and sends startRound the fetched card verbatim", async () => {
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedCreateRound.mockResolvedValue({ roundId: roundId("round-9"), joinCode: "ZZZ999", token: "tok-9", golferId: golferId("ann") });

    renderCreate({ pathname: "/create", state: { courseId: courseId("course-18") } });

    await waitFor(() => expect(mockedGetCourse).toHaveBeenCalledWith(courseId("course-18")));
    await screen.findByText(fixtureLinks18.courseName);

    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Ann" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: /create round/i }));

    await waitFor(() => expect(mockedCreateRound).toHaveBeenCalledTimes(1));

    const body = mockedCreateRound.mock.calls[0]![0];
    // Deep-equal against the EXACT card getCourse returned — the freeze source swap, not a
    // reconstruction (brief's own literal check).
    expect(body).toEqual({ card: fixtureLinks18, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    expect(() => startRoundRequestSchema.parse(body)).not.toThrow();

    await waitFor(() => expect(screen.getByText("round view")).toBeTruthy());
    expect(credentialStore.load(roundId("round-9"))).toEqual({ token: "tok-9", golferId: golferId("ann"), name: "Ann", joinCode: "ZZZ999" });
  });

  it("accepts a negative (plus) course handicap", async () => {
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedCreateRound.mockResolvedValue({ roundId: roundId("round-10"), joinCode: "AAA000", token: "tok-10", golferId: golferId("bo") });

    renderCreate({ pathname: "/create", state: { courseId: courseId("course-18") } });
    await screen.findByText(fixtureLinks18.courseName);

    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Bo" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "-3" } });
    fireEvent.click(screen.getByRole("button", { name: /create round/i }));

    await waitFor(() => expect(mockedCreateRound).toHaveBeenCalledTimes(1));
    const body = mockedCreateRound.mock.calls[0]![0];
    expect(body.host.courseHandicap).toBe(-3);
  });

  it("submit is disabled until a course is picked", () => {
    renderCreate();
    expect(screen.getByRole("button", { name: /create round/i }).hasAttribute("disabled")).toBe(true);
  });

  it("search → pick a result → the tee picker + verification badges populate from the fetched CourseView", async () => {
    vi.useFakeTimers();
    mockedSearchCourses.mockResolvedValue({ courses: [{ courseId: courseId("course-18"), name: fixtureLinks18.courseName }] });
    mockedGetCourse.mockResolvedValue({ course: courseView });

    renderCreate();

    fireEvent.change(screen.getByLabelText(/^course$/i), { target: { value: "fixture" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    fireEvent.click(screen.getByRole("button", { name: fixtureLinks18.courseName }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockedGetCourse).toHaveBeenCalledWith(courseId("course-18"));
    expect(screen.getByLabelText(/^tee$/i)).toBeTruthy();
    expect(screen.getByText(/entered by ann/i)).toBeTruthy();
  });
});
