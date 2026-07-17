import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courseId, fixtureWhite, golferId, teeId } from "@swng/domain";
import { supersedeCardRequestSchema } from "@swng/contracts";
import type { CourseView, SupersedeCardRequest } from "@swng/contracts";

// Faking the api.ts module boundary (M5's own idiom) — EditCoursePage only ever calls
// getCourse/supersedeCard; getMe backs the AuthProvider wrapper's own GET /me on mount.
vi.mock("../api", () => ({
  getCourse: vi.fn(),
  supersedeCard: vi.fn(),
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

import { ApiError, getCourse, getMe, supersedeCard } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { EditCoursePage } from "./EditCoursePage";

const mockedGetCourse = vi.mocked(getCourse);
const mockedSupersedeCard = vi.mocked(supersedeCard);
const mockedGetMe = vi.mocked(getMe);

// A real 9-hole card — fixtureWhite is the domain's own shared 9-hole fixture (strokes.test.ts
// etc.), reused rather than hand-rolled so its SI column is already a genuine 1..9 permutation.
// "blue" is the same 9 holes, shifted 40 yards longer, so hole-by-hole values are distinguishable
// after a tee switch. Both tees carry a teeId, mirroring every stored card in reality (course.ts's
// own "present on every stored and newly-frozen card by construction").
const baseView: CourseView = {
  courseId: courseId("course-1"),
  cardId: "card-1",
  card: {
    courseName: "Fixture Links",
    teeSets: [
      { teeId: teeId("tee-white"), name: "white", rating: fixtureWhite.rating, slope: fixtureWhite.slope, holes: fixtureWhite.holes },
      {
        teeId: teeId("tee-blue"),
        name: "blue",
        rating: 74,
        slope: 135,
        holes: fixtureWhite.holes.map((hole) => ({ ...hole, yardage: hole.yardage + 40 })),
      },
    ],
  },
  enteredBy: "Ann",
  updatedAtMs: 1_700_000_000_000,
};

// A complete 9-hole tee, filled hole-by-hole in the addTee test below — every field must
// parse (holesAreComplete) before the submit button is even enabled, so all 9 rows need real
// values, not just the first couple.
const NEW_TEE_HOLES: readonly { par: number; yardage: number; strokeIndex: number }[] = Array.from({ length: 9 }, (_, i) => ({
  par: 4,
  yardage: 300 + i * 10,
  strokeIndex: i + 1,
}));

const base64url = (obj: unknown): string =>
  btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

// Signs the AuthProvider in (correcting a card is "golfer"-gated) — same idiom as
// AddCoursePage.test.tsx's own signIn helper. Returns the idToken so a test can assert the
// exact bearer supersedeCard received.
const signIn = (): string => {
  const idToken = `${base64url({ alg: "none" })}.${base64url({ sub: "sub-1", email: "signed-in@example.com" })}.sig`;
  tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 });
  return idToken;
};

// Stands in for CoursePage — proves the post-save navigation target (`/courses/${id}`).
function CourseStub() {
  const { courseId: param } = useParams<{ courseId: string }>();
  return <div>course page — {param}</div>;
}

const renderEditPage = (initialEntry: string | { pathname: string; state?: unknown } = "/courses/course-1/edit") =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/courses/:courseId/edit" element={<EditCoursePage />} />
          <Route path="/courses/:courseId" element={<CourseStub />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

const holeInput = (n: number, field: "par" | "yardage" | "stroke index"): HTMLElement => screen.getByLabelText(new RegExp(`^Hole ${n} ${field}$`, "i"));

// Waits for the signed-in, loaded form to render (AuthProvider's GET /me + getCourse both settle first).
const awaitForm = async () => {
  await waitFor(() => expect(screen.getByLabelText(/^course name$/i)).toBeTruthy());
};

beforeEach(() => {
  mockedGetCourse.mockReset();
  mockedSupersedeCard.mockReset();
  mockedGetMe.mockReset();
  mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("g-ann"), name: "Ann" } });
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EditCoursePage", () => {
  it("shows a sign-in CTA and no form when signed out", async () => {
    mockedGetCourse.mockResolvedValue({ course: baseView });
    renderEditPage();

    await waitFor(() => expect(mockedGetCourse).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByLabelText(/^course name$/i)).toBeNull();
  });

  it("edit mode pre-fills the card's first tee, and NEVER renders the hole-count toggle", async () => {
    signIn();
    mockedGetCourse.mockResolvedValue({ course: baseView });
    renderEditPage();
    await awaitForm();

    expect((screen.getByLabelText(/^course name$/i) as HTMLInputElement).value).toBe("Fixture Links");
    expect((screen.getByLabelText(/^tee name$/i) as HTMLInputElement).value).toBe("white");
    expect((screen.getByLabelText(/^rating$/i) as HTMLInputElement).value).toBe(String(fixtureWhite.rating));
    expect((screen.getByLabelText(/^slope$/i) as HTMLInputElement).value).toBe(String(fixtureWhite.slope));
    expect((holeInput(1, "yardage") as HTMLInputElement).value).toBe(String(fixtureWhite.holes[0]!.yardage));
    expect((holeInput(2, "yardage") as HTMLInputElement).value).toBe(String(fixtureWhite.holes[1]!.yardage));

    // The IMPORTANT UX constraint: an existing card's hole count is fixed by its OTHER tees —
    // no toggle exists here to break that invariant from the UI (HoleGrid's own radiogroup).
    expect(screen.queryByRole("radiogroup", { name: /holes/i })).toBeNull();
  });

  it("edit mode: submits the whole card with the edited tee's teeId preserved, a rename, and supersedes = loaded cardId", async () => {
    const idToken = signIn();
    mockedGetCourse.mockResolvedValue({ course: baseView });
    mockedSupersedeCard.mockResolvedValue({ course: { ...baseView, cardId: "card-2" } });

    renderEditPage();
    await awaitForm();

    fireEvent.change(screen.getByLabelText(/^course name$/i), { target: { value: "Fixture Links Renamed" } });
    fireEvent.change(screen.getByLabelText(/^rating$/i), { target: { value: "72.1" } });

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(mockedSupersedeCard).toHaveBeenCalledTimes(1));
    const [calledCourseId, body, token] = mockedSupersedeCard.mock.calls[0]!;
    expect(calledCourseId).toBe(courseId("course-1"));
    expect(body).toEqual({
      name: "Fixture Links Renamed",
      supersedes: "card-1",
      teeSets: [
        { teeId: teeId("tee-white"), name: "white", rating: 72.1, slope: 128, holes: baseView.card.teeSets[0]!.holes },
        { teeId: teeId("tee-blue"), name: "blue", rating: 74, slope: 135, holes: baseView.card.teeSets[1]!.holes },
      ],
    });
    expect(token).toBe(idToken);
    expect(() => supersedeCardRequestSchema.parse(body as SupersedeCardRequest)).not.toThrow(); // exact wire shape, not just a loose superset

    await waitFor(() => expect(screen.getByText(/course page — course-1/)).toBeTruthy());
  });

  it("switching the tee picker re-seeds the form from THAT tee, and submitting replaces it in place (order + teeId preserved)", async () => {
    signIn();
    mockedGetCourse.mockResolvedValue({ course: baseView });
    mockedSupersedeCard.mockResolvedValue({ course: baseView });
    renderEditPage();
    await awaitForm();

    fireEvent.change(screen.getByLabelText(/tee to edit/i), { target: { value: "blue" } });
    expect((screen.getByLabelText(/^tee name$/i) as HTMLInputElement).value).toBe("blue");
    expect((screen.getByLabelText(/^rating$/i) as HTMLInputElement).value).toBe("74");
    expect((holeInput(1, "yardage") as HTMLInputElement).value).toBe("420");

    fireEvent.change(screen.getByLabelText(/^rating$/i), { target: { value: "75.5" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(mockedSupersedeCard).toHaveBeenCalledTimes(1));
    const [, body] = mockedSupersedeCard.mock.calls[0]!;
    expect(body).toEqual({
      name: "Fixture Links",
      supersedes: "card-1",
      teeSets: [
        { teeId: teeId("tee-white"), name: "white", rating: fixtureWhite.rating, slope: fixtureWhite.slope, holes: baseView.card.teeSets[0]!.holes },
        { teeId: teeId("tee-blue"), name: "blue", rating: 75.5, slope: 135, holes: baseView.card.teeSets[1]!.holes },
      ],
    });
  });

  it("renaming the tee being edited still replaces it IN PLACE under the SAME teeId — identity tracks the original name, not the live input", async () => {
    signIn();
    mockedGetCourse.mockResolvedValue({ course: baseView });
    mockedSupersedeCard.mockResolvedValue({ course: baseView });
    renderEditPage();
    await awaitForm(); // defaults to the first tee, "white"

    fireEvent.change(screen.getByLabelText(/^tee name$/i), { target: { value: "white tees" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(mockedSupersedeCard).toHaveBeenCalledTimes(1));
    const [, body] = mockedSupersedeCard.mock.calls[0]!;
    expect(body).toEqual({
      name: "Fixture Links",
      supersedes: "card-1",
      teeSets: [
        // Renamed, but the SAME teeId — a rename is not a delete+add, and it stays in its
        // original (first) slot rather than moving to the end.
        { teeId: teeId("tee-white"), name: "white tees", rating: fixtureWhite.rating, slope: fixtureWhite.slope, holes: baseView.card.teeSets[0]!.holes },
        { teeId: teeId("tee-blue"), name: "blue", rating: 74, slope: 135, holes: baseView.card.teeSets[1]!.holes },
      ],
    });
  });

  it("addTee mode: no tee picker, a blank tee at the card's own hole count, and submits every original tee verbatim plus one id-less new tee", async () => {
    signIn();
    mockedGetCourse.mockResolvedValue({ course: baseView });
    mockedSupersedeCard.mockResolvedValue({ course: baseView });

    renderEditPage({ pathname: "/courses/course-1/edit", state: { addTee: true } });
    await awaitForm();

    expect(screen.queryByLabelText(/tee to edit/i)).toBeNull();
    expect((screen.getByLabelText(/^tee name$/i) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/^rating$/i) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/^slope$/i) as HTMLInputElement).value).toBe("");
    // The card's own hole count (9, from baseView's fixtureWhite-derived tees) — no toggle
    // exists here to set anything else (the IMPORTANT UX constraint).
    expect(screen.getAllByTestId("hole-row").length).toBe(9);
    expect(screen.queryByRole("radiogroup", { name: /holes/i })).toBeNull();

    fireEvent.change(screen.getByLabelText(/^tee name$/i), { target: { value: "gold" } });
    fireEvent.change(screen.getByLabelText(/^rating$/i), { target: { value: "76.2" } });
    fireEvent.change(screen.getByLabelText(/^slope$/i), { target: { value: "142" } });
    NEW_TEE_HOLES.forEach((hole, index) => {
      fireEvent.change(holeInput(index + 1, "par"), { target: { value: String(hole.par) } });
      fireEvent.change(holeInput(index + 1, "yardage"), { target: { value: String(hole.yardage) } });
      fireEvent.change(holeInput(index + 1, "stroke index"), { target: { value: String(hole.strokeIndex) } });
    });

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(mockedSupersedeCard).toHaveBeenCalledTimes(1));
    const [, body] = mockedSupersedeCard.mock.calls[0]!;
    expect(body).toEqual({
      name: "Fixture Links",
      supersedes: "card-1",
      teeSets: [
        { teeId: teeId("tee-white"), name: "white", rating: fixtureWhite.rating, slope: fixtureWhite.slope, holes: baseView.card.teeSets[0]!.holes },
        { teeId: teeId("tee-blue"), name: "blue", rating: 74, slope: 135, holes: baseView.card.teeSets[1]!.holes },
        {
          name: "gold",
          rating: 76.2,
          slope: 142,
          holes: NEW_TEE_HOLES.map((hole, index) => ({ number: index + 1, ...hole })),
        },
      ],
    });
    expect(() => supersedeCardRequestSchema.parse(body as SupersedeCardRequest)).not.toThrow();
  });

  it("a stale supersedes (409 card-superseded) re-fetches the card, re-seeds the form from it, and shows a notice — no auto-retry", async () => {
    signIn();
    mockedGetCourse.mockResolvedValueOnce({ course: baseView });
    mockedSupersedeCard.mockRejectedValueOnce(new ApiError("card-superseded", 409, "course course-1: the card being replaced is no longer current"));
    const refreshedView: CourseView = {
      ...baseView,
      cardId: "card-2",
      card: { ...baseView.card, teeSets: [{ ...baseView.card.teeSets[0]!, rating: 73 }, baseView.card.teeSets[1]!] },
    };
    mockedGetCourse.mockResolvedValueOnce({ course: refreshedView });

    renderEditPage();
    await awaitForm();

    fireEvent.change(screen.getByLabelText(/^rating$/i), { target: { value: "72.1" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByText(/this card was just updated — review the new numbers/i)).toBeTruthy();
    expect(mockedGetCourse).toHaveBeenCalledTimes(2);
    // Re-seeded from the FRESH card — the golfer's now-stale 72.1 never survives the re-seed.
    expect((screen.getByLabelText(/^rating$/i) as HTMLInputElement).value).toBe("73");
    expect(mockedSupersedeCard).toHaveBeenCalledTimes(1); // no silent auto-retry — the golfer reviews, then resubmits
  });

  it("a duplicate-tee-name rejection renders inline next to the tee name field", async () => {
    signIn();
    mockedGetCourse.mockResolvedValue({ course: baseView });
    mockedSupersedeCard.mockRejectedValue(new ApiError("duplicate-tee-name", 400, "tee names must be unique (case-insensitive) within a card"));
    renderEditPage();
    await awaitForm();

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/tee names must be unique/);
    expect(screen.getByLabelText(/^tee name$/i).closest("label")?.parentElement?.contains(alert)).toBe(true);
  });

  it("the submit button is disabled until every field is filled", async () => {
    signIn();
    mockedGetCourse.mockResolvedValue({ course: baseView });
    renderEditPage();
    await awaitForm();
    // Pre-filled from the first tee already — everything required is present.
    expect(screen.getByRole("button", { name: /save changes/i }).hasAttribute("disabled")).toBe(false);

    fireEvent.change(screen.getByLabelText(/^tee name$/i), { target: { value: "" } });
    expect(screen.getByRole("button", { name: /save changes/i }).hasAttribute("disabled")).toBe(true);
  });

  // unrated-courses arc: an UNRATED card must round-trip through a supersede untouched — both the
  // edited tee AND the carried-over other tee stay unrated (no rating/slope on the wire). This is
  // the carryOver rework: the old placeholder THREW `tee-unrated`, so this whole flow used to be
  // impossible (submit never even reached supersedeCard).
  const unratedBaseView: CourseView = {
    courseId: courseId("course-1"),
    cardId: "card-1",
    card: {
      courseName: "Muni Nine",
      teeSets: [
        { teeId: teeId("tee-white"), name: "white", holes: fixtureWhite.holes }, // unrated (no rating/slope)
        { teeId: teeId("tee-blue"), name: "blue", holes: fixtureWhite.holes.map((hole) => ({ ...hole, yardage: hole.yardage + 40 })) }, // unrated
      ],
    },
    enteredBy: "Ann",
    updatedAtMs: 1_700_000_000_000,
  };

  it("seeds blank rating/slope for an unrated tee (never the string 'undefined')", async () => {
    signIn();
    mockedGetCourse.mockResolvedValue({ course: unratedBaseView });
    renderEditPage();
    await awaitForm();

    expect((screen.getByLabelText(/^rating$/i) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/^slope$/i) as HTMLInputElement).value).toBe("");
  });

  it("supersedes an unrated card verbatim — the edited tee AND the carried-over tee both omit rating/slope", async () => {
    signIn();
    mockedGetCourse.mockResolvedValue({ course: unratedBaseView });
    mockedSupersedeCard.mockResolvedValue({ course: unratedBaseView });
    renderEditPage();
    await awaitForm();

    // Rename the (unrated) white tee but leave it unrated; blue carries over untouched.
    fireEvent.change(screen.getByLabelText(/^tee name$/i), { target: { value: "white tees" } });
    expect(screen.getByRole("button", { name: /save changes/i }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(mockedSupersedeCard).toHaveBeenCalledTimes(1));
    const [, body] = mockedSupersedeCard.mock.calls[0]!;
    expect(body).toEqual({
      name: "Muni Nine",
      supersedes: "card-1",
      teeSets: [
        { teeId: teeId("tee-white"), name: "white tees", holes: unratedBaseView.card.teeSets[0]!.holes },
        { teeId: teeId("tee-blue"), name: "blue", holes: unratedBaseView.card.teeSets[1]!.holes },
      ],
    });
    // toEqual ignores present-but-undefined keys — assert ABSENCE explicitly (no rating: undefined).
    expect(body.teeSets[0]).not.toHaveProperty("rating");
    expect(body.teeSets[0]).not.toHaveProperty("slope");
    expect(body.teeSets[1]).not.toHaveProperty("rating");
    expect(body.teeSets[1]).not.toHaveProperty("slope");
    expect(() => supersedeCardRequestSchema.parse(body as SupersedeCardRequest)).not.toThrow();
  });

  it("a value in exactly ONE of rating/slope surfaces the server's rating-slope-paired error on BOTH fields", async () => {
    signIn();
    mockedGetCourse.mockResolvedValue({ course: baseView });
    mockedSupersedeCard.mockRejectedValue(new ApiError("rating-slope-paired", 400, 'tee "white" must set course rating and slope together, or neither (unrated)'));
    renderEditPage();
    await awaitForm();

    fireEvent.change(screen.getByLabelText(/^slope$/i), { target: { value: "" } }); // rating kept, slope blanked
    expect(screen.getByRole("button", { name: /save changes/i }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(mockedSupersedeCard).toHaveBeenCalledTimes(1));
    const alerts = await screen.findAllByRole("alert");
    const paired = alerts.filter((el) => /rating and slope together/.test(el.textContent ?? ""));
    expect(paired.length).toBe(2);
  });

  it("prompts that a card with no rating can leave rating/slope blank", async () => {
    signIn();
    mockedGetCourse.mockResolvedValue({ course: baseView });
    renderEditPage();
    await awaitForm();
    expect(screen.getByText(/No course rating on the card\? Leave these blank\./)).toBeTruthy();
  });
});
