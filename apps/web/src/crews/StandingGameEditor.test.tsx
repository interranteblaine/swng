import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courseId, fixtureLinks18, golferId } from "@swng/domain";
import type { CourseView, CrewMemberView, StandingGameView } from "@swng/contracts";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary (established idiom, CreateRoundPage.test.tsx et al.) —
// StandingGameEditor (and the CourseSearch it composes) only ever calls these.
vi.mock("../api", () => ({
  getCourse: vi.fn(),
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

import { getCourse, searchCourses } from "../api";
import { StandingGameEditor } from "./StandingGameEditor";

const mockedGetCourse = vi.mocked(getCourse);
const mockedSearchCourses = vi.mocked(searchCourses);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  mockedGetCourse.mockReset();
  mockedSearchCourses.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const courseView: CourseView = {
  courseId: courseId("course-18"),
  name: fixtureLinks18.courseName,
  card: fixtureLinks18,
  teeSets: [{ name: "white", version: 1, provenance: "community", enteredBy: "Ann", verifiedBy: [] }],
};

const members: readonly CrewMemberView[] = [
  { golferId: golferId("ann"), name: "Ann", role: "organizer", claimed: true },
  { golferId: golferId("bo"), name: "Bo", role: "member", claimed: false },
  { golferId: golferId("cy"), name: "Cy", role: "member", claimed: true },
];

describe("StandingGameEditor", () => {
  it("round-trips an existing preset: course/tee load from the preset's courseId, configured games render described by name", async () => {
    mockedGetCourse.mockResolvedValue({ course: courseView });
    const standingGame: StandingGameView = {
      courseId: courseId("course-18"),
      tee: "white",
      games: [{ kind: "singles-match", a: golferId("ann"), b: golferId("bo"), allowance: 1 }],
    };
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(<StandingGameEditor members={members} standingGame={standingGame} onSave={onSave} />);

    await screen.findByText(fixtureLinks18.courseName);
    expect(screen.getByLabelText(/^tee$/i)).toBeTruthy();
    expect(await screen.findByText(/singles match.*ann vs bo/i)).toBeTruthy();
  });

  it("saving PUTs the whole assembled preset via onSave", async () => {
    mockedGetCourse.mockResolvedValue({ course: courseView });
    const standingGame: StandingGameView = { courseId: courseId("course-18"), tee: "white", games: [] };
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(<StandingGameEditor members={members} standingGame={standingGame} onSave={onSave} />);
    await screen.findByText(fixtureLinks18.courseName);

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({ courseId: courseId("course-18"), tee: "white", games: [] });
    await screen.findByText(/saved/i);
  });

  it("adding a game (the SetupPanel game-config idiom) appends it to the preset without saving yet", async () => {
    mockedGetCourse.mockResolvedValue({ course: courseView });
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(<StandingGameEditor members={members} standingGame={{ courseId: courseId("course-18"), tee: "white", games: [] }} onSave={onSave} />);
    await screen.findByText(fixtureLinks18.courseName);

    // Stableford is the AddGameForm's own default kind — just check the players and submit.
    fireEvent.click(screen.getByLabelText("Ann"));
    fireEvent.click(screen.getByLabelText("Bo"));
    fireEvent.click(screen.getByRole("button", { name: /^add game$/i }));

    await screen.findByText(/stableford.*ann, bo/i);
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0]![0] as StandingGameView;
    expect(saved.games).toEqual([{ kind: "stableford", players: [golferId("ann"), golferId("bo")], allowance: expect.any(Number) }]);
  });

  it("removing a configured game drops it from what gets saved", async () => {
    mockedGetCourse.mockResolvedValue({ course: courseView });
    const standingGame: StandingGameView = {
      courseId: courseId("course-18"),
      tee: "white",
      games: [{ kind: "singles-match", a: golferId("ann"), b: golferId("bo"), allowance: 1 }],
    };
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(<StandingGameEditor members={members} standingGame={standingGame} onSave={onSave} />);
    await screen.findByText(fixtureLinks18.courseName);
    await screen.findByText(/singles match.*ann vs bo/i);

    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    expect(screen.queryByText(/singles match.*ann vs bo/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect((onSave.mock.calls[0]![0] as StandingGameView).games).toEqual([]);
  });

  it("no preset yet: renders course search, empty games list, still saveable", async () => {
    vi.useFakeTimers();
    mockedSearchCourses.mockResolvedValue({ courses: [{ courseId: courseId("course-18"), name: fixtureLinks18.courseName }] });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(<StandingGameEditor members={members} onSave={onSave} />);

    expect(screen.getByLabelText(/^course$/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/^course$/i), { target: { value: "fixture" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    fireEvent.click(screen.getByRole("button", { name: fixtureLinks18.courseName }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByLabelText(/^tee$/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    // waitFor polls with REAL timers, which this test has faked (the CourseSearch debounce
    // above needs them) — flush the pending save microtasks through the fake clock instead.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
