import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crewId, golferId } from "@swng/domain";
import type { CrewRecordsResponse } from "@swng/contracts";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary (SeasonPanel.test.tsx's own established idiom) —
// CrewRecordsSection owns its own fetching (useAuth's withAuth), same shape.
vi.mock("../api", () => ({
  getCrewRecords: vi.fn(),
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

import { getCrewRecords, getMe } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { CrewRecordsSection } from "./CrewRecordsSection";

const mockedGetCrewRecords = vi.mocked(getCrewRecords);
const mockedGetMe = vi.mocked(getMe);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  mockedGetCrewRecords.mockReset();
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

const signIn = (): void => {
  const idToken = `${base64url({ alg: "none" })}.${base64url({ sub: "sub-1", email: "ann@example.com" })}.sig`;
  tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 3_600_000 });
};

const ANN = golferId("ann-g");
const BO = golferId("bo-g");
const CREW = crewId("crew-1");

const renderSection = () =>
  render(
    <AuthProvider>
      <MemoryRouter>
        <CrewRecordsSection crewId={CREW} />
      </MemoryRouter>
    </AuthProvider>,
  );

describe("CrewRecordsSection", () => {
  it("renders nothing while loading", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetCrewRecords.mockImplementation(() => new Promise(() => {})); // never resolves

    renderSection();

    await Promise.resolve();
    expect(screen.queryByRole("heading", { name: "All-time" })).toBeNull();
  });

  it("renders titles and head-to-head from a fixture", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    const records: CrewRecordsResponse = {
      rounds: 24,
      ledger: [
        { golferId: ANN, rounds: 12, wins: 7, losses: 4, halves: 1, points: 240, skins: 8, name: "Ann" },
        { golferId: BO, rounds: 12, wins: 4, losses: 7, halves: 1, points: 200, skins: 5, name: "Bo" },
      ],
      headToHead: [{ a: ANN, b: BO, aWins: 7, bWins: 4, halves: 1 }],
      partners: [{ a: ANN, b: BO, nameA: "Ann", nameB: "Bo", wins: 9, losses: 2, halves: 0 }],
      titles: [
        { seasonId: "s-2024", name: "2024", golfers: [{ golferId: BO, name: "Bo" }] },
        // Season names are FREE TEXT (docs/architecture.md's own examples include "Summer
        // Cup"; the crewSeason e2e fixture season is "The Golden Dozen") — pinning both the
        // year-name shape and a free-text shape from the SAME fixture proves the fallback.
        { seasonId: "s-dozen", name: "The Golden Dozen", golfers: [{ golferId: ANN, name: "Ann" }] },
        // The collision case a looser "ends in two digits" regex gets wrong: the name is NOT a
        // year, it merely ends in one — the '{yy} form must not fire (whole-branch review,
        // 2026-07-21, Finding 2).
        { seasonId: "s-summer-2025", name: "Summer Cup 2025", golfers: [{ golferId: BO, name: "Bo" }] },
      ],
    };
    mockedGetCrewRecords.mockResolvedValue(records);

    renderSection();

    expect(await screen.findByRole("heading", { name: "All-time" })).toBeTruthy();

    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0]!.textContent)).toEqual([expect.stringContaining("Ann"), expect.stringContaining("Bo")]);

    const h2hList = screen.getByRole("list", { name: "Head to head" });
    expect(within(h2hList).getByRole("listitem").textContent).toBe("Ann leads Bo 7–4 · 1 halved");

    expect(screen.getByText("Ann & Bo — 9–2")).toBeTruthy();

    // "2024" IS a year -> the "'{yy}" convention; "The Golden Dozen" isn't a year at all -> the
    // season's own name renders verbatim; "Summer Cup 2025" merely ENDS in a year (not IS one)
    // -> verbatim too, the collision case a looser "ends in two digits" regex would get wrong.
    expect(screen.getByText("Stableford titles — Bo '24 · Ann — The Golden Dozen · Bo — Summer Cup 2025")).toBeTruthy();
  });

  it("no rounds counted ever: the table shows the honest empty state, not a blank table", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetCrewRecords.mockResolvedValue({ rounds: 0, ledger: [], headToHead: [], partners: [], titles: [] });

    renderSection();

    expect(await screen.findByText("No rounds counted yet.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Head to head" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Partners — four-ball" })).toBeNull();
    expect(screen.queryByText(/Stableford titles/)).toBeNull();
  });

  it("rounds counted exist but the ledger is empty (no current members): distinct copy from 'never counted'", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetCrewRecords.mockResolvedValue({ rounds: 4, ledger: [], headToHead: [], partners: [], titles: [] });

    renderSection();

    expect(await screen.findByText("No current members appear in these counted rounds.")).toBeTruthy();
    expect(screen.queryByText("No rounds counted yet.")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("a fetch failure renders the honest fallback line, never raw error text", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { indexSource: { kind: "swng" }, golferId: ANN, name: "Ann" } });
    mockedGetCrewRecords.mockRejectedValue(new Error("network down"));

    renderSection();

    expect(await screen.findByText("Records aren't available right now.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/network down/);
  });
});
