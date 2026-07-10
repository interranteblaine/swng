import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courseId } from "@swng/domain";
import { createCourseRequestSchema } from "@swng/contracts";
import type { CreateCourseRequest } from "@swng/contracts";

// Faking the api.ts module boundary (M5's own idiom) — AddCoursePage only ever calls
// createCourse; getMe is here because the AuthProvider wrapper below (auto-fill, M7 Task 6)
// resolves the signed-in golfer through the same mocked module.
vi.mock("../api", () => ({
  createCourse: vi.fn(),
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

import { ApiError, createCourse, getMe } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { AddCoursePage } from "./AddCoursePage";

const mockedCreateCourse = vi.mocked(createCourse);
const mockedGetMe = vi.mocked(getMe);

// Reads back wherever CreateRoundPage would land, so a test can assert the router state
// AddCoursePage's own success navigation hands it, without pulling the real CreateRoundPage
// (and its own api mocks) into this file.
function CreateStub() {
  const location = useLocation();
  const state = location.state as { courseId?: string } | null;
  return <div>create page — preselected {state?.courseId ?? "none"}</div>;
}

const renderAddCourse = (initialEntry: string | { pathname: string; state?: unknown } = "/courses/new") =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/courses/new" element={<AddCoursePage />} />
          <Route path="/create" element={<CreateStub />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

// The paper-card values this suite types in — fixtureWhite18's own numbers (packages/domain's
// golden fixture), reused here rather than invented, so a mistyped test fixture can't quietly
// diverge from a real, already-validated 18-hole card.
const PAPER_CARD: readonly { par: number; yardage: number; strokeIndex: number }[] = [
  { par: 4, yardage: 380, strokeIndex: 9 },
  { par: 4, yardage: 410, strokeIndex: 1 },
  { par: 3, yardage: 165, strokeIndex: 17 },
  { par: 5, yardage: 520, strokeIndex: 5 },
  { par: 4, yardage: 400, strokeIndex: 13 },
  { par: 3, yardage: 180, strokeIndex: 15 },
  { par: 4, yardage: 430, strokeIndex: 3 },
  { par: 5, yardage: 490, strokeIndex: 7 },
  { par: 4, yardage: 390, strokeIndex: 11 },
  { par: 4, yardage: 410, strokeIndex: 2 },
  { par: 3, yardage: 170, strokeIndex: 16 },
  { par: 5, yardage: 530, strokeIndex: 8 },
  { par: 4, yardage: 440, strokeIndex: 4 },
  { par: 4, yardage: 385, strokeIndex: 12 },
  { par: 5, yardage: 500, strokeIndex: 10 },
  { par: 3, yardage: 155, strokeIndex: 18 },
  { par: 4, yardage: 425, strokeIndex: 6 },
  { par: 4, yardage: 395, strokeIndex: 14 },
];

const holeInput = (n: number, field: "par" | "yardage" | "stroke index"): HTMLElement => screen.getByLabelText(new RegExp(`^Hole ${n} ${field}$`, "i"));

// Every grid field, via fireEvent.change ONLY — never fireEvent.click/mouseDown on a grid
// input — matching the brief's "no pointer between fields" (tab-order) contract literally.
const fillHole = (n: number, hole: { par: number; yardage: number; strokeIndex: number }) => {
  fireEvent.change(holeInput(n, "par"), { target: { value: String(hole.par) } });
  fireEvent.change(holeInput(n, "yardage"), { target: { value: String(hole.yardage) } });
  fireEvent.change(holeInput(n, "stroke index"), { target: { value: String(hole.strokeIndex) } });
};

beforeEach(() => {
  mockedCreateCourse.mockReset();
  mockedGetMe.mockReset();
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AddCoursePage", () => {
  it("defaults to 18 holes, par 4, with the grid's DOM order running left-to-right top-to-bottom (the native tab order)", () => {
    const { container } = renderAddCourse();

    const inputs = [...container.querySelectorAll("input[aria-label^='Hole ']")] as HTMLInputElement[];
    const labels = inputs.map((el) => el.getAttribute("aria-label"));
    const expected = Array.from({ length: 18 }, (_, i) => i + 1).flatMap((n) => [`Hole ${n} par`, `Hole ${n} yardage`, `Hole ${n} stroke index`]);
    expect(labels).toEqual(expected);

    // par defaults to 4 (brief) — every par field already carries that value before any typing.
    expect((holeInput(1, "par") as HTMLInputElement).value).toBe("4");
    expect((holeInput(18, "par") as HTMLInputElement).value).toBe("4");
  });

  it("fills all 18 rows via keyboard (change) events only, no pointer interaction with the grid, and submits the exact CreateCourseRequest body", async () => {
    mockedCreateCourse.mockResolvedValue({
      course: {
        courseId: courseId("course-1"),
        name: "Fixture Links 18",
        card: { courseName: "Fixture Links 18", teeSets: [{ name: "white", rating: 71.6, slope: 128, holes: [] }] },
        teeSets: [],
      },
    });

    renderAddCourse();

    fireEvent.change(screen.getByLabelText(/course name/i), { target: { value: "Fixture Links 18" } });
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Ann" } });
    fireEvent.change(screen.getByLabelText(/tee name/i), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/rating/i), { target: { value: "71.6" } });
    fireEvent.change(screen.getByLabelText(/slope/i), { target: { value: "128" } });
    // 18 is the default toggle state (brief) — left untouched.

    PAPER_CARD.forEach((hole, index) => fillHole(index + 1, hole));

    fireEvent.click(screen.getByRole("button", { name: /add course/i }));

    await waitFor(() => expect(mockedCreateCourse).toHaveBeenCalledTimes(1));

    const body = mockedCreateCourse.mock.calls[0]![0] as CreateCourseRequest;
    expect(body).toEqual({
      name: "Fixture Links 18",
      enteredBy: "Ann",
      tee: {
        name: "white",
        rating: 71.6,
        slope: 128,
        holes: PAPER_CARD.map((hole, index) => ({ number: index + 1, ...hole })),
      },
    });
    expect(() => createCourseRequestSchema.parse(body)).not.toThrow(); // exact wire shape, not just a loose superset
  });

  it("switching to 9 holes rebuilds a 9-row grid", () => {
    renderAddCourse();
    fireEvent.click(screen.getByRole("radio", { name: "9" }));

    expect(screen.queryByLabelText(/^Hole 10 par$/i)).toBeNull();
    expect(screen.getByLabelText(/^Hole 9 par$/i)).toBeTruthy();
  });

  it("shows a stroke-index remaining hint that never auto-assigns", () => {
    renderAddCourse();

    expect(screen.getByLabelText(/stroke index remaining/i).textContent).toMatch(/\b1\b/);

    fireEvent.change(holeInput(1, "stroke index"), { target: { value: "1" } });

    expect(screen.getByLabelText(/stroke index remaining/i).textContent).not.toMatch(/\b1\b/);
    // Never auto-assigned: hole 2's SI stays exactly what the golfer typed there — nothing
    // (still blank).
    expect((holeInput(2, "stroke index") as HTMLInputElement).value).toBe("");
  });

  it("a domain validation rejection renders inline, next to the field its code maps to", async () => {
    mockedCreateCourse.mockRejectedValue(new ApiError("invalid-rating", 400, 'tee "white" rating 200 outside 30..90'));
    renderAddCourse();

    fireEvent.change(screen.getByLabelText(/course name/i), { target: { value: "Nowhere GC" } });
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Ann" } });
    fireEvent.change(screen.getByLabelText(/tee name/i), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/rating/i), { target: { value: "200" } });
    fireEvent.change(screen.getByLabelText(/slope/i), { target: { value: "128" } });
    PAPER_CARD.forEach((hole, index) => fillHole(index + 1, hole));

    fireEvent.click(screen.getByRole("button", { name: /add course/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/rating 200 outside 30\.\.90/);
    // Inline next to Rating, not a generic bottom-of-form message: the alert renders inside
    // Rating's own field group (label's parent), not Slope's (or anywhere else in the form).
    expect(screen.getByLabelText(/^rating$/i).closest("label")?.parentElement?.contains(alert)).toBe(true);
    expect(screen.getByLabelText(/^slope$/i).closest("label")?.parentElement?.contains(alert)).toBe(false);
  });

  it("success navigates to /create with the new course preselected", async () => {
    mockedCreateCourse.mockResolvedValue({
      course: {
        courseId: courseId("course-9"),
        name: "Nowhere GC",
        card: { courseName: "Nowhere GC", teeSets: [{ name: "white", rating: 71.6, slope: 128, holes: [] }] },
        teeSets: [],
      },
    });
    renderAddCourse();

    fireEvent.change(screen.getByLabelText(/course name/i), { target: { value: "Nowhere GC" } });
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Ann" } });
    fireEvent.change(screen.getByLabelText(/tee name/i), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/rating/i), { target: { value: "71.6" } });
    fireEvent.change(screen.getByLabelText(/slope/i), { target: { value: "128" } });
    PAPER_CARD.forEach((hole, index) => fillHole(index + 1, hole));

    fireEvent.click(screen.getByRole("button", { name: /add course/i }));

    await waitFor(() => expect(screen.getByText(/create page — preselected course-9/)).toBeTruthy());
  });

  it("the submit button is disabled until every field is filled", () => {
    renderAddCourse();
    expect(screen.getByRole("button", { name: /add course/i }).hasAttribute("disabled")).toBe(true);
  });

  // M7 Task 6 auto-fill (M6 carry): "Your name" defaults to the signed-in golfer's name —
  // still editable, wire unchanged.
  it("defaults 'Your name' to the signed-in golfer's name, still editable", async () => {
    tokenStore.save({ idToken: "header.payload.sig", refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 });
    mockedGetMe.mockResolvedValue({ golfer: { golferId: "g-ann" as never, name: "Ann Signed-In" } });

    renderAddCourse();

    await waitFor(() => expect((screen.getByLabelText(/your name/i) as HTMLInputElement).value).toBe("Ann Signed-In"));

    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Someone Else" } });
    expect((screen.getByLabelText(/your name/i) as HTMLInputElement).value).toBe("Someone Else");
  });

  it("leaves 'Your name' blank when signed out — no phantom default", () => {
    renderAddCourse();
    expect((screen.getByLabelText(/your name/i) as HTMLInputElement).value).toBe("");
  });
});
