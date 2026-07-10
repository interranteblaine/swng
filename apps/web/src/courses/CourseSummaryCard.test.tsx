import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courseId } from "@swng/domain";
import type { CourseView } from "@swng/contracts";

// Faking the api.ts module boundary — CourseSummaryCard calls verifyTeeSet and (on a
// tee-set-revised 409) getCourse; getMe is here because the AuthProvider wrapper below
// (verifier-name auto-fill, M7 Task 6) resolves the signed-in golfer through the same
// mocked module.
vi.mock("../api", () => ({
  verifyTeeSet: vi.fn(),
  getCourse: vi.fn(),
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

import { ApiError, getCourse, getMe, verifyTeeSet } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { CourseSummaryCard } from "./CourseSummaryCard";
import type { CourseSummaryCardProps } from "./CourseSummaryCard";

const mockedVerifyTeeSet = vi.mocked(verifyTeeSet);
const mockedGetCourse = vi.mocked(getCourse);
const mockedGetMe = vi.mocked(getMe);

// Reads back whatever "Edit this card" navigated to, so a test can assert the router state
// the Link hands EditCoursePage (teeName + returnTo) without pulling the real EditCoursePage
// (and its own api mocks) into this file — the same idiom as AddCoursePage.test.tsx's own
// CreateStub for AddCoursePage's success navigation.
function EditStub() {
  const location = useLocation();
  return <div>edit page — state {JSON.stringify(location.state)}</div>;
}

// CourseSummaryCard now renders under an AuthProvider in the real app (the verifier prompt's
// auto-fill calls useAuth) — no tokens saved unless a test saves them, so the provider stays
// signed out and fetches nothing by default. A MemoryRouter joined M7 Task 7: "Edit this
// card" is a real <Link>, and reading the current location for its own `returnTo` state
// needs a router context (useLocation) too.
const renderCard = (props: CourseSummaryCardProps, initialEntry: string | { pathname: string; search?: string } = "/create") =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/create" element={<CourseSummaryCard {...props} />} />
          <Route path="/courses/:courseId/edit" element={<EditStub />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
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

beforeEach(() => {
  mockedVerifyTeeSet.mockReset();
  mockedGetCourse.mockReset();
  mockedGetMe.mockReset();
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CourseSummaryCard", () => {
  it("populates the tee picker from card.teeSets and shows verification badges from CourseView.teeSets", () => {
    renderCard({ course, selectedTee: "white", onSelectTee: vi.fn() });

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
    renderCard({ course, selectedTee: "white", onSelectTee });

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

    renderCard({ course, selectedTee: "white", onSelectTee: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: /verify this card/i }));

    await screen.findByText(/✓ 1 verified/i);
    // I1 (M6 closing wave): the version sent is the DISPLAYED card's — CourseView.teeSets[0]'s
    // version (1) for "white" — not omitted.
    expect(mockedVerifyTeeSet).toHaveBeenCalledWith(courseId("course-1"), { teeName: "white", verifierName: "Ed", version: 1 });
  });

  it("a blank/cancelled name prompt never calls verify", () => {
    vi.stubGlobal(
      "prompt",
      vi.fn(() => null),
    );
    renderCard({ course, selectedTee: "white", onSelectTee: vi.fn() });

    fireEvent.click(screen.getByRole("button", { name: /verify this card/i }));

    expect(mockedVerifyTeeSet).not.toHaveBeenCalled();
  });

  // M7 Task 6 auto-fill (M6 carry): the verifier prompt defaults to the signed-in golfer's
  // name (window.prompt's own default-value argument) — still editable, wire unchanged.
  it("defaults the verifier prompt to the signed-in golfer's name", async () => {
    tokenStore.save({ idToken: "header.payload.sig", refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 });
    mockedGetMe.mockResolvedValue({ golfer: { golferId: courseId("g-ann") as never, name: "Ann Signed-In" } });
    const promptSpy = vi.fn(() => "Ann Signed-In");
    vi.stubGlobal("prompt", promptSpy);
    mockedVerifyTeeSet.mockResolvedValue({ course });

    renderCard({ course, selectedTee: "white", onSelectTee: vi.fn() });

    // The golfer name arrives via the provider's async GET /me and nothing on this card
    // renders it — so the retry loop re-taps verify until a prompt call carries the landed
    // default (a stale early tap harmlessly re-verifies with the same mocked response).
    await waitFor(() => {
      fireEvent.click(screen.getByRole("button", { name: /verify this card/i }));
      expect(promptSpy).toHaveBeenCalledWith("Your name, to verify this card:", "Ann Signed-In");
    });
  });

  it("the verifier prompt's default is empty when signed out", () => {
    const promptSpy = vi.fn(() => null);
    vi.stubGlobal("prompt", promptSpy);

    renderCard({ course, selectedTee: "white", onSelectTee: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: /verify this card/i }));

    expect(promptSpy).toHaveBeenCalledWith("Your name, to verify this card:", "");
  });

  it("I1: a tee-set-revised 409 shows an inline notice and re-fetches the course", async () => {
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "Ed"),
    );
    mockedVerifyTeeSet.mockRejectedValue(new ApiError("tee-set-revised", 409, 'tee "white" is now version 2, expected version 1'));
    const revisedCourse: CourseView = {
      ...course,
      card: { ...course.card, teeSets: course.card.teeSets.map((t) => (t.name === "white" ? { ...t, rating: 72.5 } : t)) },
      teeSets: course.teeSets.map((t) => (t.name === "white" ? { ...t, version: 2, enteredBy: "Fran" } : t)),
    };
    mockedGetCourse.mockResolvedValue({ course: revisedCourse });

    renderCard({ course, selectedTee: "white", onSelectTee: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: /verify this card/i }));

    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toMatch(/revised/i);
    expect(mockedGetCourse).toHaveBeenCalledWith(courseId("course-1"));
    // The re-fetched (revised) numbers now render — the golfer sees what actually changed.
    await screen.findByText(/entered by fran/i);
  });

  // M7 Task 7 (M-i): the verify-409 re-fetch is one of the two onCourseRefreshed call sites
  // (the other is CreateRoundPage's own edit-return handling — see CreateRoundPage.test.tsx).
  // Without this, a caller holding this same CourseView (CreateRoundPage's freeze source)
  // never learns about a revision it didn't cause itself.
  it("I1/M-i: a tee-set-revised 409 also calls onCourseRefreshed with the re-fetched course", async () => {
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "Ed"),
    );
    mockedVerifyTeeSet.mockRejectedValue(new ApiError("tee-set-revised", 409, 'tee "white" is now version 2, expected version 1'));
    const revisedCourse: CourseView = {
      ...course,
      teeSets: course.teeSets.map((t) => (t.name === "white" ? { ...t, version: 2, enteredBy: "Fran" } : t)),
    };
    mockedGetCourse.mockResolvedValue({ course: revisedCourse });
    const onCourseRefreshed = vi.fn();

    renderCard({ course, selectedTee: "white", onSelectTee: vi.fn(), onCourseRefreshed });
    fireEvent.click(screen.getByRole("button", { name: /verify this card/i }));

    await waitFor(() => expect(onCourseRefreshed).toHaveBeenCalledWith(revisedCourse));
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
