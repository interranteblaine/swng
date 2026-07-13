import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courseId, fixtureLinks18, fixtureWhite18, golferId, roundId } from "@swng/domain";
import { startRoundRequestSchema } from "@swng/contracts";
import type { CourseView, GetMeResponse } from "@swng/contracts";
import { credentialStore } from "../identity";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary (M5's own idiom) — CreateRoundPage (and the CourseSearch/
// CourseSummaryCard it composes) only ever calls these; getMe is here because the AuthProvider
// wrapper below (CourseSummaryCard's verifier auto-fill, M7 Task 6) resolves the signed-in
// golfer through the same mocked module. updateMe is M8 Task 5's own addition — the
// "signed-in-with-no-golfer" as-self path calls it to mint a golfer before creating the round.
vi.mock("../api", () => ({
  createRound: vi.fn(),
  getCourse: vi.fn(),
  searchCourses: vi.fn(),
  verifyTeeSet: vi.fn(),
  getMe: vi.fn(),
  updateMe: vi.fn(),
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

import { ApiError, createRound, getCourse, getMe, searchCourses, updateMe, verifyTeeSet } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { CreateRoundPage } from "./CreateRoundPage";

const mockedCreateRound = vi.mocked(createRound);
const mockedGetCourse = vi.mocked(getCourse);
const mockedSearchCourses = vi.mocked(searchCourses);
const mockedVerifyTeeSet = vi.mocked(verifyTeeSet);
const mockedUpdateMe = vi.mocked(updateMe);
const mockedGetMe = vi.mocked(getMe);

const courseView: CourseView = {
  courseId: courseId("course-18"),
  name: fixtureLinks18.courseName,
  card: fixtureLinks18,
  teeSets: [{ name: "white", version: 1, provenance: "community", enteredBy: "Ann", verifiedBy: [] }],
};

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  mockedCreateRound.mockReset();
  mockedGetCourse.mockReset();
  mockedSearchCourses.mockReset();
  mockedVerifyTeeSet.mockReset();
  mockedUpdateMe.mockReset();
  mockedGetMe.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// M8 Task 5 (play as yourself): same base64url-JWT-shaped idiom as SetupPanel.test.tsx's own
// local signIn() — only the sub/email claims matter (decoded client-side for the header/email
// fallback), never a verified signature (that's the server's job).
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
// so these tests only assert that navigation landed on /round/:roundId (the
// AddCoursePage/EditCoursePage "read the outgoing hand-off via a stub" precedent — see
// AddCoursePage.test.tsx's own CreateStub).
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

// M8 Task 5, the milestone's headline behavior: a signed-in golfer creates a round AS their
// account golfer — no ghost, no later claim step needed.
describe("CreateRoundPage — play as yourself", () => {
  it("signed in WITH a golfer: the name field becomes 'Playing as <name>', and the request carries golferId + Bearer", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedCreateRound.mockResolvedValue({ roundId: roundId("round-self"), joinCode: "SELF01", token: "tok-self", golferId: golferId("ann-g") });

    renderCreate({ pathname: "/create", state: { courseId: courseId("course-18") } });
    await screen.findByText(fixtureLinks18.courseName);
    await screen.findByText(/playing as/i);
    expect(screen.getByText("Ann G")).toBeTruthy();

    expect(screen.queryByLabelText(/your name/i)).toBeNull(); // the free-text field is gone
    expect(screen.getByRole("link", { name: /change/i }).getAttribute("href")).toBe("/profile");

    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: /create round/i }));

    await waitFor(() => expect(mockedCreateRound).toHaveBeenCalledTimes(1));
    const [body, token] = mockedCreateRound.mock.calls[0]!;
    expect(body).toEqual({ card: fixtureLinks18, host: { name: "Ann G", tee: "white", courseHandicap: 8 }, golferId: golferId("ann-g") });
    expect(token).toBe(idToken);
    expect(() => startRoundRequestSchema.parse(body)).not.toThrow();

    await waitFor(() => expect(screen.getByText("round view")).toBeTruthy());
    expect(credentialStore.load(roundId("round-self"))).toEqual({ token: "tok-self", golferId: golferId("ann-g"), name: "Ann G", joinCode: "SELF01" });
  });

  it("signed in with NO golfer: the typed name creates the profile (PUT /me) BEFORE creating the round — call order asserted", async () => {
    const idToken = signIn();
    // First GET /me (the provider's own mount-time fetch) finds no golfer; the SECOND (this
    // fix's own auth.refetch() after PUT /me) returns the freshly-minted one — see the W1 test
    // below, which asserts on this same sequencing.
    mockedGetMe.mockResolvedValueOnce({ golfer: null }).mockResolvedValueOnce({ golfer: { golferId: golferId("fresh-g"), name: "Fresh" } });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedUpdateMe.mockResolvedValue({ golfer: { golferId: golferId("fresh-g"), name: "Fresh" } });
    mockedCreateRound.mockResolvedValue({ roundId: roundId("round-fresh"), joinCode: "FRESH1", token: "tok-fresh", golferId: golferId("fresh-g") });

    renderCreate({ pathname: "/create", state: { courseId: courseId("course-18") } });
    await screen.findByText(fixtureLinks18.courseName);
    // Still the free-text field — nothing to display until PUT /me mints a golfer.
    expect(screen.getByLabelText(/your name/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Fresh" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: /create round/i }));

    await waitFor(() => expect(mockedCreateRound).toHaveBeenCalledTimes(1));
    expect(mockedUpdateMe).toHaveBeenCalledWith(idToken, { name: "Fresh" });
    const [body, token] = mockedCreateRound.mock.calls[0]!;
    expect(body).toEqual({ card: fixtureLinks18, host: { name: "Fresh", tee: "white", courseHandicap: 3 }, golferId: golferId("fresh-g") });
    expect(token).toBe(idToken);

    // The headline call-order contract: PUT /me strictly before POST /rounds.
    expect(mockedUpdateMe.mock.invocationCallOrder[0]!).toBeLessThan(mockedCreateRound.mock.invocationCallOrder[0]!);

    expect(credentialStore.load(roundId("round-fresh"))).toEqual({ token: "tok-fresh", golferId: golferId("fresh-g"), name: "Fresh", joinCode: "FRESH1" });
  });

  // W1 (controller flow-walk finding, post-gate): before this fix, auth.golfer stayed null in
  // the context after PUT /me minted a real golfer — until a full reload, the round page's own
  // roster row for this golfer rendered "This is me" instead of "You" (ClaimAffordance's
  // own-row check reads auth.golfer straight from context). Proven via the same seam
  // ClaimAffordance's own claim success uses (auth.refetch -> a second GET /me): it must fire
  // AFTER PUT /me and its result must reach the context before this page navigates away.
  it("W1: after PUT /me mints the profile, the auth context is refetched so auth.golfer reflects it before navigating", async () => {
    signIn();
    mockedGetMe.mockResolvedValueOnce({ golfer: null }).mockResolvedValueOnce({ golfer: { golferId: golferId("fresh-g"), name: "Fresh" } });
    mockedGetCourse.mockResolvedValue({ course: courseView });
    mockedUpdateMe.mockResolvedValue({ golfer: { golferId: golferId("fresh-g"), name: "Fresh" } });
    mockedCreateRound.mockResolvedValue({ roundId: roundId("round-fresh-w1"), joinCode: "FRESH2", token: "tok-fresh-w1", golferId: golferId("fresh-g") });

    renderCreate({ pathname: "/create", state: { courseId: courseId("course-18") } });
    await screen.findByText(fixtureLinks18.courseName);

    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Fresh" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: /create round/i }));

    // The refetch's own GET /me — a SECOND call, after the provider's mount-time one.
    await waitFor(() => expect(mockedGetMe).toHaveBeenCalledTimes(2));
    expect(mockedUpdateMe.mock.invocationCallOrder[0]!).toBeLessThan(mockedGetMe.mock.invocationCallOrder[1]!);

    await waitFor(() => expect(screen.getByText("round view")).toBeTruthy());
  });

  // The finding this fix closes: GET /me's own in-flight window (auth.golfer === undefined
  // while signed in) was previously collapsed into the "signed in, no golfer yet" branch, so a
  // submit during that window fired PUT /me with whatever the (nonexistent) free-text field
  // held — a silent rename of a real profile that just hadn't loaded yet. Neither the free-text
  // field nor "Playing as" may render during this window, and submit must be inert.
  it("signed in, GET /me still in flight: no free-text field is offered, submit is disabled, and no write fires on interaction", async () => {
    signIn();
    mockedGetMe.mockReturnValue(new Promise<GetMeResponse>(() => {})); // the loading window itself — never resolves
    mockedGetCourse.mockResolvedValue({ course: courseView });

    renderCreate({ pathname: "/create", state: { courseId: courseId("course-18") } });
    await screen.findByText(fixtureLinks18.courseName);

    // Neither today's free-text field nor "Playing as" — a quiet loading placeholder instead.
    expect(screen.queryByLabelText(/your name/i)).toBeNull();
    expect(screen.queryByText(/playing as/i)).toBeNull();
    expect(screen.getByRole("status", { name: /loading your profile/i })).toBeTruthy();

    const submitButton = screen.getByRole("button", { name: /create round/i });
    expect(submitButton.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "5" } });
    fireEvent.click(submitButton);

    expect(mockedUpdateMe).not.toHaveBeenCalled();
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

