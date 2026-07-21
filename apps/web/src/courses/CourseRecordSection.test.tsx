import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courseId, golferId, roundId } from "@swng/domain";
import type { GetMyCourseRecordResponse } from "@swng/contracts";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary (established idiom) — CourseRecordSection reaches useAuth
// (which calls getMe) and its own fetch through the SAME "../api" module boundary.
vi.mock("../api", () => ({
  getMe: vi.fn(),
  getMyCourseRecord: vi.fn(),
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

import { getMe, getMyCourseRecord } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { CourseRecordSection } from "./CourseRecordSection";

const mockedGetMe = vi.mocked(getMe);
const mockedGetMyCourseRecord = vi.mocked(getMyCourseRecord);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
  mockedGetMe.mockReset();
  mockedGetMyCourseRecord.mockReset();
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

const COURSE = courseId("course-1");

const renderSection = () =>
  render(
    <AuthProvider>
      <MemoryRouter>
        <CourseRecordSection courseId={COURSE} />
      </MemoryRouter>
    </AuthProvider>,
  );

describe("CourseRecordSection", () => {
  it("renders nothing signed-out — never even calls getMyCourseRecord", async () => {
    renderSection();

    // Let any effect queue flush before asserting a negative.
    await Promise.resolve();
    expect(screen.queryByRole("heading", { name: "Your record here" })).toBeNull();
    expect(mockedGetMyCourseRecord).not.toHaveBeenCalled();
  });

  it("renders nothing at zero rounds — the record 'shows from the 1st round'", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann", indexSource: { kind: "swng" } } });
    mockedGetMyCourseRecord.mockResolvedValue({ courseId: COURSE, rounds: 0 });

    renderSection();

    await vi.waitFor(() => expect(mockedGetMyCourseRecord).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: "Your record here" })).toBeNull();
  });

  it("below 5 rounds: shows the stat lines and the gate copy, not the hole insights", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann", indexSource: { kind: "swng" } } });
    const record: GetMyCourseRecordResponse = {
      courseId: COURSE,
      rounds: 3,
      best: { roundId: roundId("round-1"), gross: 84, toPar: 12 },
      scoringAverage: 87.3,
    };
    mockedGetMyCourseRecord.mockResolvedValue(record);

    renderSection();

    expect(await screen.findByRole("heading", { name: "Your record here" })).toBeTruthy();
    expect(screen.getByText("Rounds played — 3")).toBeTruthy();
    const bestLink = screen.getByRole("link", { name: "84 (+12)" });
    expect(bestLink.getAttribute("href")).toBe("/rounds/round-1");
    expect(screen.getByText("Scoring average — 87.3")).toBeTruthy();

    expect(screen.getByText("Your course record builds at 5 rounds here — you've played 3.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "The holes, by name" })).toBeNull();
  });

  it("at 5+ rounds: renders the hole insights via the domain phrase formatters", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann", indexSource: { kind: "swng" } } });
    const record: GetMyCourseRecordResponse = {
      courseId: COURSE,
      rounds: 5,
      best: { roundId: roundId("round-9"), gross: 79, toPar: 7 },
      scoringAverage: 84.0,
      insights: {
        worstHole: { hole: 12, par: 4, plays: 5, avgOverPar: 1.4, doublePlus: 2 },
        scoringHole: { hole: 4, par: 3, plays: 5, parOrBetter: 4 },
        neverBirdied: [7, 12],
      },
    };
    mockedGetMyCourseRecord.mockResolvedValue(record);

    renderSection();

    expect(await screen.findByRole("heading", { name: "The holes, by name" })).toBeTruthy();
    expect(screen.getByText("Hole 12 gets you — +1.4 a round; you’ve doubled it 2 times in 5 plays.")).toBeTruthy();
    expect(screen.getByText("Hole 4 is your scoring hole — par or better in 4 of 5.")).toBeTruthy();
    expect(screen.getByText("You’ve never birdied 7, 12.")).toBeTruthy();
    expect(screen.queryByText(/builds at 5 rounds here/)).toBeNull();
  });

  it("a fetch failure renders the honest fallback line, never raw error text", async () => {
    signIn();
    mockedGetMe.mockResolvedValue({ golfer: { golferId: golferId("ann-g"), name: "Ann", indexSource: { kind: "swng" } } });
    mockedGetMyCourseRecord.mockRejectedValue(new Error("network down"));

    renderSection();

    expect(await screen.findByText("Could not load your record here — try again.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/network down/);
  });
});
