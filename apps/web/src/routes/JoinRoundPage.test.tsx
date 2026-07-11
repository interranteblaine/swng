import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { golferId, roundId } from "@swng/domain";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { credentialStore } from "../identity";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary, same idiom as CreateRoundPage.test.tsx — JoinRoundPage
// calls joinRound and (M6 Task 5) peekRound. peekRound defaults to a rejection so a test that
// never explicitly stubs it exercises the same free-text fallback the page always had. getMe/
// updateMe are M8 Task 5's own additions: getMe backs the AuthProvider wrapper below (every
// existing, signed-out test never triggers it — no tokens are ever saved outside the new
// "play as yourself" describe block); updateMe is the "signed-in-with-no-golfer" as-self path.
vi.mock("../api", () => ({
  joinRound: vi.fn(),
  peekRound: vi.fn().mockRejectedValue(new Error("not stubbed")),
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

import { getMe, joinRound, peekRound, updateMe } from "../api";
import { JoinRoundPage } from "./JoinRoundPage";

const mockedJoinRound = vi.mocked(joinRound);
const mockedPeekRound = vi.mocked(peekRound);
const mockedGetMe = vi.mocked(getMe);
const mockedUpdateMe = vi.mocked(updateMe);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  mockedJoinRound.mockReset();
  mockedPeekRound.mockReset();
  mockedPeekRound.mockRejectedValue(new Error("not stubbed"));
  mockedGetMe.mockReset();
  mockedUpdateMe.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// Every render now needs an AuthProvider ancestor (JoinRoundPage calls useAuth(), M8 Task 5) —
// the one place this wrapping lives, so every existing (signed-out) test below keeps its exact
// shape: no tokens are ever saved outside the new "play as yourself" describe block, so
// auth.signedIn stays false and asSelf stays false throughout.
const renderJoin = () =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/join"]}>
        <Routes>
          <Route path="/join" element={<JoinRoundPage />} />
          <Route path="/round/:roundId" element={<div>round view</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

// M8 Task 5 (play as yourself), same base64url-JWT-shaped idiom as SetupPanel.test.tsx's own
// local signIn().
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

describe("JoinRoundPage", () => {
  it("uppercases a lowercase-typed code before sending it", async () => {
    mockedJoinRound.mockResolvedValue({ roundId: roundId("round-1"), token: "tok-1", golferId: golferId("bo") });

    renderJoin();

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "abc123" } });
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Bo" } });
    fireEvent.change(screen.getByLabelText(/^tee$/i), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /join round/i }));

    await waitFor(() => expect(mockedJoinRound).toHaveBeenCalledTimes(1));
    expect(mockedJoinRound).toHaveBeenCalledWith({ code: "ABC123", name: "Bo", tee: "white", courseHandicap: 2 });
  });

  it("saves the credential (with the code the golfer typed — joinRound's response carries none) and navigates to the round", async () => {
    mockedJoinRound.mockResolvedValue({ roundId: roundId("round-2"), token: "tok-2", golferId: golferId("cal") });

    renderJoin();

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "def456" } });
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Cal" } });
    fireEvent.change(screen.getByLabelText(/^tee$/i), { target: { value: "blue" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "14" } });
    fireEvent.click(screen.getByRole("button", { name: /join round/i }));

    await waitFor(() => expect(screen.getByText("round view")).toBeTruthy());
    expect(credentialStore.load(roundId("round-2"))).toEqual({ token: "tok-2", golferId: golferId("cal"), name: "Cal", joinCode: "DEF456" });
  });

  it("once the code is 6 chars, debounces a peek that swaps the free-text tee for a picker of the round's tee names", async () => {
    vi.useFakeTimers();
    mockedPeekRound.mockResolvedValue({ courseName: "Fixture Links 18", teeSets: [{ name: "white", rating: 71.6, slope: 128 }, { name: "blue", rating: 74.0, slope: 140 }] });

    renderJoin();
    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "abc123" } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(mockedPeekRound).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockedPeekRound).toHaveBeenCalledWith("ABC123");
    expect(screen.getByText(/joining fixture links 18/i)).toBeTruthy();

    const select = screen.getByLabelText(/^tee$/i) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["white", "blue"]);
  });

  it("a failed peek falls back to free text with a note — joining is never blocked by it", async () => {
    vi.useFakeTimers();
    mockedPeekRound.mockRejectedValue(new Error("no round with that code"));
    mockedJoinRound.mockResolvedValue({ roundId: roundId("round-3"), token: "tok-3", golferId: golferId("dee") });

    renderJoin();
    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "zzz999" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    // Still a free-text input, not a picker — and a note explains why.
    const teeField = screen.getByLabelText(/^tee$/i);
    expect(teeField.tagName).toBe("INPUT");
    expect(screen.getByText(/could not look up/i)).toBeTruthy();
    vi.useRealTimers(); // nothing past this point depends on the debounce — waitFor below needs real timers to poll

    // And joining still works from that free-text field.
    fireEvent.change(teeField, { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Dee" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /join round/i }));

    await waitFor(() => expect(mockedJoinRound).toHaveBeenCalledWith({ code: "ZZZ999", name: "Dee", tee: "white", courseHandicap: 5 }));
  });
});

// M8 Task 5, the milestone's headline behavior: a signed-in golfer joins a round AS their
// account golfer — no ghost, no later claim step needed. Mirrors CreateRoundPage's own
// "play as yourself" tests.
describe("JoinRoundPage — play as yourself", () => {
  it("signed in WITH a golfer: the name field becomes 'Playing as <name>', and the request carries golferId + Bearer", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("bo-g"), name: "Bo G" } });
    mockedJoinRound.mockResolvedValue({ roundId: roundId("round-self"), token: "tok-self", golferId: golferId("bo-g") });

    renderJoin();
    await screen.findByText(/playing as/i);
    expect(screen.getByText("Bo G")).toBeTruthy();
    expect(screen.queryByLabelText(/your name/i)).toBeNull(); // the free-text field is gone
    expect(screen.getByRole("link", { name: /change/i }).getAttribute("href")).toBe("/profile");

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "self01" } });
    fireEvent.change(screen.getByLabelText(/^tee$/i), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: /join round/i }));

    await waitFor(() => expect(mockedJoinRound).toHaveBeenCalledTimes(1));
    const [body, token] = mockedJoinRound.mock.calls[0]!;
    expect(body).toEqual({ code: "SELF01", name: "Bo G", tee: "white", courseHandicap: 6, golferId: golferId("bo-g") });
    expect(token).toBe(idToken);

    await waitFor(() => expect(screen.getByText("round view")).toBeTruthy());
    expect(credentialStore.load(roundId("round-self"))).toEqual({ token: "tok-self", golferId: golferId("bo-g"), name: "Bo G", joinCode: "SELF01" });
  });

  it("signed in with NO golfer: the typed name creates the profile (PUT /me) BEFORE joining the round — call order asserted", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: null });
    mockedUpdateMe.mockResolvedValue({ golfer: { golferId: golferId("fresh-g"), name: "Fresh" } });
    mockedJoinRound.mockResolvedValue({ roundId: roundId("round-fresh"), token: "tok-fresh", golferId: golferId("fresh-g") });

    renderJoin();
    // Still the free-text field — nothing to display until PUT /me mints a golfer.
    await waitFor(() => expect(mockedGetMe).toHaveBeenCalled());
    expect(screen.getByLabelText(/your name/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "fresh1" } });
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Fresh" } });
    fireEvent.change(screen.getByLabelText(/^tee$/i), { target: { value: "blue" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: /join round/i }));

    await waitFor(() => expect(mockedJoinRound).toHaveBeenCalledTimes(1));
    expect(mockedUpdateMe).toHaveBeenCalledWith(idToken, { name: "Fresh" });
    const [body, token] = mockedJoinRound.mock.calls[0]!;
    expect(body).toEqual({ code: "FRESH1", name: "Fresh", tee: "blue", courseHandicap: 9, golferId: golferId("fresh-g") });
    expect(token).toBe(idToken);

    // The headline call-order contract: PUT /me strictly before POST /rounds/join.
    expect(mockedUpdateMe.mock.invocationCallOrder[0]!).toBeLessThan(mockedJoinRound.mock.invocationCallOrder[0]!);

    expect(credentialStore.load(roundId("round-fresh"))).toEqual({ token: "tok-fresh", golferId: golferId("fresh-g"), name: "Fresh", joinCode: "FRESH1" });
  });
});
