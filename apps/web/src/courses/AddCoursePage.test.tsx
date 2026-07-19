import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courseId, golferId } from "@swng/domain";
import { createCourseRequestSchema } from "@swng/contracts";
import type { CreateCourseRequest } from "@swng/contracts";

// Faking the api.ts module boundary (M5's own idiom) — AddCoursePage only ever calls
// createCourse; getMe backs the AuthProvider wrapper's own GET /me on mount.
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

// A course response in the new CourseView shape (course-cards spec §4) — enough for the two
// tests that read a courseId back off the success navigation.
const courseResponse = (id: string) => ({
  course: {
    courseId: courseId(id),
    cardId: `card-${id}`,
    card: { courseName: "Nowhere GC", teeSets: [{ name: "white", rating: 71.6, slope: 128, holes: [] }] },
    enteredBy: "Ann",
    updatedAtMs: 0,
  },
});

const base64url = (obj: unknown): string =>
  btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

// Signs the AuthProvider in (course entry is "golfer"-gated now) — a saved token with a sub,
// the same idiom CreateRoundPage.test.tsx uses. Returns the idToken so a test can assert the
// exact bearer createCourse received.
const signIn = (): string => {
  const idToken = `${base64url({ alg: "none" })}.${base64url({ sub: "sub-1", email: "signed-in@example.com" })}.sig`;
  tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 3_600_000 });
  return idToken;
};

// Stands in for the real CoursePage (Courses-surface T6) — AddCoursePage now lands there on
// success, not on /create with a preselect hand-off; this stub just proves the courseId rode
// along in the URL itself.
function CoursePageStub() {
  const { courseId } = useParams<{ courseId: string }>();
  return <div>course page — {courseId ?? "none"}</div>;
}

const renderAddCourse = (initialEntry: string | { pathname: string; state?: unknown } = "/courses/new") =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/courses/new" element={<AddCoursePage />} />
          <Route path="/courses/:courseId" element={<CoursePageStub />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

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

const fillHole = (n: number, hole: { par: number; yardage: number; strokeIndex: number }) => {
  fireEvent.change(holeInput(n, "par"), { target: { value: String(hole.par) } });
  fireEvent.change(holeInput(n, "yardage"), { target: { value: String(hole.yardage) } });
  fireEvent.change(holeInput(n, "stroke index"), { target: { value: String(hole.strokeIndex) } });
};

// Waits for the signed-in form to render (the AuthProvider's GET /me settles first).
const awaitForm = async () => {
  await waitFor(() => expect(screen.getByLabelText(/course name/i)).toBeTruthy());
};

beforeEach(() => {
  mockedCreateCourse.mockReset();
  mockedGetMe.mockReset();
  mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("g-ann"), name: "Ann" } });
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AddCoursePage", () => {
  // The wall (course-cards spec §4): adding a course is signed-in-only.
  it("shows a sign-in CTA and NO form when signed out", () => {
    renderAddCourse();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByLabelText(/course name/i)).toBeNull();
    expect(screen.queryByLabelText(/your name/i)).toBeNull();
  });

  it("defaults to 18 holes, par 4, with the grid's DOM order running left-to-right top-to-bottom (the native tab order)", async () => {
    signIn();
    const { container } = renderAddCourse();
    await awaitForm();

    const inputs = [...container.querySelectorAll("input[aria-label^='Hole ']")] as HTMLInputElement[];
    const labels = inputs.map((el) => el.getAttribute("aria-label"));
    const expected = Array.from({ length: 18 }, (_, i) => i + 1).flatMap((n) => [`Hole ${n} par`, `Hole ${n} yardage`, `Hole ${n} stroke index`]);
    expect(labels).toEqual(expected);

    expect((holeInput(1, "par") as HTMLInputElement).value).toBe("4");
    expect((holeInput(18, "par") as HTMLInputElement).value).toBe("4");
  });

  it("fills all 18 rows via keyboard (change) events only, submits the new CreateCourseRequest body with the account Bearer", async () => {
    const idToken = signIn();
    mockedCreateCourse.mockResolvedValue(courseResponse("course-1"));

    renderAddCourse();
    await awaitForm();

    fireEvent.change(screen.getByLabelText(/course name/i), { target: { value: "Fixture Links 18" } });
    fireEvent.change(screen.getByLabelText(/tee name/i), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/rating/i), { target: { value: "71.6" } });
    fireEvent.change(screen.getByLabelText(/slope/i), { target: { value: "128" } });

    PAPER_CARD.forEach((hole, index) => fillHole(index + 1, hole));

    fireEvent.click(screen.getByRole("button", { name: /add course/i }));

    await waitFor(() => expect(mockedCreateCourse).toHaveBeenCalledTimes(1));

    const [body, token] = mockedCreateCourse.mock.calls[0]!;
    expect(body).toEqual({
      name: "Fixture Links 18",
      teeSets: [{ name: "white", rating: 71.6, slope: 128, holes: PAPER_CARD.map((hole, index) => ({ number: index + 1, ...hole })) }],
    });
    expect(token).toBe(idToken); // the account's own bearer, via withAuth
    expect(() => createCourseRequestSchema.parse(body as CreateCourseRequest)).not.toThrow(); // exact wire shape, not just a loose superset
  });

  it("switching to 9 holes rebuilds a 9-row grid", async () => {
    signIn();
    renderAddCourse();
    await awaitForm();
    fireEvent.click(screen.getByRole("radio", { name: "9" }));

    expect(screen.queryByLabelText(/^Hole 10 par$/i)).toBeNull();
    expect(screen.getByLabelText(/^Hole 9 par$/i)).toBeTruthy();
  });

  it("shows a stroke-index remaining hint that never auto-assigns", async () => {
    signIn();
    renderAddCourse();
    await awaitForm();

    expect(screen.getByLabelText(/stroke index remaining/i).textContent).toMatch(/\b1\b/);

    fireEvent.change(holeInput(1, "stroke index"), { target: { value: "1" } });

    expect(screen.getByLabelText(/stroke index remaining/i).textContent).not.toMatch(/\b1\b/);
    expect((holeInput(2, "stroke index") as HTMLInputElement).value).toBe("");
  });

  it("a domain validation rejection renders inline, next to the field its code maps to", async () => {
    signIn();
    mockedCreateCourse.mockRejectedValue(new ApiError("invalid-rating", 400, 'tee "white" rating 200 outside 30..90'));
    renderAddCourse();
    await awaitForm();

    fireEvent.change(screen.getByLabelText(/course name/i), { target: { value: "Nowhere GC" } });
    fireEvent.change(screen.getByLabelText(/tee name/i), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/rating/i), { target: { value: "200" } });
    fireEvent.change(screen.getByLabelText(/slope/i), { target: { value: "128" } });
    PAPER_CARD.forEach((hole, index) => fillHole(index + 1, hole));

    fireEvent.click(screen.getByRole("button", { name: /add course/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/rating 200 outside 30\.\.90/);
    expect(screen.getByLabelText(/^rating$/i).closest("label")?.parentElement?.contains(alert)).toBe(true);
    expect(screen.getByLabelText(/^slope$/i).closest("label")?.parentElement?.contains(alert)).toBe(false);
  });

  it("success navigates to the new course's own hub page", async () => {
    signIn();
    mockedCreateCourse.mockResolvedValue(courseResponse("course-9"));
    renderAddCourse();
    await awaitForm();

    fireEvent.change(screen.getByLabelText(/course name/i), { target: { value: "Nowhere GC" } });
    fireEvent.change(screen.getByLabelText(/tee name/i), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/rating/i), { target: { value: "71.6" } });
    fireEvent.change(screen.getByLabelText(/slope/i), { target: { value: "128" } });
    PAPER_CARD.forEach((hole, index) => fillHole(index + 1, hole));

    fireEvent.click(screen.getByRole("button", { name: /add course/i }));

    await waitFor(() => expect(screen.getByText(/course page — course-9/)).toBeTruthy());
  });

  it("the submit button is disabled until every field is filled", async () => {
    signIn();
    renderAddCourse();
    await awaitForm();
    expect(screen.getByRole("button", { name: /add course/i }).hasAttribute("disabled")).toBe(true);
  });

  it("shows visible column headers over the hole grid, not just aria-labels", async () => {
    signIn();
    renderAddCourse();
    await awaitForm();

    const header = screen.getByTestId("hole-grid-header");
    expect(within(header).getByText("Hole")).toBeTruthy();
    expect(within(header).getByText("Par")).toBeTruthy();
    expect(within(header).getByText("Yards")).toBeTruthy();
    expect(within(header).getByText("SI")).toBeTruthy();
  });

  it("keeps the hole grid's columns inside the card at 375px width (no CSS grid blowout)", async () => {
    signIn();
    const { container } = renderAddCourse();
    await awaitForm();

    const card = container.querySelector("main") as HTMLElement;
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth); // see comment above: 0 <= 0 in happy-dom

    const rows = screen.getAllByTestId("hole-row");
    expect(rows.length).toBe(18);
    rows.forEach((row) => expect(row.className).toContain("grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]"));
    expect(screen.getByTestId("hole-grid-header").className).toContain("grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]");
  });

  it("explains what SI means in plain language, not just the jargon hint", async () => {
    signIn();
    renderAddCourse();
    await awaitForm();
    expect(screen.getByText(/SI = the Handicap\/HDCP row on your scorecard — 1 is the hardest hole\. Type it exactly as printed\./)).toBeTruthy();
  });

  // unrated-courses arc: a card with no course rating is entered by leaving rating/slope blank.
  it("prompts that a card with no rating can leave rating/slope blank", async () => {
    signIn();
    renderAddCourse();
    await awaitForm();
    expect(screen.getByText(/No course rating on the card\? Leave these blank\./)).toBeTruthy();
  });

  it("submits an UNRATED tee (rating/slope blank) with those keys OMITTED — never rating: NaN/undefined on the wire", async () => {
    const idToken = signIn();
    mockedCreateCourse.mockResolvedValue(courseResponse("course-2"));

    renderAddCourse();
    await awaitForm();

    fireEvent.change(screen.getByLabelText(/course name/i), { target: { value: "Muni Nine" } });
    fireEvent.change(screen.getByLabelText(/tee name/i), { target: { value: "white" } });
    // rating + slope left blank — the whole point of the unrated path.
    PAPER_CARD.forEach((hole, index) => fillHole(index + 1, hole));

    // The button is enabled even with no rating/slope — they no longer gate submission.
    expect(screen.getByRole("button", { name: /add course/i }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /add course/i }));

    await waitFor(() => expect(mockedCreateCourse).toHaveBeenCalledTimes(1));
    const [body, token] = mockedCreateCourse.mock.calls[0]!;
    expect(body).toEqual({
      name: "Muni Nine",
      teeSets: [{ name: "white", holes: PAPER_CARD.map((hole, index) => ({ number: index + 1, ...hole })) }],
    });
    // Explicit: the keys are ABSENT, not present-and-undefined.
    expect(body.teeSets[0]).not.toHaveProperty("rating");
    expect(body.teeSets[0]).not.toHaveProperty("slope");
    expect(token).toBe(idToken);
    expect(() => createCourseRequestSchema.parse(body as CreateCourseRequest)).not.toThrow();
  });

  it("a value in exactly ONE of rating/slope submits and surfaces the server's rating-slope-paired error on BOTH fields", async () => {
    signIn();
    mockedCreateCourse.mockRejectedValue(new ApiError("rating-slope-paired", 400, 'tee "white" must set course rating and slope together, or neither (unrated)'));
    renderAddCourse();
    await awaitForm();

    fireEvent.change(screen.getByLabelText(/course name/i), { target: { value: "Half Rated GC" } });
    fireEvent.change(screen.getByLabelText(/tee name/i), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/^rating$/i), { target: { value: "71.6" } }); // rating only — slope blank
    PAPER_CARD.forEach((hole, index) => fillHole(index + 1, hole));

    // One-of-two is a legal SUBMIT (the pairing is the server's call), not a client block.
    expect(screen.getByRole("button", { name: /add course/i }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /add course/i }));

    await waitFor(() => expect(mockedCreateCourse).toHaveBeenCalledTimes(1));
    // The paired error names BOTH inputs — one alert beside rating, one beside slope.
    const alerts = await screen.findAllByRole("alert");
    const paired = alerts.filter((el) => /rating and slope together/.test(el.textContent ?? ""));
    expect(paired.length).toBe(2);
    expect(screen.getByLabelText(/^rating$/i).closest("label")?.parentElement?.contains(paired[0]!) || screen.getByLabelText(/^rating$/i).closest("label")?.parentElement?.contains(paired[1]!)).toBe(true);
    expect(screen.getByLabelText(/^slope$/i).closest("label")?.parentElement?.contains(paired[0]!) || screen.getByLabelText(/^slope$/i).closest("label")?.parentElement?.contains(paired[1]!)).toBe(true);
  });
});
