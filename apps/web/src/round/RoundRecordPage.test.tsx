import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceId, fixtureLinks, golferId, opId, roundId } from "@swng/domain";
import type { OpId, RoundEvent } from "@swng/domain";
import { ArchiveRedirect } from "../App";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { credentialStore } from "../identity";
import { roundLabel } from "../roundLabel";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { RoundRecordPage } from "./RoundRecordPage";

const fakeResponse = (status: number, body: unknown): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const ROUND_ID = roundId("archived-round-1");
const ANN_ID = golferId("ann");
const BO_ID = golferId("bo");
const SERVER_DEVICE = deviceId("server");

// Mirrors watch/WatchPage.test.tsx's own buildFinalLog — a small, real, finalized round log
// (genesis through round-finalized), the exact shape GET /rounds/{roundId}/archive hands back.
const buildFinalLog = (): RoundEvent[] => {
  let wallMs = 1_000;
  const nextHlc = () => ({ wallMs: wallMs++, counter: 0, deviceId: SERVER_DEVICE });
  let opCounter = 0;
  const nextOpId = (): OpId => opId(`server-op-${(opCounter += 1)}`);
  return [
    { kind: "round-created", roundId: ROUND_ID, card: fixtureLinks, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "participant-joined", participant: { golferId: ANN_ID, name: "Ann", tee: "white", courseHandicap: 8 }, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "participant-joined", participant: { golferId: BO_ID, name: "Bo", tee: "white", courseHandicap: 2 }, authorId: BO_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "round-started", authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "score-recorded", golferId: ANN_ID, hole: 1, result: { kind: "strokes", strokes: 4 }, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "round-finalized", authorId: ANN_ID, opId: opId("op-finalize"), hlc: { wallMs: 9_000, counter: 0, deviceId: SERVER_DEVICE } },
  ];
};

// Same bare, unverified-signature idiom as ProfilePage.test.tsx's own signIn — the point here
// is only to give useAuth's withAuth a token to attach, never real Cognito verification.
const signIn = (): string => {
  const base64url = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const idToken = `${base64url({ alg: "none" })}.${base64url({ sub: "sub-ann", email: "ann@example.com" })}.sig`;
  tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 3_600_000 });
  return idToken;
};

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderRoundRecordPage = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/rounds/:roundId" element={<RoundRecordPage />} />
          <Route path="/round/:roundId" element={<div>round page probe</div>} />
          <Route path="/join" element={<div>join page probe</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );

describe("RoundRecordPage — archived (the old ArchivedRoundPage content, absorbed)", () => {
  it("loads via the golfer Bearer, folds the archive's events (the domain reduceRound, mirroring WatchPage's own composition), and renders ResultsView with the canonical course + date header", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        // AuthProvider's own once-per-session GET /me (useAuth.ts) — fires on sign-in,
        // unrelated to this page, but must be answered or the stub throws.
        if (path === "/me") return fakeResponse(200, { golfer: null });
        if (path === `/rounds/${ROUND_ID}/archive`) {
          expect((init?.headers as Record<string, string>).authorization).toBe("Bearer " + tokenStore.load()?.idToken);
          return fakeResponse(200, { events: buildFinalLog() });
        }
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderRoundRecordPage(`/rounds/${ROUND_ID}`);

    expect(screen.getByRole("status", { name: "Loading round" })).toBeTruthy();

    await waitFor(() => expect(screen.getByText("Final results")).toBeTruthy());
    // The canonical designation (spec §5): fixtureLinks' courseName plus the round-CREATED event's
    // own wallMs (1_000ms since epoch — the round's created-at, not the finalize time), rendered
    // the one way roundLabel renders it everywhere.
    expect(screen.getByText(roundLabel({ courseName: "Fixture Links", createdAt: 1_000 }))).toBeTruthy();
    // Nav infrastructure Task 2: usePageTitle re-runs once the archive loads — the same
    // canonical designation the page's own header renders.
    expect(document.title).toBe(`${roundLabel({ courseName: "Fixture Links", createdAt: 1_000 })} · swng`);

    // Ann's roster row and hole-1 score render from the real fold (a genuine ResultsView, not
    // a stub) — same disabled-cell assertion WatchPage.test.tsx's own archived-card case pins.
    expect(screen.getAllByText("Ann").length).toBeGreaterThan(0); // roster row + scorecard column header
    const cell = screen.getByRole("button", { name: "Ann hole 1" });
    expect(cell.hasAttribute("disabled")).toBe(true);
  });

  // Read-only, no session/outbox/edit affordances (the brief's own contract) — structurally,
  // the same "every button is either disabled or a game-select tab" proof WatchPage.test.tsx's
  // own live-log case uses for its archived-card reuse.
  it("renders NO edit affordances — no Finalize/Add/End buttons, no Share button (this page holds no participant token)", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: null });
        if (path === `/rounds/${ROUND_ID}/archive`) return fakeResponse(200, { events: buildFinalLog() });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderRoundRecordPage(`/rounds/${ROUND_ID}`);
    await waitFor(() => expect(screen.getByText("Final results")).toBeTruthy());

    const buttons = screen.getAllByRole("button");
    for (const button of buttons) {
      const isGameTab = button.getAttribute("role") === "tab";
      expect(isGameTab || button.hasAttribute("disabled")).toBe(true);
    }
    expect(screen.queryByRole("button", { name: "Share round" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Finalize round/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Add /i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^End /i })).toBeNull();
  });
});

// Navigation spec §7: the address resolves by state — an archive read failure is never the end
// of the story on its own, since the round might simply still be live.
describe("RoundRecordPage — resolution when the archive read fails (navigation spec §7)", () => {
  it("non-200 archive fetch + the round IS in the caller's live rounds: re-mints via openLiveRound and navigates to /round/{id}", async () => {
    const idToken = signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        const method = init?.method ?? "GET";
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann", indexSource: { kind: "swng" } } });
        if (path === `/rounds/${ROUND_ID}/archive`) {
          return { ok: false, status: 404, json: async () => ({ code: "round-not-found", message: "no snapshot for round archived-round-1" }) } as unknown as Response;
        }
        if (path === "/me/rounds/live") return fakeResponse(200, { rounds: [{ roundId: ROUND_ID, courseName: "Fixture Links", joinedAt: 1_000 }] });
        if (path === `/rounds/${ROUND_ID}/token` && method === "POST") {
          expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${idToken}`);
          return fakeResponse(200, { roundId: ROUND_ID, token: "fresh-token", golferId: ANN_ID });
        }
        throw new Error(`unexpected fetch ${path} ${method}`);
      }),
    );

    renderRoundRecordPage(`/rounds/${ROUND_ID}`);

    await waitFor(() => expect(screen.getByText("round page probe")).toBeTruthy());
    // The SAME credential shape a real join/re-mint stores (openLiveRound.ts) — name from the
    // caller's own account golfer, joinCode "" (no code known outside the join flow).
    expect(credentialStore.load(ROUND_ID)).toEqual({ token: "fresh-token", golferId: ANN_ID, name: "Ann", joinCode: "" });
  });

  it("non-200 archive fetch + NOT in the caller's live rounds: the honest fallback, with a join-here link to /join", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: null });
        if (path === `/rounds/${ROUND_ID}/archive`) {
          return { ok: false, status: 404, json: async () => ({ code: "round-not-found", message: "no snapshot for round archived-round-1" }) } as unknown as Response;
        }
        if (path === "/me/rounds/live") return fakeResponse(200, { rounds: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderRoundRecordPage(`/rounds/${ROUND_ID}`);

    await waitFor(() => expect(screen.getByText(/this round isn.t available/i)).toBeTruthy());
    // Never the raw server text (the old ArchivedRoundPage's own discipline, carried forward).
    expect(document.body.textContent).not.toMatch(/no snapshot for round/);
    expect(screen.queryByText("Final results")).toBeNull();
    const joinLink = screen.getByRole("link", { name: /join here/i });
    expect(joinLink.getAttribute("href")).toBe("/join");
  });

  it("signed out: shows the SignInCta funnel, returnTo the current round address", () => {
    renderRoundRecordPage(`/rounds/${ROUND_ID}`);

    expect(screen.getByText(/sign in to see this round/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    // No fetch at all while signed out — the effect only runs once `signedIn` is true (spec §7).
  });
});

describe("RoundRecordPage — the old /rounds/:roundId/archive address redirects (navigation spec §7)", () => {
  it("rendering the app at /rounds/x/archive lands on /rounds/x", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/me") return fakeResponse(200, { golfer: null });
        if (path === "/rounds/x/archive") return { ok: false, status: 404, json: async () => ({ code: "round-not-found", message: "no snapshot" }) } as unknown as Response;
        if (path === "/me/rounds/live") return fakeResponse(200, { rounds: [] });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    render(
      <MemoryRouter initialEntries={["/rounds/x/archive"]}>
        <AuthProvider>
          <Routes>
            <Route path="/rounds/:roundId" element={<RoundRecordPage />} />
            <Route path="/rounds/:roundId/archive" element={<ArchiveRedirect />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    // Proof the redirect actually landed on /rounds/x (not merely that the archive route's own
    // element never renders): RoundRecordPage's effect ran for id "x" — the honest-fallback copy
    // only appears once its GET /rounds/x/archive + GET /me/rounds/live round trip (stubbed
    // above, keyed to "x") completes.
    await waitFor(() => expect(screen.getByText(/this round isn.t available/i)).toBeTruthy());
  });
});
