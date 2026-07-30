import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { golferId, roundId } from "@swng/domain";
import type { GetMeResponse } from "@swng/contracts";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { credentialStore } from "../identity";
import { roundLabel } from "../roundLabel";
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
  // NO getMyRecord key, deliberately (spec 2026-07-29 §2): nothing converts an index into strokes
  // any more, so this page fetches no record at all. Task 5 re-adds both the key and the fetch when
  // it wires the pre-fill from metrics.average.
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
  tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 3_600_000 });
  return idToken;
};

// The wall (accounts-only identity spec §3): joining is self-join only. Signed out, the page is
// a sign-in funnel, not a form — and it preserves the join code across the Hosted-UI round trip
// so a tap on a share link lands the new account back on the round it was invited to.
describe("JoinRoundPage — the funnel (signed out)", () => {
  it("shows a sign-in CTA and NO join form — no name/tee/strokes fields, no anonymous join", () => {
    renderJoin();

    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByLabelText(/your name/i)).toBeNull();
    expect(screen.queryByLabelText(/^tee$/i)).toBeNull();
    expect(screen.queryByLabelText(/strokes you get here/i)).toBeNull();
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
    // The join form is gated behind the name prompt — no tee field and no Join button until named.
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

  it("uppercases the code and joins as-self: code + tee + basis + the account's Bearer (seat resolved server-side, never a typed name)", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("bo-g"), name: "Bo G" } });
    // The response's own joinCode is DELIBERATELY different from the typed "self01"/"SELF01" —
    // the saved-credential assertion below must pin the RESPONSE's code, not the typed form
    // value, and a matching pair of strings wouldn't distinguish the two sources.
    mockedJoinRound.mockResolvedValue({ roundId: roundId("round-self"), token: "tok-self", golferId: golferId("bo-g"), joinCode: "RESP01" });

    renderJoin();
    await screen.findByText(/playing as/i);

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "self01" } });
    fireEvent.change(screen.getByLabelText(/^tee$/i), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText("What do you normally shoot, relative to par?"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: /join round/i }));

    await waitFor(() => expect(mockedJoinRound).toHaveBeenCalledTimes(1));
    const [body, token] = mockedJoinRound.mock.calls[0]!;
    // Accounts-only identity (spec §3): join is as-self — the request carries only code + tee +
    // basis; the seat (name + golferId) is resolved server-side from the Bearer.
    expect(body).toEqual({ code: "SELF01", tee: "white", basis: { kind: "normally-shoots", overPar: 6 } });
    expect(token).toBe(idToken);

    await waitFor(() => expect(screen.getByText("round view")).toBeTruthy());
    // Pins the RESPONSE's joinCode ("RESP01"), not the typed form value ("SELF01") — the server
    // now echoes the canonical code, and that's what's saved (spec 2026-07-20 §2/§3).
    expect(credentialStore.load(roundId("round-self"))).toEqual({ token: "tok-self", golferId: golferId("bo-g"), name: "Bo G", joinCode: "RESP01" });
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

    // The join-link framing carries the round's full designation (course + date), not a bare
    // course name (spec §5) — computed via roundLabel from the peek's own createdAt, local zone,
    // the same way HomePage/WatchPage's own label tests do.
    expect(screen.getByText(`Joining ${roundLabel({ courseName: "Fixture Links 18", createdAt: 1_700_000_000_000 })}`)).toBeTruthy();
  });

  it("a failed peek falls back to free text with a note — joining is never blocked by it", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("dee-g"), name: "Dee" } });
    mockedPeekRound.mockRejectedValue(new Error("no round with that code"));
    mockedJoinRound.mockResolvedValue({ roundId: roundId("round-3"), token: "tok-3", golferId: golferId("dee-g"), joinCode: "ZZZ999" });

    renderJoin();
    await screen.findByText(/playing as/i);

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "zzz999" } });
    await screen.findByText(/could not look up/i); // the peek rejected; free-text fallback + note

    const teeField = screen.getByLabelText(/^tee$/i);
    expect(teeField.tagName).toBe("INPUT");

    fireEvent.change(teeField, { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText("What do you normally shoot, relative to par?"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /join round/i }));

    await waitFor(() => expect(mockedJoinRound).toHaveBeenCalledTimes(1));
    expect(mockedJoinRound.mock.calls[0]![0]).toEqual({ code: "ZZZ999", tee: "white", basis: { kind: "normally-shoots", overPar: 5 } });
  });
});

// ONE number, in the unit everyone already speaks (spec 2026-07-29 §2/§9): what you normally
// shoot relative to par. Nothing converts it and nothing derives it from a course's rating/slope —
// the strokes themselves fall out of the whole field once everyone has stated theirs, so this form
// has no per-player strokes figure and no derivation note at all.
describe("JoinRoundPage — what you normally shoot", () => {
  it("asks the question verbatim, starts blank, and keeps Join disabled until a number is typed", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("bo-g"), name: "Bo G" } });
    mockedPeekRound.mockResolvedValue({
      courseName: "Fixture Links 18",
      teeSets: [{ name: "white", rating: 71.6, slope: 128 }],
      createdAt: 1_700_000_000_000,
    });

    renderJoin();
    await screen.findByText(/playing as/i);
    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "abc123" } });
    // Wait for the PICKER specifically, not just any "Tee" field — the free-text fallback carries
    // the same label until the peek resolves, and only the peek sets a tee, which Join needs.
    await waitFor(() => expect(screen.getByLabelText(/^tee$/i).tagName).toBe("SELECT"));

    // Blank, never "0": "0" would assert "I shoot par", a real claim about the player, and no
    // default may put a claim in the round's log.
    const field = screen.getByLabelText("What do you normally shoot, relative to par?") as HTMLInputElement;
    expect(field.value).toBe("");
    expect(screen.getByRole("button", { name: /join round/i }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(field, { target: { value: "26" } });
    expect(screen.getByRole("button", { name: /join round/i }).hasAttribute("disabled")).toBe(false);
  });

  it("renders no derived-number machinery and no per-player strokes figure at all", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("bo-g"), name: "Bo G" } });
    mockedPeekRound.mockResolvedValue({
      courseName: "Fixture Links 18",
      teeSets: [{ name: "white", rating: 71.6, slope: 128 }],
      createdAt: 1_700_000_000_000,
    });

    renderJoin();
    await screen.findByText(/playing as/i);
    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "abc123" } });
    await waitFor(() => expect(screen.getByLabelText(/^tee$/i).tagName).toBe("SELECT"));

    // Every retired vocabulary item, in one gate: the label, the derivation note, and the word
    // "handicap"/"index" anywhere on the page (spec §9's language rule).
    expect(screen.queryByLabelText(/strokes you get here/i)).toBeNull();
    expect(screen.queryByText(/from your index/i)).toBeNull();
    expect(screen.queryByText(/handicap/i)).toBeNull();
    expect(screen.queryByText(/index/i)).toBeNull();
    // The tee picker still shows each tee's printed numbers — they stay ON the card, nothing
    // computes from them (spec §7).
    const teeSelect = screen.getByLabelText(/^tee$/i) as HTMLSelectElement;
    expect(teeSelect.options[0]!.textContent).toMatch(/rating 71.6, slope 128/);
  });

  it("submits a negative for an under-par player — minus means under par, the one sign convention left", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("under-g"), name: "Under" } });
    mockedJoinRound.mockResolvedValue({ roundId: roundId("round-under"), token: "tok-under", golferId: golferId("under-g"), joinCode: "ABC234" });

    renderJoin();
    await screen.findByText(/playing as/i);

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "abc234" } });
    fireEvent.change(screen.getByLabelText(/^tee$/i), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText("What do you normally shoot, relative to par?"), { target: { value: "-2" } });
    fireEvent.click(screen.getByRole("button", { name: /join round/i }));

    await waitFor(() => expect(mockedJoinRound).toHaveBeenCalledTimes(1));
    expect(mockedJoinRound.mock.calls[0]![0]).toEqual({ code: "ABC234", tee: "white", basis: { kind: "normally-shoots", overPar: -2 } });
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
