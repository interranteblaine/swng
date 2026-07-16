import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courseId, fixtureLinks18, fixtureWhite18, golferId, roundId } from "@swng/domain";
import { startRoundRequestSchema } from "@swng/contracts";
import type { CourseView, GetMeResponse, GetMyRecordResponse } from "@swng/contracts";
import { credentialStore } from "../identity";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary (M5's own idiom) — CreateRoundPage (and the CourseSearch/
// CourseSummaryCard it composes) only ever calls these; getMe backs the AuthProvider wrapper.
// The wall (accounts-only identity spec §3): creating a round is signed-in-only now, always as
// the caller's own account golfer — there is no anonymous or free-text-name create path, so no
// updateMe here.
vi.mock("../api", () => ({
  createRound: vi.fn(),
  getCourse: vi.fn(),
  searchCourses: vi.fn(),
  getMe: vi.fn(),
  // The suggested-course-handicap fetch (unrated-courses T5b) — defaulted to an empty record in
  // beforeEach so the pre-existing cases (no declared, no metrics) show no suggestion and their
  // manual handicap entry is unaffected; the suggestion cases below stub a real metric.
  getMyRecord: vi.fn(),
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

import { ApiError, createRound, getCourse, getMe, getMyRecord, searchCourses } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { CreateRoundPage } from "./CreateRoundPage";
import { courseHandicapFor } from "@swng/domain";

const mockedCreateRound = vi.mocked(createRound);
const mockedGetCourse = vi.mocked(getCourse);
const mockedSearchCourses = vi.mocked(searchCourses);
const mockedGetMe = vi.mocked(getMe);
const mockedGetMyRecord = vi.mocked(getMyRecord);

const courseView: CourseView = {
  courseId: courseId("course-18"),
  cardId: "card-18",
  card: fixtureLinks18,
  enteredBy: "Ann",
  updatedAtMs: 1_700_000_000_000,
};

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  mockedCreateRound.mockReset();
  mockedGetCourse.mockReset();
  mockedSearchCourses.mockReset();
  mockedGetMe.mockReset();
  mockedGetMyRecord.mockReset();
  mockedGetMyRecord.mockResolvedValue({ metrics: {}, history: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const base64url = (obj: unknown): string =>
  btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const signIn = (): string => {
  const idToken = `${base64url({ alg: "none" })}.${base64url({ sub: "sub-1", email: "signed-in@example.com" })}.sig`;
  tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 });
  return idToken;
};

// A plain probe standing in for the real RoundPage (and its own session/transport machinery),
// so these tests only assert that navigation landed on /round/:roundId.
function RoundStub() {
  return <p>round view</p>;
}

const renderCreate = (initialEntry: string | { pathname: string; state?: unknown } = "/create") =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/create" element={<CreateRoundPage />} />
          <Route path="/round/:roundId" element={<RoundStub />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

// The wall (accounts-only identity spec §3): starting a round is signed-in-only. Signed out, the
// page is a sign-in funnel, not a form.
describe("CreateRoundPage — signed out", () => {
  it("shows a sign-in CTA and NO create form — no course search, no create button", () => {
    renderCreate();

    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByLabelText(/^course$/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /create round/i })).toBeNull();
    expect(screen.queryByLabelText(/your name/i)).toBeNull();
  });

  it("the sign-in CTA preserves a return to /create across the round trip", () => {
    renderCreate();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(sessionStorage.getItem("swng:returnTo")).toBe("/create");
  });
});

// Signed in, a round is created AS the caller's own account golfer — host.name is the account's
// name, never a typed input (the field is gone).
describe("CreateRoundPage — create as yourself", () => {
  it("a preselected courseId sends startRound the fetched card verbatim + the tee/handicap + the account's Bearer (seat resolved server-side)", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedCreateRound.mockResolvedValue({ roundId: roundId("round-9"), joinCode: "ZZZ999", token: "tok-9", golferId: golferId("ann-g") });

    renderCreate({ pathname: "/create", state: { courseId: courseId("course-18") } });

    await waitFor(() => expect(mockedGetCourse).toHaveBeenCalledWith(courseId("course-18")));
    await screen.findByText(fixtureLinks18.courseName);
    await screen.findByText(/playing as/i);
    expect(screen.getByText("Ann G")).toBeTruthy();
    // The proof-of-negative: no free-text host-name field — the name is the account's.
    expect(screen.queryByLabelText(/your name/i)).toBeNull();

    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: /create round/i }));

    await waitFor(() => expect(mockedCreateRound).toHaveBeenCalledTimes(1));
    const [body, token] = mockedCreateRound.mock.calls[0]!;
    // Course-cards spec §4: a REFERENCE (courseId + cardId), never a card — the server resolves
    // and freezes the lineage's current card itself. Accounts-only identity (spec §3): the
    // request carries only that reference + host tee/courseHandicap — the seat (name + golferId)
    // is resolved server-side from the Bearer.
    expect(body).toEqual({ course: { courseId: courseView.courseId, cardId: courseView.cardId }, host: { tee: "white", courseHandicap: 8 } });
    expect(token).toBe(idToken);
    expect(() => startRoundRequestSchema.parse(body)).not.toThrow();

    await waitFor(() => expect(screen.getByText("round view")).toBeTruthy());
    expect(credentialStore.load(roundId("round-9"))).toEqual({ token: "tok-9", golferId: golferId("ann-g"), name: "Ann G", joinCode: "ZZZ999" });
  });

  it("accepts a negative (plus) course handicap", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("bo-g"), name: "Bo G" } });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedCreateRound.mockResolvedValue({ roundId: roundId("round-10"), joinCode: "AAA000", token: "tok-10", golferId: golferId("bo-g") });

    renderCreate({ pathname: "/create", state: { courseId: courseId("course-18") } });
    await screen.findByText(fixtureLinks18.courseName);
    await screen.findByText(/playing as/i);

    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "-3" } });
    fireEvent.click(screen.getByRole("button", { name: /create round/i }));

    await waitFor(() => expect(mockedCreateRound).toHaveBeenCalledTimes(1));
    expect(mockedCreateRound.mock.calls[0]![0].host.courseHandicap).toBe(-3);
  });

  it("submit is disabled until a course is picked", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });

    renderCreate();
    await screen.findByText(/playing as/i);

    expect(screen.getByRole("button", { name: /create round/i }).hasAttribute("disabled")).toBe(true);
  });

  it("search → pick a result → the tee picker populates from the fetched CourseView", async () => {
    vi.useFakeTimers();
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });
    mockedSearchCourses.mockResolvedValue({ courses: [{ courseId: courseId("course-18"), name: fixtureLinks18.courseName, holeCount: 18 }] });
    mockedGetCourse.mockResolvedValue({ course: courseView });

    renderCreate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0); // let the AuthProvider's GET /me settle so the form renders
    });

    fireEvent.change(screen.getByLabelText(/^course$/i), { target: { value: "fixture" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    // The result button now reads "<name> · <n> holes" (holeCount added) — match on the name substring.
    fireEvent.click(screen.getByRole("button", { name: new RegExp(fixtureLinks18.courseName) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockedGetCourse).toHaveBeenCalledWith(courseId("course-18"));
    expect(screen.getByLabelText(/^tee$/i)).toBeTruthy();
    expect(screen.getByText(/entered by ann/i)).toBeTruthy();
  });

  // M7 Task 7 (M-i): the edit flow's own return hand-off (router state, no re-fetch needed).
  it("M-i: EditCoursePage's return hand-off (refreshedCourse router state) replaces this page's held card", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("cy-g"), name: "Cy G" } });
    const revisedCard = { ...fixtureLinks18, teeSets: [{ ...fixtureWhite18, rating: 65.1 }] };
    const revisedCourseView: CourseView = { ...courseView, cardId: "card-18-v2", card: revisedCard };
    mockedCreateRound.mockResolvedValue({ roundId: roundId("round-mi-2"), joinCode: "DDD333", token: "tok-mi-2", golferId: golferId("cy-g") });

    renderCreate({ pathname: "/create", state: { refreshedCourse: revisedCourseView } });
    await screen.findByText(revisedCourseView.card.courseName);
    await screen.findByText(/playing as/i);
    expect(mockedGetCourse).not.toHaveBeenCalled(); // no re-fetch — EditCoursePage already returned the full CourseView

    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /create round/i }));

    await waitFor(() => expect(mockedCreateRound).toHaveBeenCalledTimes(1));
    expect(mockedCreateRound.mock.calls[0]![0].course).toEqual({ courseId: revisedCourseView.courseId, cardId: revisedCourseView.cardId });
  });

  // Course-cards spec §4: card-superseded means someone else's edit landed on this lineage
  // between the fetch and this submit — the page re-fetches the now-current card (so the tee
  // picker/numbers are honest) and surfaces a notice, rather than silently starting a round on
  // numbers the golfer never actually reviewed.
  it("a card-superseded rejection re-fetches the course and shows a review notice", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedCreateRound.mockRejectedValueOnce(new ApiError("card-superseded", 409, "the CURRENT pointer has moved"));

    renderCreate({ pathname: "/create", state: { courseId: courseId("course-18") } });
    await screen.findByText(fixtureLinks18.courseName);
    await screen.findByText(/playing as/i);
    expect(mockedGetCourse).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: /create round/i }));

    await waitFor(() => expect(mockedCreateRound).toHaveBeenCalledTimes(1));
    await screen.findByText(/just updated/i);
    // getCourse re-called (once for the initial load, once for the card-superseded re-fetch).
    await waitFor(() => expect(mockedGetCourse).toHaveBeenCalledTimes(2));
    expect(mockedGetCourse).toHaveBeenLastCalledWith(courseId("course-18"));
  });
});

// The suggested course handicap (unrated-courses T5b): a pre-fill, editable, composed from the
// effective index (declared > computed) against the selected tee. CreateRoundPage holds the full
// card, so a rated tee gets the real Rule 6.1a figure and an unrated tee gets round(index).
describe("CreateRoundPage — suggested course handicap", () => {
  it("a rated tee pre-fills courseHandicapFor over the declared index, labeled 'suggested (WHS)'", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G", declared: 12.4 } });
    mockedGetCourse.mockResolvedValue({ course: courseView });

    renderCreate({ pathname: "/create", state: { courseId: courseId("course-18") } });
    await screen.findByText(fixtureLinks18.courseName);
    await screen.findByText(/playing as/i);

    const whiteTee = fixtureLinks18.teeSets.find((teeSet) => teeSet.name === "white")!;
    const expected = String(courseHandicapFor(12.4, whiteTee));
    await waitFor(() => expect((screen.getByLabelText(/course handicap/i) as HTMLInputElement).value).toBe(expected));
    expect(screen.getByText("suggested (WHS)")).toBeTruthy();
  });

  it("composes the effective index from GET /me/record's whsIndex when there's no declared index", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } }); // no declared
    mockedGetMyRecord.mockResolvedValue({ metrics: { whsIndex: { value: 9.0, computedAtMs: 1_000, differentialsUsed: 5 } }, history: [] });
    mockedGetCourse.mockResolvedValue({ course: courseView });

    renderCreate({ pathname: "/create", state: { courseId: courseId("course-18") } });
    await screen.findByText(/playing as/i);

    const whiteTee = fixtureLinks18.teeSets.find((teeSet) => teeSet.name === "white")!;
    const expected = String(courseHandicapFor(9.0, whiteTee));
    await waitFor(() => expect((screen.getByLabelText(/course handicap/i) as HTMLInputElement).value).toBe(expected));
    expect(screen.getByText("suggested (WHS)")).toBeTruthy();
  });

  it("an unrated selected tee pre-fills round(index), labeled 'estimated — unrated course'", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G", declared: 12.4 } });
    // Same card, but the selected tee carries no rating/slope — a legitimate unrated tee.
    const unratedCard = { ...fixtureLinks18, teeSets: [{ name: "white", holes: fixtureWhite18.holes }] };
    mockedGetCourse.mockResolvedValue({ course: { ...courseView, card: unratedCard } });

    renderCreate({ pathname: "/create", state: { courseId: courseId("course-18") } });
    await screen.findByText(/playing as/i);

    await waitFor(() => expect((screen.getByLabelText(/course handicap/i) as HTMLInputElement).value).toBe("12")); // round(12.4)
    expect(screen.getByText(/estimated — unrated course/i)).toBeTruthy();
  });

  it("a typed course handicap is never overwritten by a seed that resolves later", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } }); // no declared
    mockedGetCourse.mockResolvedValue({ course: courseView });
    let resolveRecord: (record: GetMyRecordResponse) => void = () => {};
    mockedGetMyRecord.mockReturnValue(
      new Promise<GetMyRecordResponse>((resolve) => {
        resolveRecord = resolve;
      }),
    );
    mockedCreateRound.mockResolvedValue({ roundId: roundId("round-typed"), joinCode: "TYP111", token: "tok-typed", golferId: golferId("ann-g") });

    renderCreate({ pathname: "/create", state: { courseId: courseId("course-18") } });
    await screen.findByText(/playing as/i);

    // Type before any suggestion is available — this value must win.
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "7" } });

    // The record resolves with a whsIndex that WOULD suggest a very different value — the seed must not fire.
    resolveRecord({ metrics: { whsIndex: { value: 20.0, computedAtMs: 1_000, differentialsUsed: 5 } }, history: [] });
    await waitFor(() => expect(mockedGetMyRecord).toHaveBeenCalled());

    expect((screen.getByLabelText(/course handicap/i) as HTMLInputElement).value).toBe("7");
    fireEvent.click(screen.getByRole("button", { name: /create round/i }));
    await waitFor(() => expect(mockedCreateRound).toHaveBeenCalledTimes(1));
    expect(mockedCreateRound.mock.calls[0]![0].host.courseHandicap).toBe(7);
  });

  it("a rejected record fetch still pre-fills from the declared index alone — never blocks the page", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G", declared: 12.4 } });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedGetMyRecord.mockRejectedValue(new ApiError("boom", 500, "record unavailable"));

    renderCreate({ pathname: "/create", state: { courseId: courseId("course-18") } });
    await screen.findByText(/playing as/i);

    const whiteTee = fixtureLinks18.teeSets.find((teeSet) => teeSet.name === "white")!;
    const expected = String(courseHandicapFor(12.4, whiteTee));
    await waitFor(() => expect((screen.getByLabelText(/course handicap/i) as HTMLInputElement).value).toBe(expected));
    expect(screen.getByRole("button", { name: /create round/i }).hasAttribute("disabled")).toBe(false);
  });
});

// The M8 defect class the milestone must not reintroduce: no round may be created during the GET
// /me loading window (a "Playing as" that hasn't resolved whose it is).
describe("CreateRoundPage — identity still loading", () => {
  it("signed in, GET /me still in flight: a quiet placeholder, submit disabled, no create fires", async () => {
    signIn();
    mockedGetMe.mockReturnValue(new Promise<GetMeResponse>(() => {})); // never resolves
    mockedGetCourse.mockResolvedValue({ course: courseView });

    renderCreate({ pathname: "/create", state: { courseId: courseId("course-18") } });
    await screen.findByText(fixtureLinks18.courseName);

    expect(screen.queryByLabelText(/your name/i)).toBeNull();
    expect(screen.queryByText(/playing as/i)).toBeNull();
    expect(screen.getByRole("status", { name: /loading your profile/i })).toBeTruthy();

    const submitButton = screen.getByRole("button", { name: /create round/i });
    expect(submitButton.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "5" } });
    fireEvent.click(submitButton);

    expect(mockedCreateRound).not.toHaveBeenCalled();
  });

  it("once the deferred GET /me resolves to a golfer, the loading placeholder gives way to 'Playing as'", async () => {
    signIn();
    let resolveGetMe: (value: GetMeResponse) => void = () => {};
    mockedGetMe.mockReturnValue(
      new Promise<GetMeResponse>((resolve) => {
        resolveGetMe = resolve;
      }),
    );
    mockedGetCourse.mockResolvedValue({ course: courseView });

    renderCreate({ pathname: "/create", state: { courseId: courseId("course-18") } });
    await screen.findByText(fixtureLinks18.courseName);
    expect(screen.queryByText(/playing as/i)).toBeNull();
    expect(screen.getByRole("button", { name: /create round/i }).hasAttribute("disabled")).toBe(true);

    resolveGetMe({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });

    await screen.findByText(/playing as/i);
    expect(screen.getByText("Ann G")).toBeTruthy();
    expect(screen.queryByRole("status", { name: /loading your profile/i })).toBeNull();
  });
});
