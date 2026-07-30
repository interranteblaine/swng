import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crewId, golferId } from "@swng/domain";
import type { PeekCrewInviteResponse } from "@swng/contracts";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary, same idiom as JoinRoundPage.test.tsx — CrewJoinPage calls
// peekCrewInvite, joinCrewByInvite, updateMe (the funnel's name prompt), and getMe (via
// AuthProvider). peekCrewInvite defaults to a never-resolving promise so a test that never
// explicitly stubs it exercises the "Loading invite…" state, not an unhandled rejection.
vi.mock("../api", () => ({
  peekCrewInvite: vi.fn(),
  joinCrewByInvite: vi.fn(),
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

import { ApiError, getMe, joinCrewByInvite, peekCrewInvite, updateMe } from "../api";
import { CrewJoinPage } from "./CrewJoinPage";

const mockedPeekCrewInvite = vi.mocked(peekCrewInvite);
const mockedJoinCrewByInvite = vi.mocked(joinCrewByInvite);
const mockedGetMe = vi.mocked(getMe);
const mockedUpdateMe = vi.mocked(updateMe);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  mockedPeekCrewInvite.mockReset();
  mockedJoinCrewByInvite.mockReset();
  mockedGetMe.mockReset();
  mockedUpdateMe.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function HomeProbe() {
  return <div data-testid="home-probe">home</div>;
}
function CrewProbe() {
  return <div data-testid="crew-probe">crew page probe</div>;
}

const renderJoin = (initialEntry = "/crews/join") =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/" element={<HomeProbe />} />
          <Route path="/crews/join" element={<CrewJoinPage />} />
          <Route path="/crews/:crewId" element={<CrewProbe />} />
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

const peekResponse: PeekCrewInviteResponse = { crewName: "The Saturday Boys", memberCount: 8, inviterName: "Al" };

describe("CrewJoinPage — missing/dead token", () => {
  it("no fragment at all: an honest incomplete-link message, a link home, no peek call", () => {
    renderJoin("/crews/join");

    expect(screen.getByRole("status").textContent).toMatch(/looks incomplete/i);
    expect(screen.getByRole("link", { name: /back to swng/i }).getAttribute("href")).toBe("/");
    expect(mockedPeekCrewInvite).not.toHaveBeenCalled();
  });

  it("shows a loading state while the peek is in flight", () => {
    mockedPeekCrewInvite.mockReturnValue(new Promise<PeekCrewInviteResponse>(() => {})); // never resolves

    renderJoin("/crews/join#tok-1");

    expect(screen.getByRole("status").textContent).toMatch(/loading invite/i);
  });

  it("crew-invite-expired maps to the EXACT brief copy, with a link home and no form", async () => {
    mockedPeekCrewInvite.mockRejectedValue(new ApiError("crew-invite-expired", 403, "invite token expired"));

    renderJoin("/crews/join#tok-1");

    // findByText (not findByRole("status")): both the "Loading invite…" placeholder AND the
    // eventual error both carry role="status" — findByRole resolves on the FIRST match it
    // sees (the loading one, present synchronously at mount), so the wait must target the
    // final text itself to actually wait through the async rejection.
    const status = await screen.findByText("This invite link has expired — ask your crew for a fresh one.");
    expect(status.getAttribute("role")).toBe("status");
    expect(screen.getByRole("link", { name: /back to swng/i }).getAttribute("href")).toBe("/");
    expect(screen.queryByRole("button", { name: /^join$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /sign in/i })).toBeNull();
  });

  it("crew-invite-invalid maps to the EXACT brief copy", async () => {
    mockedPeekCrewInvite.mockRejectedValue(new ApiError("crew-invite-invalid", 403, "invite token invalid"));

    renderJoin("/crews/join#garbage");

    const status = await screen.findByText("This invite link isn't valid — ask your crew for a fresh one.");
    expect(status.getAttribute("role")).toBe("status");
  });

  it("an unmapped peek failure falls back to honest generic copy, never the raw server text", async () => {
    mockedPeekCrewInvite.mockRejectedValue(new Error("network down"));

    renderJoin("/crews/join#tok-1");

    const status = await screen.findByText("Could not load this invite — try again.");
    expect(status.getAttribute("role")).toBe("status");
    expect(document.body.textContent).not.toMatch(/network down/);
  });
});

describe("CrewJoinPage — the consent card", () => {
  it("renders the EXACT heading and member/inviter line from the peek, before sign-in", async () => {
    mockedPeekCrewInvite.mockResolvedValue(peekResponse);

    renderJoin("/crews/join#tok-1");

    expect(await screen.findByRole("heading", { name: "Join The Saturday Boys?" })).toBeTruthy();
    expect(screen.getByText("8 members · invited by Al")).toBeTruthy();
    // Nav infrastructure Task 2: usePageTitle re-runs once the peek resolves — the crew's name.
    expect(document.title).toBe("The Saturday Boys · swng");
  });

  // The solo-founder crew is the commonest consent card there is (a brand-new crew's first
  // invite) — it must not read "1 members" (C-T3 review minor, fixed at C-T5).
  it("a one-member crew reads '1 member', singular", async () => {
    mockedPeekCrewInvite.mockResolvedValue({ ...peekResponse, memberCount: 1 });

    renderJoin("/crews/join#tok-1");

    expect(await screen.findByText("1 member · invited by Al")).toBeTruthy();
  });

  it("passes the token through to peekCrewInvite", async () => {
    mockedPeekCrewInvite.mockResolvedValue(peekResponse);

    renderJoin("/crews/join#invite-abc");

    await waitFor(() => expect(mockedPeekCrewInvite).toHaveBeenCalledWith({ token: "invite-abc" }));
  });
});

describe("CrewJoinPage — signed out", () => {
  it("shows a SignInCta (no Join button) once the peek resolves", async () => {
    mockedPeekCrewInvite.mockResolvedValue(peekResponse);

    renderJoin("/crews/join#tok-1");

    await screen.findByRole("heading", { name: "Join The Saturday Boys?" });
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^join$/i })).toBeNull();
  });

  it("preserves the FULL link (path + fragment) across the round trip: Sign in stashes returnTo", async () => {
    mockedPeekCrewInvite.mockResolvedValue(peekResponse);

    renderJoin("/crews/join#invite-xyz");
    await screen.findByRole("heading", { name: "Join The Saturday Boys?" });

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(sessionStorage.getItem("swng:returnTo")).toBe("/crews/join#invite-xyz");
  });
});

describe("CrewJoinPage — the name prompt (signed in, placeholder golfer)", () => {
  it("a placeholder golfer sees 'What should the card call you?' — not the Join button yet", async () => {
    signIn();
    mockedPeekCrewInvite.mockResolvedValue(peekResponse);
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("g1"), name: "Golfer 4821", namePlaceholder: true } });

    renderJoin("/crews/join#tok-1");

    await screen.findByLabelText(/what should the card call you/i);
    expect(screen.queryByRole("button", { name: /^join$/i })).toBeNull();
  });

  it("saving the name PUTs /me and proceeds straight to the Join button in the same visit", async () => {
    signIn();
    mockedPeekCrewInvite.mockResolvedValue(peekResponse);
    mockedGetMe
      .mockResolvedValueOnce({ golfer: { golferId: golferId("g1"), name: "Golfer 4821", namePlaceholder: true } })
      .mockResolvedValueOnce({ golfer: { golferId: golferId("g1"), name: "Bo Real" } });
    mockedUpdateMe.mockResolvedValue({ golfer: { golferId: golferId("g1"), name: "Bo Real" } });

    renderJoin("/crews/join#tok-1");

    const nameField = await screen.findByLabelText(/what should the card call you/i);
    fireEvent.change(nameField, { target: { value: "Bo Real" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(mockedUpdateMe).toHaveBeenCalledWith(expect.any(String), { name: "Bo Real" }));
    expect(await screen.findByRole("button", { name: /^join$/i })).toBeTruthy();
  });
});

describe("CrewJoinPage — identity still loading", () => {
  it("no name prompt, no Join button, a quiet placeholder instead", async () => {
    signIn();
    mockedPeekCrewInvite.mockResolvedValue(peekResponse);
    mockedGetMe.mockReturnValue(new Promise(() => {})); // never resolves

    renderJoin("/crews/join#tok-1");

    await screen.findByRole("heading", { name: "Join The Saturday Boys?" });
    expect(screen.getByRole("status", { name: /loading your profile/i })).toBeTruthy();
    expect(screen.queryByLabelText(/what should the card call you/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^join$/i })).toBeNull();
  });
});

describe("CrewJoinPage — join as yourself (signed in, real name)", () => {
  it("Join calls joinCrewByInvite with the token and navigates to the crew page on success", async () => {
    const idToken = signIn();
    mockedPeekCrewInvite.mockResolvedValue(peekResponse);
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("bo-g"), name: "Bo G" } });
    mockedJoinCrewByInvite.mockResolvedValue({ crew: { crewId: crewId("crew-9"), name: "The Saturday Boys", members: [] } });

    renderJoin("/crews/join#invite-abc");
    await screen.findByRole("heading", { name: "Join The Saturday Boys?" });

    fireEvent.click(await screen.findByRole("button", { name: /^join$/i }));

    await waitFor(() => expect(mockedJoinCrewByInvite).toHaveBeenCalledWith(idToken, { token: "invite-abc" }));
    expect(await screen.findByTestId("crew-probe")).toBeTruthy();
  });

  it("a join failure (e.g. the invite expired mid-visit) shows the mapped copy, never the raw server text, and stays on the page", async () => {
    signIn();
    mockedPeekCrewInvite.mockResolvedValue(peekResponse);
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("bo-g"), name: "Bo G" } });
    mockedJoinCrewByInvite.mockRejectedValue(new ApiError("crew-invite-expired", 403, "invite token expired"));

    renderJoin("/crews/join#invite-abc");
    await screen.findByRole("heading", { name: "Join The Saturday Boys?" });

    fireEvent.click(await screen.findByRole("button", { name: /^join$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("This invite link has expired — ask your crew for a fresh one.");
    expect(document.body.textContent).not.toMatch(/invite token expired/);
    expect(screen.queryByTestId("crew-probe")).toBeNull();
  });
});
