import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetMeResponse } from "@swng/contracts";
import { crewId, golferId, roundId } from "@swng/domain";
import { credentialStore } from "../identity";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// M8 Task 6: HomePage now composes useAuth (the crews surface is golfer-gated), so the api.ts
// module boundary is faked here too — getMe for the AuthProvider, listMyCrews/joinCrew for the
// "Your crews" section. Realignment Task 13 adds getMyLiveRounds for the signed-in-with-a-
// golfer "Your rounds" section (presence, not the device credentialStore list). Task 14 adds
// mintParticipantToken — the tap-to-enter re-mint for a live round this device holds no local
// credential for.
vi.mock("../api", () => ({
  getMe: vi.fn(),
  listMyCrews: vi.fn(),
  joinCrew: vi.fn(),
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

import { ApiError, getMe, getMyLiveRounds, joinCrew, listMyCrews, mintParticipantToken } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { HomePage } from "./HomePage";

const mockedGetMe = vi.mocked(getMe);
const mockedListMyCrews = vi.mocked(listMyCrews);
const mockedJoinCrew = vi.mocked(joinCrew);
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
  mockedListMyCrews.mockReset();
  mockedJoinCrew.mockReset();
  mockedGetMyLiveRounds.mockReset();
  mockedMintParticipantToken.mockReset();
  // Default: no live rounds — the crews-focused suite below never sets this itself, so this
  // keeps that suite's assertions (about "Your crews", not "Your rounds") from tripping over
  // an unhandled mock return.
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
          <Route path="/crews/:crewId" element={<div>crew page probe</div>} />
          <Route path="/round/:roundId" element={<div>round page probe</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

describe("HomePage", () => {
  it("links Start a round to /create", () => {
    renderHome();

    const link = screen.getByRole("link", { name: "Start a round" });
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
    mockedListMyCrews.mockResolvedValue({ crews: [] });
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
    mockedListMyCrews.mockResolvedValue({ crews: [] });
    mockedGetMyLiveRounds.mockResolvedValue({ rounds: [] });

    renderHome();
    await screen.findByText(/your crews/i); // wait for the signed-in render to settle

    expect(screen.getByText(/no rounds yet/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Device Round" })).toBeNull();
  });

  it("signed in but no golfer row yet: keeps the device credential list and never calls GET /me/rounds/live", async () => {
    credentialStore.save(roundId("device-round"), { token: "t1", golferId: golferId("ann"), name: "Device Round", joinCode: "AAA111" });
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: null });
    mockedListMyCrews.mockResolvedValue({ crews: [] });

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
    mockedListMyCrews.mockResolvedValue({ crews: [] });
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
    mockedListMyCrews.mockResolvedValue({ crews: [] });
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
    mockedListMyCrews.mockResolvedValue({ crews: [] });
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
    mockedListMyCrews.mockResolvedValue({ crews: [] });

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
    mockedListMyCrews.mockResolvedValue({ crews: [] });
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
    mockedListMyCrews.mockResolvedValue({ crews: [] });

    renderHome();
    expect(screen.getByRole("status", { name: /loading your rounds/i })).toBeTruthy();

    resolveGetMe({ golfer: null });

    const link = await screen.findByRole("link", { name: "Device Round" });
    expect(link.getAttribute("href")).toBe("/round/device-round");
    expect(screen.queryByRole("status", { name: /loading your rounds/i })).toBeNull();
    expect(mockedGetMyLiveRounds).not.toHaveBeenCalled();
  });
});

// M8 Task 6: the signed-in home gains "Your crews" (GET /me/crews), "New crew", and
// "Join a crew" — none of which exist signed out (every crew route is golfer-gated).
describe("HomePage — crews", () => {
  it("signed out: no crews section, no crew fetch", () => {
    renderHome();

    expect(screen.queryByText(/your crews/i)).toBeNull();
    expect(mockedListMyCrews).not.toHaveBeenCalled();
  });

  it("signed in: lists crews from GET /me/crews, each linking to its crew page", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });
    mockedListMyCrews.mockResolvedValue({
      crews: [
        { crewId: crewId("crew-1"), name: "Sunday crew", memberCount: 4 },
        { crewId: crewId("crew-2"), name: "Work league", memberCount: 8 },
      ],
    });

    renderHome();

    const sundayLink = await screen.findByRole("link", { name: /sunday crew/i });
    expect(sundayLink.getAttribute("href")).toBe("/crews/crew-1");
    expect(screen.getByRole("link", { name: /work league/i }).getAttribute("href")).toBe("/crews/crew-2");
    expect(mockedListMyCrews).toHaveBeenCalledWith(idToken);
  });

  it("signed in: offers a New crew link to /crews/new", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: null });
    mockedListMyCrews.mockResolvedValue({ crews: [] });

    renderHome();

    const link = await screen.findByRole("link", { name: /new crew/i });
    expect(link.getAttribute("href")).toBe("/crews/new");
  });

  it("join a crew: code entry → POST /crews/join → navigates to the crew page", async () => {
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });
    mockedListMyCrews.mockResolvedValue({ crews: [] });
    mockedJoinCrew.mockResolvedValue({ crew: { crewId: crewId("crew-9"), name: "Saturday crew", joinCode: "CRW999", members: [] } });

    renderHome();
    await screen.findByText(/your crews/i);

    fireEvent.change(screen.getByLabelText(/crew code/i), { target: { value: "crw999" } });
    fireEvent.click(screen.getByRole("button", { name: /join crew/i }));

    await waitFor(() => expect(mockedJoinCrew).toHaveBeenCalledTimes(1));
    // Uppercased before it rides the wire (joinCrewRequestSchema's canonical 6-char form —
    // JoinRoundPage's own code-input precedent).
    expect(mockedJoinCrew).toHaveBeenCalledWith(idToken, { code: "CRW999" });
    await screen.findByText("crew page probe");
  });

  it("an unknown code surfaces humanized copy, never the raw server text", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann G" } });
    mockedListMyCrews.mockResolvedValue({ crews: [] });
    mockedJoinCrew.mockRejectedValue(new ApiError("unknown-crew", 404, 'no crew for join code "ZZZZZZ"'));

    renderHome();
    await screen.findByText(/your crews/i);

    fireEvent.change(screen.getByLabelText(/crew code/i), { target: { value: "ZZZZZZ" } });
    fireEvent.click(screen.getByRole("button", { name: /join crew/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no crew found with that code/i);
    expect(screen.queryByText(/no crew for join code/i)).toBeNull();
  });

  // M8 close-out fix #2: golfer-required means the signed-in account has no golfer profile
  // yet — the join-code form collects no name, so retrying can never fix it. This arm points
  // at the ONE place that fixes it instead of a dead-end "try again".
  it("golfer-required points at the profile page instead of a dead-end retry", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: null });
    mockedListMyCrews.mockResolvedValue({ crews: [] });
    mockedJoinCrew.mockRejectedValue(new ApiError("golfer-required", 400, "golfer row required for sub sub-1"));

    renderHome();
    await screen.findByText(/your crews/i);

    fireEvent.change(screen.getByLabelText(/crew code/i), { target: { value: "CRW999" } });
    fireEvent.click(screen.getByRole("button", { name: /join crew/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/set your name on your profile/i);
    expect(screen.queryByText(/sub sub-1/)).toBeNull();
    const link = screen.getByRole("link", { name: /profile/i });
    expect(link.getAttribute("href")).toBe("/profile");
  });

  it("a short code never submits", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: null });
    mockedListMyCrews.mockResolvedValue({ crews: [] });

    renderHome();
    await screen.findByText(/your crews/i);

    fireEvent.change(screen.getByLabelText(/crew code/i), { target: { value: "ABC" } });
    fireEvent.click(screen.getByRole("button", { name: /join crew/i }));

    expect(mockedJoinCrew).not.toHaveBeenCalled();
  });
});
