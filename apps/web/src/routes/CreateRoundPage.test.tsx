import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courseId, crewId, fixtureLinks18, fixtureWhite18, gameId, golferId, roundId } from "@swng/domain";
import { startRoundRequestSchema } from "@swng/contracts";
import type { CourseView, CrewMemberView, GetMeResponse, StandingGameView } from "@swng/contracts";
import { credentialStore } from "../identity";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary (M5's own idiom) — CreateRoundPage (and the CourseSearch/
// CourseSummaryCard it composes) only ever calls these; getMe is here because the AuthProvider
// wrapper below (CourseSummaryCard's verifier auto-fill, M7 Task 6) resolves the signed-in
// golfer through the same mocked module. updateMe is M8 Task 5's own addition — the
// "signed-in-with-no-golfer" as-self path calls it to mint a golfer before creating the round.
vi.mock("../api", () => ({
  createRound: vi.fn(),
  addGame: vi.fn(),
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

import { addGame, ApiError, createRound, getCourse, getMe, searchCourses, updateMe, verifyTeeSet } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { CreateRoundPage } from "./CreateRoundPage";

const mockedCreateRound = vi.mocked(createRound);
const mockedAddGame = vi.mocked(addGame);
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
  mockedAddGame.mockReset();
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

// Reads back whatever CreateRoundPage's own post-create navigate() hands the round page (the
// AddCoursePage/EditCoursePage "read the outgoing hand-off via a stub" precedent — see
// AddCoursePage.test.tsx's own CreateStub), so this file can assert the seed-failure router
// state's SHAPE without pulling the real RoundPage (and its own session/transport machinery)
// into these tests. "round view" is kept as its own element with no sibling text so the
// pre-existing `screen.getByText("round view")` assertions keep matching unchanged.
function RoundStub() {
  const location = useLocation();
  const state = location.state as { seedFailures?: { total: number; failedLabels: readonly string[] } } | null;
  return (
    <div>
      <p>round view</p>
      {state?.seedFailures && (
        <p>
          seed failures: {state.seedFailures.failedLabels.length} of {state.seedFailures.total} — {state.seedFailures.failedLabels.join("; ")}
        </p>
      )}
    </div>
  );
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
    mockedGetMe.mockResolvedValue({ golfer: null });
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

// M8 Task 6, the product moment this milestone exists for: "Play the usual" lands here with the
// crew's id + members + preset in router state (CrewPage's hand-off), and ONE further tap
// (Create round) starts Saturday — every crew member seated, the preset's games seeded, nothing
// retyped.
describe("CreateRoundPage — play the usual (crew preset)", () => {
  // A second tee on the card ("blue", the preset's own) so honoring the PRESET's tee is
  // distinguishable from the page's default first-tee selection.
  const blueTee = { ...fixtureWhite18, name: "blue" };
  const twoTeeCard = { ...fixtureLinks18, teeSets: [fixtureWhite18, blueTee] };
  const twoTeeCourseView: CourseView = {
    courseId: courseId("course-18"),
    name: fixtureLinks18.courseName,
    card: twoTeeCard,
    teeSets: [
      { name: "white", version: 1, provenance: "community", enteredBy: "Ann", verifiedBy: [] },
      { name: "blue", version: 1, provenance: "community", enteredBy: "Ann", verifiedBy: [] },
    ],
  };

  const members: readonly CrewMemberView[] = [
    { golferId: golferId("ann-g"), name: "Ann G", role: "organizer", claimed: true },
    { golferId: golferId("bo-g"), name: "Bo", role: "member", claimed: false },
    { golferId: golferId("cy-g"), name: "Cy", role: "member", claimed: false },
  ];

  const standingGame: StandingGameView = {
    courseId: courseId("course-18"),
    tee: "blue",
    games: [
      { kind: "singles-match", a: golferId("ann-g"), b: golferId("bo-g"), allowance: 1 },
      { kind: "stableford", players: [golferId("ann-g"), golferId("cy-g")], allowance: 0.95 },
    ],
  };

  const crewPreset = { crewId: crewId("crew-1"), members, standingGame };

  const arrange = (): string => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetCourse.mockResolvedValue({ course: twoTeeCourseView });
    mockedCreateRound.mockResolvedValue({ roundId: roundId("round-usual"), joinCode: "USUAL1", token: "tok-usual", golferId: golferId("ann-g") });
    mockedAddGame.mockResolvedValue({ gameId: gameId("game-x"), seq: 5 });
    return idToken;
  };

  it("one remaining tap: pre-filled from the preset, a single Create-round click sends the full crew request and seeds the preset's games", async () => {
    const idToken = arrange();

    renderCreate({ pathname: "/create", state: { crewPreset } });
    await screen.findByText(fixtureLinks18.courseName);
    await screen.findByText(/playing as/i);

    // The prefill is all on screen before any interaction: both preset games described by name.
    expect(screen.getByText(/singles match — ann g vs bo/i)).toBeTruthy();
    expect(screen.getByText(/stableford — ann g, cy/i)).toBeTruthy();

    // The ONE remaining tap — no other input touched first.
    fireEvent.click(screen.getByRole("button", { name: /create round/i }));

    await waitFor(() => expect(mockedCreateRound).toHaveBeenCalledTimes(1));
    const [body, token] = mockedCreateRound.mock.calls[0]!;
    expect(body).toEqual({
      card: twoTeeCard, // the fetched card verbatim (the freeze source), preset course honored
      host: { name: "Ann G", tee: "blue", courseHandicap: 0 }, // you as-self; preset tee; CH prefill 0
      golferId: golferId("ann-g"),
      crewId: crewId("crew-1"),
      players: [
        { name: "Bo", tee: "blue", courseHandicap: 0, golferId: golferId("bo-g") },
        { name: "Cy", tee: "blue", courseHandicap: 0, golferId: golferId("cy-g") },
      ],
    });
    expect(token).toBe(idToken);
    expect(() => startRoundRequestSchema.parse(body)).not.toThrow();

    // Games arrive without retyping: addGame per surviving preset game, with the create
    // response's own participant token, in preset order.
    await waitFor(() => expect(mockedAddGame).toHaveBeenCalledTimes(2));
    expect(mockedAddGame).toHaveBeenNthCalledWith(1, roundId("round-usual"), "tok-usual", standingGame.games[0]);
    expect(mockedAddGame).toHaveBeenNthCalledWith(2, roundId("round-usual"), "tok-usual", standingGame.games[1]);

    await waitFor(() => expect(screen.getByText("round view")).toBeTruthy());
    expect(credentialStore.load(roundId("round-usual"))).toEqual({ token: "tok-usual", golferId: golferId("ann-g"), name: "Ann G", joinCode: "USUAL1" });
  });

  it("removing a player before creating reactively drops the games that reference them (applyStandingGame over the CURRENT roster)", async () => {
    arrange();

    renderCreate({ pathname: "/create", state: { crewPreset } });
    await screen.findByText(fixtureLinks18.courseName);
    await screen.findByText(/playing as/i);
    expect(screen.getByText(/singles match — ann g vs bo/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove Bo" }));

    // The singles match referencing Bo disappears from the games list; the stableford
    // (Ann G + Cy, both still present) stays.
    expect(screen.queryByText(/singles match — ann g vs bo/i)).toBeNull();
    expect(screen.getByText(/stableford — ann g, cy/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /create round/i }));

    await waitFor(() => expect(mockedCreateRound).toHaveBeenCalledTimes(1));
    const [body] = mockedCreateRound.mock.calls[0]!;
    expect(body.players).toEqual([{ name: "Cy", tee: "blue", courseHandicap: 0, golferId: golferId("cy-g") }]);

    await waitFor(() => expect(screen.getByText("round view")).toBeTruthy());
    // Only the surviving game was seeded — never a renumbered/partial singles match.
    expect(mockedAddGame).toHaveBeenCalledTimes(1);
    expect(mockedAddGame).toHaveBeenCalledWith(roundId("round-usual"), "tok-usual", standingGame.games[1]);
  });

  it("prefilled tees and handicaps stay editable per player before the tap", async () => {
    arrange();

    renderCreate({ pathname: "/create", state: { crewPreset } });
    await screen.findByText(fixtureLinks18.courseName);
    await screen.findByText(/playing as/i);

    fireEvent.change(screen.getByLabelText("Tee for Cy"), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText("Course handicap for Cy"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: /create round/i }));

    await waitFor(() => expect(mockedCreateRound).toHaveBeenCalledTimes(1));
    const [body] = mockedCreateRound.mock.calls[0]!;
    expect(body.players).toEqual([
      { name: "Bo", tee: "blue", courseHandicap: 0, golferId: golferId("bo-g") },
      { name: "Cy", tee: "white", courseHandicap: 7, golferId: golferId("cy-g") },
    ]);
  });

  it("a preset with no tee falls back to free-text player tees (empty until typed) and blocks the tap until they're filled", async () => {
    arrange();
    const tvNoTee: StandingGameView = { courseId: courseId("course-18"), games: standingGame.games };

    renderCreate({ pathname: "/create", state: { crewPreset: { ...crewPreset, standingGame: tvNoTee } } });
    await screen.findByText(fixtureLinks18.courseName);
    await screen.findByText(/playing as/i);

    // Host tee fell back to the card's first tee (the page's own default); player tees are
    // empty free text, so the submit guard holds until they're typed.
    fireEvent.click(screen.getByRole("button", { name: /create round/i }));
    expect(mockedCreateRound).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Tee for Bo"), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText("Tee for Cy"), { target: { value: "white" } });
    fireEvent.click(screen.getByRole("button", { name: /create round/i }));

    await waitFor(() => expect(mockedCreateRound).toHaveBeenCalledTimes(1));
    const [body] = mockedCreateRound.mock.calls[0]!;
    expect(body.host.tee).toBe("white");
    expect(body.players).toEqual([
      { name: "Bo", tee: "white", courseHandicap: 0, golferId: golferId("bo-g") },
      { name: "Cy", tee: "white", courseHandicap: 0, golferId: golferId("cy-g") },
    ]);
  });

  // The review finding this fix closes: a per-game addGame failure in the seed loop used to be
  // caught and dropped with nothing to show for it — exactly wrong for "one-tap Saturday",
  // where the golfer is least likely to double-check Setup on their own. Three games (not the
  // usual two) so this arm can distinguish "the one that failed" from "the two that didn't",
  // same shape as the fix's own "2 of 3" style copy.
  it("a mid-loop addGame rejection still navigates to the round, carrying the failed game's own label as router state (never a raw server string)", async () => {
    arrange();
    const threeGameStandingGame: StandingGameView = {
      ...standingGame,
      games: [...standingGame.games, { kind: "skins", players: [golferId("ann-g"), golferId("bo-g"), golferId("cy-g")], allowance: 1 }],
    };
    // Second of three addGame calls rejects — the singles-match (1st) and skins (3rd) seed
    // cleanly; only the stableford (2nd) fails.
    mockedAddGame
      .mockResolvedValueOnce({ gameId: gameId("game-1"), seq: 5 })
      .mockRejectedValueOnce(new ApiError("internal", 500, "raw db failure xyz"))
      .mockResolvedValueOnce({ gameId: gameId("game-3"), seq: 7 });

    renderCreate({ pathname: "/create", state: { crewPreset: { ...crewPreset, standingGame: threeGameStandingGame } } });
    await screen.findByText(fixtureLinks18.courseName);
    await screen.findByText(/playing as/i);

    fireEvent.click(screen.getByRole("button", { name: /create round/i }));

    // Navigation happens regardless of the failure — a dropped preset game must never strand
    // the golfer on this page (a re-submit would mint a SECOND round).
    await waitFor(() => expect(screen.getByText("round view")).toBeTruthy());
    await waitFor(() => expect(mockedAddGame).toHaveBeenCalledTimes(3));

    // The count, and the failed game's own describeStandingGame label — the SAME text the
    // prefill Games list renders — carried through router state; never the raw ApiError text
    // ("raw db failure xyz") from the rejection above.
    expect(screen.getByText(/seed failures: 1 of 3/i)).toBeTruthy();
    expect(screen.getByText(/stableford — ann g, cy/i)).toBeTruthy();
    expect(screen.queryByText(/raw db failure/i)).toBeNull();
  });

  it("no addGame failures: no seed-failure router state is sent at all", async () => {
    arrange();

    renderCreate({ pathname: "/create", state: { crewPreset } });
    await screen.findByText(fixtureLinks18.courseName);
    await screen.findByText(/playing as/i);

    fireEvent.click(screen.getByRole("button", { name: /create round/i }));

    await waitFor(() => expect(screen.getByText("round view")).toBeTruthy());
    expect(screen.queryByText(/seed failures/i)).toBeNull();
  });
});
