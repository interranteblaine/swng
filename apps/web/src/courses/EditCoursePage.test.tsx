import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courseId, fixtureLinks18, fixtureWhite18 } from "@swng/domain";
import { addTeeSetRequestSchema } from "@swng/contracts";
import type { AddTeeSetRequest } from "@swng/contracts";
import type { CourseView } from "@swng/contracts";

// Faking the api.ts module boundary (M5's own idiom) — EditCoursePage only ever calls
// getCourse (to load) and addTeeSet (to revise); getMe is here because the AuthProvider
// wrapper below (the "Your name" auto-fill, M7 Task 6's idiom carried into this page)
// resolves the signed-in golfer through the same mocked module.
vi.mock("../api", () => ({
  getCourse: vi.fn(),
  addTeeSet: vi.fn(),
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

import { ApiError, addTeeSet, getCourse } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { EditCoursePage } from "./EditCoursePage";

const mockedGetCourse = vi.mocked(getCourse);
const mockedAddTeeSet = vi.mocked(addTeeSet);

// Reads back wherever EditCoursePage's success navigation lands, so a test can assert BOTH
// the destination and the state it carries — the same idiom as AddCoursePage.test.tsx's own
// CreateStub / CourseSummaryCard.test.tsx's own EditStub.
function ReturnStub() {
  const location = useLocation();
  const state = location.state as { refreshedCourse?: CourseView } | null;
  return <div>return page — refreshed {state?.refreshedCourse?.teeSets[0]?.version ?? "none"}</div>;
}

const course: CourseView = {
  courseId: courseId("course-18"),
  name: fixtureLinks18.courseName,
  card: fixtureLinks18,
  teeSets: [{ name: fixtureWhite18.name, version: 2, provenance: "community", enteredBy: "Ann", verifiedBy: ["Bo", "Cal"] }],
};

const renderEdit = (locationState?: { readonly teeName?: string; readonly returnTo?: string }) =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[{ pathname: "/courses/course-18/edit", state: locationState ?? null }]}>
        <Routes>
          <Route path="/courses/:courseId/edit" element={<EditCoursePage />} />
          <Route path="/create" element={<ReturnStub />} />
          <Route path="/round/somewhere" element={<ReturnStub />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

beforeEach(() => {
  mockedGetCourse.mockReset();
  mockedAddTeeSet.mockReset();
  mockedGetCourse.mockResolvedValue({ course });
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const holeInput = (n: number, field: "par" | "yardage" | "stroke index"): HTMLElement => screen.getByLabelText(new RegExp(`^Hole ${n} ${field}$`, "i"));

describe("EditCoursePage", () => {
  // I2: the grid pre-fills from the currently fetched tee's EXACT numbers — never blank
  // defaults (that would be AddCoursePage, not a correction flow).
  it("pre-fills the shared grid with the fetched tee's exact rating, slope, and every hole", async () => {
    renderEdit({ teeName: "white" });

    await waitFor(() => expect((screen.getByLabelText(/^rating$/i) as HTMLInputElement).value).toBe("71.6"));
    expect((screen.getByLabelText(/^slope$/i) as HTMLInputElement).value).toBe("128");

    fixtureWhite18.holes.forEach((hole) => {
      expect((holeInput(hole.number, "par") as HTMLInputElement).value).toBe(String(hole.par));
      expect((holeInput(hole.number, "yardage") as HTMLInputElement).value).toBe(String(hole.yardage));
      expect((holeInput(hole.number, "stroke index") as HTMLInputElement).value).toBe(String(hole.strokeIndex));
    });
  });

  it("falls back to the course's first tee when no teeName arrives in router state", async () => {
    renderEdit();
    await waitFor(() => expect((screen.getByLabelText(/^rating$/i) as HTMLInputElement).value).toBe("71.6"));
    expect(screen.getByText(/white tee/i)).toBeTruthy();
  });

  // I2: submit posts the SAME tee name — that's what makes the server treat it as a revision
  // (course.ts's addTeeSet) instead of a brand-new, unrelated tee living alongside this one.
  it("submits addTeeSet with the same tee name and the exact wire shape", async () => {
    mockedAddTeeSet.mockResolvedValue({ course: { ...course, teeSets: [{ ...course.teeSets[0]!, version: 3 }] } });
    renderEdit({ teeName: "white" });
    await waitFor(() => expect((screen.getByLabelText(/^rating$/i) as HTMLInputElement).value).toBe("71.6"));

    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Ann" } });
    // Correct one transposed number — the whole point of this page.
    fireEvent.change(holeInput(2, "stroke index"), { target: { value: "99" } });
    fireEvent.change(holeInput(2, "stroke index"), { target: { value: "1" } });

    fireEvent.click(screen.getByRole("button", { name: /save correction/i }));

    await waitFor(() => expect(mockedAddTeeSet).toHaveBeenCalledTimes(1));
    const [calledCourseId, body] = mockedAddTeeSet.mock.calls[0]! as [string, AddTeeSetRequest];
    expect(calledCourseId).toBe(courseId("course-18"));
    expect(body).toEqual({
      tee: { name: "white", rating: 71.6, slope: 128, holes: fixtureWhite18.holes },
      enteredBy: "Ann",
    });
    expect(() => addTeeSetRequestSchema.parse(body)).not.toThrow();
  });

  // I2: the golfer must know a save resets every existing verification BEFORE they tap save.
  it("shows the unverified-version notice", async () => {
    renderEdit({ teeName: "white" });
    await waitFor(() => expect((screen.getByLabelText(/^rating$/i) as HTMLInputElement).value).toBe("71.6"));

    expect(screen.getByText(/saving creates a corrected, unverified version/i)).toBeTruthy();
  });

  // I2 + M-i: success returns to wherever the golfer came from (CourseSummaryCard's own
  // `returnTo` state), carrying the refreshed CourseView so the destination's held card is
  // never stale — the SAME contract as the verify-409 re-fetch's own onCourseRefreshed call.
  it("on success, navigates back to returnTo carrying the refreshed CourseView", async () => {
    const revised: CourseView = { ...course, teeSets: [{ ...course.teeSets[0]!, version: 3, verifiedBy: [] }] };
    mockedAddTeeSet.mockResolvedValue({ course: revised });
    renderEdit({ teeName: "white", returnTo: "/round/somewhere" });
    await waitFor(() => expect((screen.getByLabelText(/^rating$/i) as HTMLInputElement).value).toBe("71.6"));

    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Ann" } });
    fireEvent.click(screen.getByRole("button", { name: /save correction/i }));

    await waitFor(() => expect(screen.getByText(/return page — refreshed 3/)).toBeTruthy());
  });

  it("defaults to /create when no returnTo arrives in router state", async () => {
    mockedAddTeeSet.mockResolvedValue({ course: { ...course, teeSets: [{ ...course.teeSets[0]!, version: 3 }] } });
    renderEdit({ teeName: "white" });
    await waitFor(() => expect((screen.getByLabelText(/^rating$/i) as HTMLInputElement).value).toBe("71.6"));

    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Ann" } });
    fireEvent.click(screen.getByRole("button", { name: /save correction/i }));

    await waitFor(() => expect(screen.getByText(/return page — refreshed 3/)).toBeTruthy());
  });

  it("a domain validation rejection renders inline, next to the field its code maps to", async () => {
    mockedAddTeeSet.mockRejectedValue(new ApiError("invalid-rating", 400, 'tee "white" rating 200 outside 30..90'));
    renderEdit({ teeName: "white" });
    await waitFor(() => expect((screen.getByLabelText(/^rating$/i) as HTMLInputElement).value).toBe("71.6"));

    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Ann" } });
    fireEvent.change(screen.getByLabelText(/^rating$/i), { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: /save correction/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/rating 200 outside 30\.\.90/);
  });

  it("a course load failure shows an inline error instead of a blank form", async () => {
    mockedGetCourse.mockReset();
    mockedGetCourse.mockRejectedValue(new ApiError("http-404", 404, "no course with that id"));
    renderEdit({ teeName: "white" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no course with that id/);
  });
});
