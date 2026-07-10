import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courseId, fixtureLinks18, fixtureWhite18, golferId, roundId } from "@swng/domain";
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

import { ApiError, createRound, getCourse, searchCourses, verifyTeeSet } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { CreateRoundPage } from "./CreateRoundPage";

const mockedCreateRound = vi.mocked(createRound);
const mockedGetCourse = vi.mocked(getCourse);
const mockedSearchCourses = vi.mocked(searchCourses);
const mockedVerifyTeeSet = vi.mocked(verifyTeeSet);

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
  mockedVerifyTeeSet.mockReset();
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

  // M7 Task 7 (M-i): before this fix, CourseSummaryCard's own verify-409 re-fetch kept ITS
  // OWN local state current but never told CreateRoundPage — a mid-setup revision race could
  // freeze the stale (internally consistent) card into the round (papercuts.md #3). Proven the
  // strongest way available: submit afterward and check createRound got the REVISED card, not
  // the one this page originally fetched.
  it("M-i: a verify-409 re-fetch replaces THIS page's held card, not just CourseSummaryCard's own local copy", async () => {
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "Ed"),
    );
    mockedVerifyTeeSet.mockRejectedValue(new ApiError("tee-set-revised", 409, 'tee "white" is now version 2, expected version 1'));
    const revisedCard = { ...fixtureLinks18, teeSets: [{ ...fixtureWhite18, rating: 68.8 }] };
    const revisedCourseView: CourseView = { ...courseView, card: revisedCard, teeSets: [{ ...courseView.teeSets[0]!, version: 2, enteredBy: "Fran" }] };
    // Two getCourse calls: the initial select-course fetch, then the verify-409 handler's own
    // re-fetch — distinct calls, distinct (revised) responses.
    mockedGetCourse.mockResolvedValueOnce({ course: courseView }).mockResolvedValueOnce({ course: revisedCourseView });
    mockedCreateRound.mockResolvedValue({ roundId: roundId("round-mi-1"), joinCode: "CCC222", token: "tok-mi-1", golferId: golferId("dee") });

    renderCreate({ pathname: "/create", state: { courseId: courseId("course-18") } });
    await screen.findByText(fixtureLinks18.courseName);

    fireEvent.click(screen.getByRole("button", { name: /verify this card/i }));
    await screen.findByText(/entered by fran/i);

    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Dee" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: /create round/i }));

    await waitFor(() => expect(mockedCreateRound).toHaveBeenCalledTimes(1));
    const body = mockedCreateRound.mock.calls[0]![0];
    expect(body.card).toEqual(revisedCard); // the freeze source swap, not the stale original
  });

  // M7 Task 7 (M-i): the edit flow's own onCourseRefreshed call site — EditCoursePage's
  // success hand-off (router state, no re-fetch needed: the response already carries the full
  // CourseView). Mirrors the verify-409 test above; this is the SECOND of the two sites the
  // brief names.
  it("M-i: EditCoursePage's return hand-off (refreshedCourse router state) replaces this page's held card", async () => {
    const revisedCard = { ...fixtureLinks18, teeSets: [{ ...fixtureWhite18, rating: 65.1 }] };
    const revisedCourseView: CourseView = { ...courseView, card: revisedCard, teeSets: [{ ...courseView.teeSets[0]!, version: 3 }] };
    mockedCreateRound.mockResolvedValue({ roundId: roundId("round-mi-2"), joinCode: "DDD333", token: "tok-mi-2", golferId: golferId("cy") });

    renderCreate({ pathname: "/create", state: { refreshedCourse: revisedCourseView } });
    await screen.findByText(revisedCourseView.name);
    expect(mockedGetCourse).not.toHaveBeenCalled(); // no re-fetch needed — EditCoursePage already returned the full CourseView

    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Cy" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /create round/i }));

    await waitFor(() => expect(mockedCreateRound).toHaveBeenCalledTimes(1));
    const body = mockedCreateRound.mock.calls[0]![0];
    expect(body.card).toEqual(revisedCard);
  });
});
