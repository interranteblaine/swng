import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { roundId } from "@swng/domain";
import type { GolferRoundLine } from "@swng/domain";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { ProfilePage } from "./ProfilePage";

const fakeResponse = (status: number, body: unknown): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const lineWithDifferential = (roundIdSuffix: string, differential: number): GolferRoundLine => ({
  roundId: roundId(`round-${roundIdSuffix}`),
  courseName: "Pebble Beach",
  tee: "white",
  holes: 18,
  ags: 82,
  differential,
  distribution: { eagles: 0, birdies: 1, pars: 10, bogeys: 6, doublePlus: 1 },
});

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const signIn = () => {
  const base64url = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const idToken = `${base64url({ alg: "none" })}.${base64url({ sub: "sub-1", email: "ann@example.com" })}.sig`;
  tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 });
};

describe("ProfilePage — signed out", () => {
  it("shows a sign-in prompt, never renders the form", () => {
    render(
      <AuthProvider>
        <ProfilePage />
      </AuthProvider>,
    );

    expect(screen.getByText(/sign in to see your profile/i)).toBeTruthy();
    expect(screen.queryByLabelText("Name")).toBeNull();
  });
});

describe("ProfilePage — signed in", () => {
  it("first-time golfer (golfer: null): blank form, bootstrap explainer, no trend SVG", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: null });
        if (path === "/me/record") return fakeResponse(200, { history: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    render(
      <AuthProvider>
        <ProfilePage />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText(/computes after 3 posted/i)).toBeTruthy());
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("img", { name: "Index trend" })).toBeNull();
    expect(screen.getByText(/no rounds yet/i)).toBeTruthy();
  });

  it("renders the pre-filled form, computed index, trend SVG, distribution bars, and newest-first history", async () => {
    signIn();
    const history: GolferRoundLine[] = [lineWithDifferential("1", 9.2), lineWithDifferential("2", 11.8), lineWithDifferential("3", 14.5)]; // newest-first, per the wire contract
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann", declared: 15 } });
        if (path === "/me/record") return fakeResponse(200, { index: { value: 7.2, computedAtMs: 1_000, differentialsUsed: 1 }, history });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    render(
      <AuthProvider>
        <ProfilePage />
      </AuthProvider>,
    );

    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Ann"));
    expect((screen.getByLabelText("Declared index") as HTMLInputElement).value).toBe("15");

    expect(screen.getByText("7.2")).toBeTruthy(); // computed index
    expect(screen.getByText(/from 1 differential/)).toBeTruthy();
    expect(screen.getByRole("img", { name: "Index trend" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Scoring distribution" })).toBeTruthy();

    // History renders newest-first, exactly as the wire response ordered it (no re-sort).
    const historyItems = screen.getAllByText(/Pebble Beach — white/);
    expect(historyItems[0]?.textContent).toMatch(/differential 9.2/);
    expect(historyItems[1]?.textContent).toMatch(/differential 11.8/);
    expect(historyItems[2]?.textContent).toMatch(/differential 14.5/);
  });

  it("saving the form PUTs /me, then re-fetches /me", async () => {
    signIn();
    const calls: string[] = [];
    let meCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/me" && init?.method === "PUT") {
          return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann Updated", declared: 12 } });
        }
        if (path === "/me") {
          meCallCount += 1;
          return fakeResponse(200, meCallCount === 1 ? { golfer: null } : { golfer: { golferId: "ann", name: "Ann Updated", declared: 12 } });
        }
        if (path === "/me/record") return fakeResponse(200, { history: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    render(
      <AuthProvider>
        <ProfilePage />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/computes after 3 posted/i)).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ann Updated" } });
    fireEvent.change(screen.getByLabelText("Declared index"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    expect(calls).toContain("PUT /me");
    // The re-fetch after save is a real GET /me, not just a locally-applied echo of the PUT response.
    expect(calls.filter((c) => c === "GET /me").length).toBeGreaterThanOrEqual(2);
  });
});
