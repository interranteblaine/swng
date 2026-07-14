import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetMeResponse } from "@swng/contracts";
import { golferId, roundId } from "@swng/domain";
import { credentialStore } from "../identity";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// M8 Task 6: HomePage composes useAuth, so the api.ts module boundary is faked here too — getMe
// for the AuthProvider. Realignment Task 13 adds getMyLiveRounds for the signed-in-with-a-golfer
// "Your rounds" section (presence, not the device credentialStore list). Task 14 adds
// mintParticipantToken — the tap-to-enter re-mint for a live round this device holds no local
// credential for. Crews are a grouping/competition only (spec §11a, owner ruling) and moved off
// this page entirely — HomePage never calls a crew endpoint at all anymore.
vi.mock("../api", () => ({
  getMe: vi.fn(),
  getMyLiveRounds: vi.fn(),
  mintParticipantToken: vi.fn(),
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

import { ApiError, getMe, getMyLiveRounds, mintParticipantToken } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { HomePage } from "./HomePage";

const mockedGetMe = vi.mocked(getMe);
const mockedGetMyLiveRounds = vi.mocked(getMyLiveRounds);
const mockedMintParticipantToken = vi.mocked(mintParticipantToken);

// vitest.config.ts doesn't set test.globals, so @testing-library/react's own auto-cleanup
// (which only fires when it finds a GLOBAL `afterEach`) never registers — every spec file in
// this app that calls render() more than once must clean up explicitly, or one test's DOM
// (and localStorage stub) bleeds into the next.
beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  mockedGetMe.mockReset();
  mockedGetMyLiveRounds.mockReset();
  mockedMintParticipantToken.mockReset();
  mockedGetMyLiveRounds.mockResolvedValue({ rounds: [] });
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
  tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 });
  return idToken;
};

const renderHome = () =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/round/:roundId" element={<div>round page probe</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

describe("HomePage", () => {
  // The wall (accounts-only identity spec §3): no anonymous "start a round" — signed out, that
  // action is a sign-in CTA, and the whole page is sign-in / join-by-code / watch links only.
  it("signed out: shows a sign-in CTA instead of an anonymous Start a round link", () => {
    renderHome();

    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Start a round" })).toBeNull();
  });

  it("signed in: shows the Start a round link to /create", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });

    renderHome();

    const link = await screen.findByRole("link", { name: "Start a round" });
    expect(link.getAttribute("href")).toBe("/create");
  });

  it("links Join by code to /join", () => {
    renderHome();

    const link = screen.getByRole("link", { name: "Join by code" });
    expect(link.getAttribute("href")).toBe("/join");
  });

  it("lists saved rounds from credentialStore.list(), each linking to /round/:id", () => {
    credentialStore.save(roundId("round-1"), { token: "t1", golferId: golferId("ann"), name: "Ann", joinCode: "AAA111" });
    credentialStore.save(roundId("round-2"), { token: "t2", golferId: golferId("bo"), name: "Bo", joinCode: "BBB222" });

    renderHome();

    const annLink = screen.getByRole("link", { name: "Ann" });
    const boLink = screen.getByRole("link", { name: "Bo" });
    expect(annLink.getAttribute("href")).toBe("/round/round-1");
    expect(boLink.getAttribute("href")).toBe("/round/round-2");
  });

  it("shows an empty state when no rounds are saved", () => {
    renderHome();

    expect(screen.getByText(/no rounds yet/i)).toBeTruthy();
  });
});

// Architecture-realignment Task 13 (spec §5): "Your rounds" follows IDENTITY once a real
// account golfer exists — GET /me/rounds/live, never the device credentialStore list. Every
// OTHER state (signed out, or signed in with no golfer row yet) keeps the device list exactly
// as the untouched suite above pins.
describe("HomePage — your rounds by identity (Task 13)", () => {
  it("signed in with a golfer: lists live rounds from GET /me/rounds/live, not the device credential list", async () => {
    // A device credential exists too — proves the identity list wins, not merely "renders
    // something."
    credentialStore.save(roundId("device-round"), { token: "t1", golferId: golferId("ann"), name: "Device Round", joinCode: "AAA111" });
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetMyLiveRounds.mockResolvedValue({ rounds: [{ roundId: roundId("live-1"), courseName: "Casa Verde GC", joinedAt: 5_000 }] });

    renderHome();

    const link = await screen.findByRole("link", { name: /casa verde gc/i });
    expect(link.getAttribute("href")).toBe("/round/live-1");
    expect(mockedGetMyLiveRounds).toHaveBeenCalledWith(idToken);
    expect(screen.queryByRole("link", { name: "Device Round" })).toBeNull();
  });

  it("signed in with a golfer but no live rounds: shows the empty state, never falling back to the device credential list", async () => {
    credentialStore.save(roundId("device-round"), { token: "t1", golferId: golferId("ann"), name: "Device Round", joinCode: "AAA111" });
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetMyLiveRounds.mockResolvedValue({ rounds: [] });

    renderHome();

    expect(await screen.findByText(/no rounds yet/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Device Round" })).toBeNull();
  });

  it("signed in but no golfer row yet: keeps the device credential list and never calls GET /me/rounds/live", async () => {
    credentialStore.save(roundId("device-round"), { token: "t1", golferId: golferId("ann"), name: "Device Round", joinCode: "AAA111" });
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: null });

    renderHome();

    const link = await screen.findByRole("link", { name: "Device Round" });
    expect(link.getAttribute("href")).toBe("/round/device-round");
    expect(mockedGetMyLiveRounds).not.toHaveBeenCalled();
  });
});

// Architecture-realignment Task 14: tapping a live round the caller's identity shows may have
// no local device credential at all (started/joined elsewhere) — a re-mint call, stored via
// credentialStore exactly as a real join would, before entering. A device that already holds a
// credential must navigate exactly as before this task — no network call at all.
describe("HomePage — tapping a live round re-mints a scoring credential when this device has none (Task 14)", () => {
  it("no local credential: mints a token, stores it via credentialStore, and enters — no raw Link navigation", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetMyLiveRounds.mockResolvedValue({ rounds: [{ roundId: roundId("live-1"), courseName: "Casa Verde GC", joinedAt: 5_000 }] });
    mockedMintParticipantToken.mockResolvedValue({ roundId: roundId("live-1"), token: "fresh-token", golferId: golferId("ann-g") });

    renderHome();
    const link = await screen.findByRole("link", { name: /casa verde gc/i });
    expect(credentialStore.load(roundId("live-1"))).toBeUndefined(); // precondition: no local credential yet

    fireEvent.click(link);

    await screen.findByText("round page probe");
    expect(mockedMintParticipantToken).toHaveBeenCalledWith(idToken, roundId("live-1"));
    expect(credentialStore.load(roundId("live-1"))).toEqual({ token: "fresh-token", golferId: golferId("ann-g"), name: "Ann G", joinCode: "" });
  });

  it("a local credential already exists: navigates directly, never calling the re-mint", async () => {
    credentialStore.save(roundId("live-1"), { token: "existing-token", golferId: golferId("ann-g"), name: "Ann G", joinCode: "XYZ123" });
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetMyLiveRounds.mockResolvedValue({ rounds: [{ roundId: roundId("live-1"), courseName: "Casa Verde GC", joinedAt: 5_000 }] });

    renderHome();
    const link = await screen.findByRole("link", { name: /casa verde gc/i });

    fireEvent.click(link);

    await screen.findByText("round page probe");
    expect(mockedMintParticipantToken).not.toHaveBeenCalled();
    // The pre-existing credential is untouched — no clobbering by a call that never happened.
    expect(credentialStore.load(roundId("live-1"))).toEqual({ token: "existing-token", golferId: golferId("ann-g"), name: "Ann G", joinCode: "XYZ123" });
  });

  it("a 403 not-a-participant surfaces human copy, never the raw server text", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetMyLiveRounds.mockResolvedValue({ rounds: [{ roundId: roundId("live-1"), courseName: "Casa Verde GC", joinedAt: 5_000 }] });
    mockedMintParticipantToken.mockRejectedValue(new ApiError("not-a-participant", 403, "golfer ann-g is not a participant in round live-1"));

    renderHome();
    const link = await screen.findByRole("link", { name: /casa verde gc/i });

    fireEvent.click(link);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/you're not in this round/i);
    expect(screen.queryByText(/is not a participant in round/i)).toBeNull();
    // Never entered — no credential was ever stored for this failed attempt.
    expect(credentialStore.load(roundId("live-1"))).toBeUndefined();
  });

  it("a 409 round-final surfaces finished copy with an archive link and removes the row from live rounds", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetMyLiveRounds.mockResolvedValue({ rounds: [{ roundId: roundId("live-1"), courseName: "Casa Verde GC", joinedAt: 5_000 }] });
    mockedMintParticipantToken.mockRejectedValue(new ApiError("round-final", 409, "round live-1 is finalized"));

    renderHome();
    const link = await screen.findByRole("link", { name: /casa verde gc/i });
    expect(link).toBeTruthy(); // precondition: row exists before click

    fireEvent.click(link);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/this round has finished/i);
    expect(screen.queryByText(/is finalized/i)).toBeNull();
    // Archive link is present with the correct href
    const archiveLink = screen.getByRole("link", { name: /view archived round/i });
    expect(archiveLink.getAttribute("href")).toBe(`/rounds/live-1/archive`);
    // Row removed from live list
    expect(screen.queryByRole("link", { name: /casa verde gc/i })).toBeNull();
  });
});

// Fix wave (review of 1b39f4d): hasGolferIdentity = Boolean(golfer) can't distinguish "GET /me
// still in flight" from "signed out" — a signed-in golfer used to see the device credential
// list (or "No rounds yet") flash for the whole GET /me round trip before the identity list
// replaced it. A resolve-next-microtask mock can't catch this (the loading window never
// observably exists); a DEFERRED promise held open across an assertion is the only way to prove
// the flash is gone.
describe("HomePage — GET /me loading window never flashes the device list (fix wave)", () => {
  it("signed in, GET /me still in flight: neither the device list nor the identity list renders — a quiet placeholder instead", async () => {
    credentialStore.save(roundId("device-round"), { token: "t1", golferId: golferId("ann"), name: "Device Round", joinCode: "AAA111" });
    signIn();
    mockedGetMe.mockReturnValue(new Promise<GetMeResponse>(() => {})); // the loading window itself — never resolves

    renderHome();

    // The device list must NOT appear during this window (the bug this closes) — asserted
    // synchronously, before any resolution could occur, so a regression back to
    // Boolean(golfer) would fail this line even under a resolve-next-microtask mock.
    expect(screen.queryByRole("link", { name: "Device Round" })).toBeNull();
    expect(screen.queryByText(/no rounds yet/i)).toBeNull();
    expect(screen.getByRole("status", { name: /loading your rounds/i })).toBeTruthy();
  });

  it("once the deferred GET /me resolves to a golfer, the loading placeholder gives way to the identity list", async () => {
    credentialStore.save(roundId("device-round"), { token: "t1", golferId: golferId("ann"), name: "Device Round", joinCode: "AAA111" });
    signIn();
    let resolveGetMe: (value: GetMeResponse) => void = () => {};
    mockedGetMe.mockReturnValue(
      new Promise<GetMeResponse>((resolve) => {
        resolveGetMe = resolve;
      }),
    );
    mockedGetMyLiveRounds.mockResolvedValue({ rounds: [{ roundId: roundId("live-1"), courseName: "Casa Verde GC", joinedAt: 5_000 }] });

    renderHome();
    expect(screen.getByRole("status", { name: /loading your rounds/i })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Device Round" })).toBeNull();

    resolveGetMe({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });

    const link = await screen.findByRole("link", { name: /casa verde gc/i });
    expect(link.getAttribute("href")).toBe("/round/live-1");
    expect(screen.queryByRole("status", { name: /loading your rounds/i })).toBeNull();
    expect(screen.queryByRole("link", { name: "Device Round" })).toBeNull();
  });

  it("once the deferred GET /me resolves to no golfer row, the loading placeholder gives way to the device list", async () => {
    credentialStore.save(roundId("device-round"), { token: "t1", golferId: golferId("ann"), name: "Device Round", joinCode: "AAA111" });
    signIn();
    let resolveGetMe: (value: GetMeResponse) => void = () => {};
    mockedGetMe.mockReturnValue(
      new Promise<GetMeResponse>((resolve) => {
        resolveGetMe = resolve;
      }),
    );

    renderHome();
    expect(screen.getByRole("status", { name: /loading your rounds/i })).toBeTruthy();

    resolveGetMe({ golfer: null });

    const link = await screen.findByRole("link", { name: "Device Round" });
    expect(link.getAttribute("href")).toBe("/round/device-round");
    expect(screen.queryByRole("status", { name: /loading your rounds/i })).toBeNull();
    expect(mockedGetMyLiveRounds).not.toHaveBeenCalled();
  });
});

// Owner ruling (spec §11a): a crew is a grouping/competition only — home is start a round, join
// by code, your rounds, full stop. "Your crews"/"New crew"/crew join-by-code lived on this page
// through M8; this pins the negative directly, in every auth state HomePage can render, not just
// the signed-out case the untouched suites above happen to exercise.
describe("HomePage — no crews section, in any auth state (spec §11a)", () => {
  const queryAnyCrewText = (): boolean => screen.queryByText(/your crews|new crew|crew code|join crew/i) !== null;

  it("signed out: no crews section anywhere on the page", () => {
    renderHome();

    expect(queryAnyCrewText()).toBe(false);
  });

  it("signed in, GET /me still loading: no crews section anywhere on the page", () => {
    signIn();
    mockedGetMe.mockReturnValue(new Promise<GetMeResponse>(() => {})); // never resolves — the loading window itself

    renderHome();

    expect(queryAnyCrewText()).toBe(false);
  });

  it("signed in, no golfer row yet: no crews section anywhere on the page", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: null });

    renderHome();
    await screen.findByText(/no rounds yet/i); // let the signed-in render settle

    expect(queryAnyCrewText()).toBe(false);
  });

  it("signed in with a real account golfer: no crews section anywhere on the page", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetMyLiveRounds.mockResolvedValue({ rounds: [] });

    renderHome();
    await screen.findByText(/no rounds yet/i); // let the signed-in render settle

    expect(queryAnyCrewText()).toBe(false);
  });
});
