import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crewId, golferId } from "@swng/domain";
import { createMemoryStorage } from "../testSupport/memoryStorage";

vi.mock("../api", () => ({
  createCrew: vi.fn(),
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

import { ApiError, createCrew, getMe } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { CrewCreatePage } from "./CrewCreatePage";

const mockedCreateCrew = vi.mocked(createCrew);
const mockedGetMe = vi.mocked(getMe);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  mockedCreateCrew.mockReset();
  mockedGetMe.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

const renderPage = () =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/crews/new"]}>
        <Routes>
          <Route path="/crews/new" element={<CrewCreatePage />} />
          <Route path="/crews/:crewId" element={<div>crew page probe</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

describe("CrewCreatePage", () => {
  it("name → POST /crews with the bearer token → navigates to the new crew's page", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });
    mockedCreateCrew.mockResolvedValue({ crew: { crewId: crewId("crew-1"), name: "Sunday crew", members: [] } });

    renderPage();

    fireEvent.change(screen.getByLabelText(/crew name/i), { target: { value: "Sunday crew" } });
    fireEvent.click(screen.getByRole("button", { name: /create crew/i }));

    await waitFor(() => expect(mockedCreateCrew).toHaveBeenCalledTimes(1));
    expect(mockedCreateCrew).toHaveBeenCalledWith(idToken, { name: "Sunday crew" });
    await screen.findByText("crew page probe");
  });

  it("a blank name never submits", () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: null });

    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /create crew/i }));
    expect(mockedCreateCrew).not.toHaveBeenCalled();
  });

  it("a failed create shows humanized copy, never the raw server text", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: null });
    mockedCreateCrew.mockRejectedValue(new ApiError("http-500", 500, "internal error"));

    renderPage();

    fireEvent.change(screen.getByLabelText(/crew name/i), { target: { value: "Sunday crew" } });
    fireEvent.click(screen.getByRole("button", { name: /create crew/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not create the crew/i);
    expect(screen.queryByText(/internal error/)).toBeNull();
  });

  // M8 close-out fix #2: golfer-required means the signed-in account has no golfer profile
  // yet — this form collects no name, so retrying can never fix it. The generic "try again"
  // copy was a dead end; this arm points at the ONE place that fixes it.
  it("golfer-required points at the profile page instead of a dead-end retry", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: null });
    mockedCreateCrew.mockRejectedValue(new ApiError("golfer-required", 400, "golfer row required for sub sub-1"));

    renderPage();

    fireEvent.change(screen.getByLabelText(/crew name/i), { target: { value: "Sunday crew" } });
    fireEvent.click(screen.getByRole("button", { name: /create crew/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/set your name on your profile/i);
    expect(screen.queryByText(/sub sub-1/)).toBeNull();
    const link = screen.getByRole("link", { name: /profile/i });
    expect(link.getAttribute("href")).toBe("/profile");
  });

  it("signed out: prompts to sign in instead of offering the form", () => {
    renderPage();

    expect(screen.getByText(/sign in to create a crew/i)).toBeTruthy();
    expect(screen.queryByLabelText(/crew name/i)).toBeNull();
  });
});
