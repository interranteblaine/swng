import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetMeResponse } from "@swng/contracts";
import { golferId, roundId } from "@swng/domain";
import { credentialStore } from "../identity";
import { roundLabel } from "../roundLabel";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// M8 Task 6: HomePage composes useAuth, so the api.ts module boundary is faked here too — getMe
// for the AuthProvider. Realignment Task 13 adds getMyLiveRounds for the signed-in-with-a-golfer
// "Your rounds" section (presence, not the pre-wall device-credential round list). Task 14 adds
// mintParticipantToken — the tap-to-enter re-mint for a live round this device holds no local
// credential for. Navigation Task 5 adds getMyRounds for the "Recent rounds" switchboard
// section. Crews are a grouping/competition only (spec §11a, owner ruling) and moved off this
// page entirely — HomePage never calls a crew endpoint at all anymore.
vi.mock("../api", () => ({
  getMe: vi.fn(),
  getMyLiveRounds: vi.fn(),
  getMyRounds: vi.fn(),
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

import { ApiError, getMe, getMyLiveRounds, getMyRounds, mintParticipantToken } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { HomePage } from "./HomePage";

const mockedGetMe = vi.mocked(getMe);
const mockedGetMyLiveRounds = vi.mocked(getMyLiveRounds);
const mockedGetMyRounds = vi.mocked(getMyRounds);
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
  mockedGetMyRounds.mockReset();
  mockedMintParticipantToken.mockReset();
  mockedGetMyLiveRounds.mockResolvedValue({ rounds: [] });
  mockedGetMyRounds.mockResolvedValue({ rounds: [] });
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

// Renders the join-funnel destination as a probe reporting exactly what it was navigated to
// (pathname + search), so the door's code-input tests can assert the ACTUAL navigation target
// through the real router rather than a mocked navigate function — the harness this file
// already uses for every other cross-page assertion (see "round page probe" below).
function JoinProbe() {
  const location = useLocation();
  return <div>join page probe: {location.pathname}{location.search}</div>;
}

const renderHome = () =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/round/:roundId" element={<div>round page probe</div>} />
          <Route path="/join" element={<JoinProbe />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

describe("HomePage", () => {
  // The wall (accounts-only identity spec §3): no anonymous "start a round" — signed in is the
  // only state that renders the nav at all now (the signed-out door, tested in its own describe
  // block below, replaces the old dual-sign-in-CTA structure this used to pin).
  it("signed in: shows the Start a round link to /create", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann G" } });

    renderHome();

    const link = await screen.findByRole("link", { name: "Start a round" });
    expect(link.getAttribute("href")).toBe("/create");
  });

  // Join by code is now a signed-in-only nav item (brand reskin spec §3) — signed out, the door
  // (its own describe block below) shows a code INPUT + Join button instead, not this link.
  it("signed in: links Join by code to /join", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann G" } });

    renderHome();

    const link = await screen.findByRole("link", { name: "Join by code" });
    expect(link.getAttribute("href")).toBe("/join");
  });

  // Papercut 10: post-wall, nothing writes new device credentials, so a saved credential can
  // only ever be a pre-wall relic token. Signed out, the door (spec §3) never even reads
  // credentialStore — this pins that a relic credential can't leak a round link onto the door.
  it("signed out, a device holding pre-wall relic credentials shows NO round list — only the door", () => {
    credentialStore.save(roundId("round-1"), { token: "t1", golferId: golferId("ann"), name: "Walker", joinCode: "AAA111" });
    credentialStore.save(roundId("round-2"), { token: "t2", golferId: golferId("bo"), name: "Walker", joinCode: "BBB222" });

    renderHome();

    expect(screen.queryByRole("link", { name: /walker/i })).toBeNull();
    expect(screen.getByText("swng is the app for the golf you actually play.")).toBeTruthy();
  });
});

// Brand reskin spec §3: the signed-out door IS the landing page — no "Your rounds" section
// (a heading whose only content is a locked-feature sign-in box), exactly one sign-in
// affordance, and a round-code input that pre-fills the join funnel rather than gating a
// second CTA behind it.
describe("HomePage — signed-out door (brand reskin spec §3)", () => {
  it("signed out: the door has exactly one sign-in button and no rounds section", () => {
    renderHome();

    expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(1);
    expect(screen.getByText("swng is the app for the golf you actually play.")).toBeTruthy();
    expect(screen.queryByText("Your rounds")).toBeNull();
    expect(screen.queryByText("Sign in to see your rounds.")).toBeNull();
  });

  it("signed out: the door's code input routes into the join funnel with the code", () => {
    renderHome();

    fireEvent.change(screen.getByLabelText("Round code"), { target: { value: "  qk7m2a " } });
    fireEvent.click(screen.getByRole("button", { name: "Join" }));

    expect(screen.getByText("join page probe: /join?code=qk7m2a")).toBeTruthy();
  });

  it("signed out: an empty code input routes to the bare join page", () => {
    renderHome();

    fireEvent.click(screen.getByRole("button", { name: "Join" }));

    expect(screen.getByText("join page probe: /join")).toBeTruthy();
  });
});

// Architecture-realignment Task 13 (spec §5): "Your rounds" follows IDENTITY once a real
// account golfer exists — GET /me/rounds/live, never the pre-wall device-credential round
// list. Every OTHER state (signed out, or signed in with no golfer row yet) shows the sign-in
// CTA instead (papercut 10 deleted the device list outright — see the signed-out suite above).
describe("HomePage — your rounds by identity (Task 13)", () => {
  it("signed in with a golfer: lists live rounds from GET /me/rounds/live, not the device credential list", async () => {
    // A device credential exists too — proves the identity list wins, not merely "renders
    // something."
    credentialStore.save(roundId("device-round"), { token: "t1", golferId: golferId("ann"), name: "Device Round", joinCode: "AAA111" });
    const idToken = signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetMyLiveRounds.mockResolvedValue({ rounds: [{ roundId: roundId("live-1"), courseName: "Casa Verde GC", joinedAt: 5_000 }] });

    renderHome();

    const link = await screen.findByRole("link", { name: /casa verde gc/i });
    expect(link.getAttribute("href")).toBe("/round/live-1");
    expect(mockedGetMyLiveRounds).toHaveBeenCalledWith(idToken);
    expect(screen.queryByRole("link", { name: "Device Round" })).toBeNull();
  });

  // The canonical designation (spec §5): the home list renders course + date, appending the tee
  // time to tell apart two rounds that share course and day — the "two indistinguishable Walker
  // rounds" bug the bare course name produced. HomePage passes NO timeZone (the product default
  // is the viewer's local clock), so the expected labels are computed with roundLabel's own
  // default too — the assertion stays hermetic regardless of the worker's TZ, and never re-pins a
  // UTC-only string.
  it("gives two same-course same-day rounds distinct labels (course · date · time)", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann G" } });
    const morningAt = Date.UTC(2025, 6, 12, 12, 0);
    const afternoonAt = Date.UTC(2025, 6, 12, 18, 0);
    mockedGetMyLiveRounds.mockResolvedValue({
      rounds: [
        { roundId: roundId("walker-1"), courseName: "Walker", joinedAt: 5_000, createdAt: morningAt },
        { roundId: roundId("walker-2"), courseName: "Walker", joinedAt: 6_000, createdAt: afternoonAt },
      ],
    });

    renderHome();

    const morning = await screen.findByRole("link", { name: roundLabel({ courseName: "Walker", createdAt: morningAt }, { withTime: true }) });
    const afternoon = screen.getByRole("link", { name: roundLabel({ courseName: "Walker", createdAt: afternoonAt }, { withTime: true }) });
    expect(morning.getAttribute("href")).toBe("/round/walker-1");
    expect(afternoon.getAttribute("href")).toBe("/round/walker-2");
    // The two labels are genuinely distinct (the tee time did its disambiguating job)...
    expect(morning.textContent).not.toBe(afternoon.textContent);
    // ...and the old ambiguous bare "Walker" label appears for neither.
    expect(screen.queryByRole("link", { name: "Walker" })).toBeNull();
  });

  it("distinguishes same-course rounds on DIFFERENT days by date alone — no tee time appended", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann G" } });
    const day1At = Date.UTC(2025, 6, 12, 12, 0);
    const day2At = Date.UTC(2025, 6, 13, 12, 0);
    mockedGetMyLiveRounds.mockResolvedValue({
      rounds: [
        { roundId: roundId("walker-day1"), courseName: "Walker", joinedAt: 5_000, createdAt: day1At },
        { roundId: roundId("walker-day2"), courseName: "Walker", joinedAt: 6_000, createdAt: day2At },
      ],
    });

    renderHome();

    // Different days → distinguished by date alone, no tee time (roundLabel with no withTime).
    const day1 = await screen.findByRole("link", { name: roundLabel({ courseName: "Walker", createdAt: day1At }) });
    const day2 = screen.getByRole("link", { name: roundLabel({ courseName: "Walker", createdAt: day2At }) });
    expect(day1.getAttribute("href")).toBe("/round/walker-day1");
    expect(day2.getAttribute("href")).toBe("/round/walker-day2");
    expect(day1.textContent).not.toBe(day2.textContent);
  });

  it("signed in with a golfer but no live rounds: shows the empty state, never falling back to the device credential list", async () => {
    credentialStore.save(roundId("device-round"), { token: "t1", golferId: golferId("ann"), name: "Device Round", joinCode: "AAA111" });
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetMyLiveRounds.mockResolvedValue({ rounds: [] });

    renderHome();

    // Exact string, not the substring-matching /no rounds yet/i regex: the Recent rounds
    // section below (Task 5) has its OWN "No rounds yet." (with a period) which would otherwise
    // multi-match the same query.
    expect(await screen.findByText("No rounds yet")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Device Round" })).toBeNull();
  });

  it("signed in but no golfer row yet: shows the sign-in CTA, never the device credential list, and never calls GET /me/rounds/live", async () => {
    credentialStore.save(roundId("device-round"), { token: "t1", golferId: golferId("ann"), name: "Device Round", joinCode: "AAA111" });
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: null });

    renderHome();

    expect(await screen.findByText("Sign in to see your rounds.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Device Round" })).toBeNull();
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
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetMyLiveRounds.mockResolvedValue({ rounds: [{ roundId: roundId("live-1"), courseName: "Casa Verde GC", joinedAt: 5_000 }] });
    mockedMintParticipantToken.mockResolvedValue({ roundId: roundId("live-1"), token: "fresh-token", golferId: golferId("ann-g"), joinCode: "FRESH1" });

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
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann G" } });
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
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann G" } });
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
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetMyLiveRounds.mockResolvedValue({ rounds: [{ roundId: roundId("live-1"), courseName: "Casa Verde GC", joinedAt: 5_000 }] });
    mockedMintParticipantToken.mockRejectedValue(new ApiError("round-final", 409, "round live-1 is finalized"));

    renderHome();
    const link = await screen.findByRole("link", { name: /casa verde gc/i });
    expect(link).toBeTruthy(); // precondition: row exists before click

    fireEvent.click(link);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/this round has finished/i);
    expect(screen.queryByText(/is finalized/i)).toBeNull();
    // Archive link is present with the correct href — the round's own permanent address
    // (navigation Task 5), not the old /archive suffix.
    const archiveLink = screen.getByRole("link", { name: /view archived round/i });
    expect(archiveLink.getAttribute("href")).toBe(`/rounds/live-1`);
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

    resolveGetMe({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann G" } });

    const link = await screen.findByRole("link", { name: /casa verde gc/i });
    expect(link.getAttribute("href")).toBe("/round/live-1");
    expect(screen.queryByRole("status", { name: /loading your rounds/i })).toBeNull();
    expect(screen.queryByRole("link", { name: "Device Round" })).toBeNull();
  });

  it("once the deferred GET /me resolves to no golfer row, the loading placeholder gives way to the sign-in CTA", async () => {
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

    expect(await screen.findByText("Sign in to see your rounds.")).toBeTruthy();
    expect(screen.queryByRole("status", { name: /loading your rounds/i })).toBeNull();
    expect(screen.queryByRole("link", { name: "Device Round" })).toBeNull();
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
    await screen.findByText("Sign in to see your rounds."); // let the signed-in render settle

    expect(queryAnyCrewText()).toBe(false);
  });

  it("signed in with a real account golfer: no crews section anywhere on the page", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetMyLiveRounds.mockResolvedValue({ rounds: [] });

    renderHome();
    await screen.findByText("No rounds yet"); // let the signed-in render settle (exact — the
    // Recent rounds section below has its own "No rounds yet." with a period)

    expect(queryAnyCrewText()).toBe(false);
  });
});

// Navigation Task 5 (spec §4b): home becomes the switchboard — a "Recent rounds" section reusing
// the SAME history-row component ProfilePage/GolferPage use (RecordSections' extracted
// HistoryList — no second vs-par/score composition here), capped to 3, plus a quiet pointer to
// the full record; the redundant body h1 "swng" is gone.
describe("HomePage — the switchboard (Task 5)", () => {
  const historyLine = (suffix: string, finalizedAt: number) => ({
    roundId: roundId(`recent-${suffix}`),
    courseName: "Pebble Beach",
    tee: "white",
    holes: 18 as const,
    par: 72,
    courseHandicap: 8,
    ags: 82,
    differential: 9.2,
    distribution: { eagles: 0, birdies: 1, pars: 10, bogeys: 6, doublePlus: 1 },
    finalizedAt,
  });

  it("recent rounds render via the SAME history row, capped to 3 and linking the round's permanent address (never /archive), plus a pointer to your profile", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetMyLiveRounds.mockResolvedValue({ rounds: [] });
    mockedGetMyRounds.mockResolvedValue({
      rounds: [historyLine("1", 4_000), historyLine("2", 3_000), historyLine("3", 2_000), historyLine("4", 1_000)],
    });

    renderHome();

    const rows = await screen.findAllByRole("link", { name: /white/ });
    expect(rows).toHaveLength(3); // capped to the first 3, newest-first per the wire contract
    const hrefs = rows.map((row) => row.getAttribute("href"));
    expect(hrefs).toEqual(["/rounds/recent-1", "/rounds/recent-2", "/rounds/recent-3"]);
    expect(hrefs.some((href) => href?.includes("/archive"))).toBe(false);
    expect(hrefs).not.toContain("/rounds/recent-4"); // the 4th (oldest) round is truncated

    const pointer = screen.getByRole("link", { name: /all rounds.*your profile/i });
    expect(pointer.getAttribute("href")).toBe("/profile");
  });

  it("no finalized rounds yet: the Recent rounds section still renders 'No rounds yet.' via the shared row component", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetMyLiveRounds.mockResolvedValue({ rounds: [] });
    mockedGetMyRounds.mockResolvedValue({ rounds: [] });

    renderHome();

    await screen.findByText("Recent rounds");
    expect(screen.getByText("No rounds yet.")).toBeTruthy();
  });

  it("removes the redundant body h1 'swng' under the header wordmark (recorded papercut)", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: golferId("ann-g"), name: "Ann G" } });
    mockedGetMyLiveRounds.mockResolvedValue({ rounds: [] });
    mockedGetMyRounds.mockResolvedValue({ rounds: [] });

    renderHome();

    await screen.findByText("No rounds yet"); // let the signed-in render settle (exact)
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});
