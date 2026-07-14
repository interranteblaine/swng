import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { golferId, roundId } from "@swng/domain";
import type { GetMeResponse } from "@swng/contracts";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { credentialStore } from "../identity";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary, same idiom as CreateRoundPage.test.tsx — JoinRoundPage
// calls joinRound, peekRound, updateMe (the funnel's name prompt) and getMe (via the
// AuthProvider). peekRound defaults to a rejection so a test that never explicitly stubs it
// exercises the free-text tee fallback.
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

const renderJoin = (initialEntry = "/join") =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/join" element={<JoinRoundPage />} />
          <Route path="/round/:roundId" element={<div>round view</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

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

// The wall (accounts-only identity spec §3): joining is self-join only. Signed out, the page is
// a sign-in funnel, not a form — and it preserves the join code across the Hosted-UI round trip
// so a tap on a share link lands the new account back on the round it was invited to.
describe("JoinRoundPage — the funnel (signed out)", () => {
  it("shows a sign-in CTA and NO join form — no name/tee/handicap fields, no anonymous join", () => {
    renderJoin();

    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByLabelText(/your name/i)).toBeNull();
    expect(screen.queryByLabelText(/^tee$/i)).toBeNull();
    expect(screen.queryByLabelText(/course handicap/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /join round/i })).toBeNull();
  });

  it("preserves the typed join code across the round trip: clicking Sign in stashes returnTo with the code", () => {
    renderJoin();

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "abc123" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // AuthCallbackPage consumes this on return, landing the freshly-signed-in golfer back on the
    // join page with the code intact.
    expect(sessionStorage.getItem("swng:returnTo")).toBe("/join?code=ABC123");
  });

  it("seeds the code from the URL (a join link) so the round trip's return lands ready to join", () => {
    renderJoin("/join?code=xyz789");

    expect((screen.getByLabelText(/code/i) as HTMLInputElement).value).toBe("XYZ789");
    // And the CTA preserves that same code without the golfer retyping it.
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(sessionStorage.getItem("swng:returnTo")).toBe("/join?code=XYZ789");
  });
});

// Signed in, the funnel resolves identity then either prompts for a name (a placeholder golfer,
// spec §2 — the highest-motivation moment) or drops straight into the join form.
describe("JoinRoundPage — the name prompt (signed in, placeholder golfer)", () => {
  it("a placeholder golfer sees 'What should the card call you?' — not the join form yet", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("g1"), name: "Golfer 4821", namePlaceholder: true } });

    renderJoin();

    await screen.findByLabelText(/what should the card call you/i);
    // The join form is gated behind the name prompt — no tee/handicap/Join button until named.
    expect(screen.queryByLabelText(/^tee$/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /join round/i })).toBeNull();
    expect(screen.queryByText(/playing as/i)).toBeNull();
  });

  it("saving the name PUTs /me and proceeds straight into the join form in the same visit (no extra hop)", async () => {
    signIn();
    // First GET /me finds the placeholder; the refetch after PUT /me returns the real name.
    mockedGetMe
      .mockResolvedValueOnce({ golfer: { golferId: golferId("g1"), name: "Golfer 4821", namePlaceholder: true } })
      .mockResolvedValueOnce({ golfer: { golferId: golferId("g1"), name: "Bo Real" } });
    mockedUpdateMe.mockResolvedValue({ golfer: { golferId: golferId("g1"), name: "Bo Real" } });

    renderJoin();

    const nameField = await screen.findByLabelText(/what should the card call you/i);
    fireEvent.change(nameField, { target: { value: "Bo Real" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(mockedUpdateMe).toHaveBeenCalledWith(expect.any(String), { name: "Bo Real" }));
    // Same visit: the join form now renders — no navigation happened.
    await screen.findByText(/playing as/i);
    expect(screen.getByText("Bo Real")).toBeTruthy();
    expect(screen.getByRole("button", { name: /join round/i })).toBeTruthy();
  });
});

// A real-named golfer never sees the prompt (spec §2, controller resolution 3) and joins as
// themselves — the request carries the account's own name + golferId, never a typed input.
describe("JoinRoundPage — join as yourself (signed in, real name)", () => {
  it("goes straight to the join form as 'Playing as <name>' — the name INPUT is gone (structural pin)", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("bo-g"), name: "Bo G" } });

    renderJoin();

    await screen.findByText(/playing as/i);
    expect(screen.getByText("Bo G")).toBeTruthy();
    expect(screen.queryByText(/what should the card call you/i)).toBeNull();
    // The proof-of-negative the milestone turns on: no free-text name field anywhere in the join
    // form — the name is the account's, sourced from GET /me, never from an input.
    expect(screen.queryByLabelText(/your name/i)).toBeNull();
    expect(screen.getByRole("link", { name: /change/i }).getAttribute("href")).toBe("/profile");
  });

  it("uppercases the code and joins as-self: code + tee/handicap + the account's Bearer (seat resolved server-side, never a typed name)", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("bo-g"), name: "Bo G" } });
    mockedJoinRound.mockResolvedValue({ roundId: roundId("round-self"), token: "tok-self", golferId: golferId("bo-g") });

    renderJoin();
    await screen.findByText(/playing as/i);

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "self01" } });
    fireEvent.change(screen.getByLabelText(/^tee$/i), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: /join round/i }));

    await waitFor(() => expect(mockedJoinRound).toHaveBeenCalledTimes(1));
    const [body, token] = mockedJoinRound.mock.calls[0]!;
    // Accounts-only identity (spec §3): join is as-self — the request carries only code + tee +
    // courseHandicap; the seat (name + golferId) is resolved server-side from the Bearer.
    expect(body).toEqual({ code: "SELF01", tee: "white", courseHandicap: 6 });
    expect(token).toBe(idToken);

    await waitFor(() => expect(screen.getByText("round view")).toBeTruthy());
    expect(credentialStore.load(roundId("round-self"))).toEqual({ token: "tok-self", golferId: golferId("bo-g"), name: "Bo G", joinCode: "SELF01" });
  });

  // Real timers here (not fake): the join form only renders once the AuthProvider's async GET
  // /me resolves, and waitFor polls comfortably past the 250ms debounce — interleaving fake
  // timers with that async identity settle is the fiddle this avoids.
  it("once the code is 6 chars, a peek swaps the free-text tee for a picker of the round's tee names", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("bo-g"), name: "Bo G" } });
    mockedPeekRound.mockResolvedValue({
      courseName: "Fixture Links 18",
      teeSets: [
        { name: "white", rating: 71.6, slope: 128 },
        { name: "blue", rating: 74.0, slope: 140 },
      ],
      createdAt: 1_700_000_000_000,
    });

    renderJoin();
    await screen.findByText(/playing as/i); // GET /me settled, join form rendered

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "abc123" } });

    await waitFor(() => expect(mockedPeekRound).toHaveBeenCalledWith("ABC123"));
    const select = (await screen.findByLabelText(/^tee$/i)) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["white", "blue"]);
  });

  it("a failed peek falls back to free text with a note — joining is never blocked by it", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("dee-g"), name: "Dee" } });
    mockedPeekRound.mockRejectedValue(new Error("no round with that code"));
    mockedJoinRound.mockResolvedValue({ roundId: roundId("round-3"), token: "tok-3", golferId: golferId("dee-g") });

    renderJoin();
    await screen.findByText(/playing as/i);

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "zzz999" } });
    await screen.findByText(/could not look up/i); // the peek rejected; free-text fallback + note

    const teeField = screen.getByLabelText(/^tee$/i);
    expect(teeField.tagName).toBe("INPUT");

    fireEvent.change(teeField, { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /join round/i }));

    await waitFor(() => expect(mockedJoinRound).toHaveBeenCalledTimes(1));
    expect(mockedJoinRound.mock.calls[0]![0]).toEqual({ code: "ZZZ999", tee: "white", courseHandicap: 5 });
  });
});

// The M8 defect class the milestone must not reintroduce: a submit during the GET /me loading
// window once silently renamed a profile with stale free text. Neither the join form nor the
// name prompt may render until identity resolves.
describe("JoinRoundPage — identity still loading", () => {
  it("no join form, no name prompt, a quiet placeholder instead", async () => {
    signIn();
    mockedGetMe.mockReturnValue(new Promise<GetMeResponse>(() => {})); // never resolves

    renderJoin();
    await waitFor(() => expect(mockedGetMe).toHaveBeenCalled());

    expect(screen.queryByLabelText(/your name/i)).toBeNull();
    expect(screen.queryByLabelText(/what should the card call you/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /join round/i })).toBeNull();
    expect(screen.getByRole("status", { name: /loading your profile/i })).toBeTruthy();
  });
});
