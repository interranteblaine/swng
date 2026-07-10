import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { golferId, roundId } from "@swng/domain";
import { credentialStore } from "../identity";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary, same idiom as CreateRoundPage.test.tsx — JoinRoundPage
// calls joinRound and (M6 Task 5) peekRound. peekRound defaults to a rejection so a test that
// never explicitly stubs it exercises the same free-text fallback the page always had.
vi.mock("../api", () => ({
  joinRound: vi.fn(),
  peekRound: vi.fn().mockRejectedValue(new Error("not stubbed")),
}));

import { joinRound, peekRound } from "../api";
import { JoinRoundPage } from "./JoinRoundPage";

const mockedJoinRound = vi.mocked(joinRound);
const mockedPeekRound = vi.mocked(peekRound);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  mockedJoinRound.mockReset();
  mockedPeekRound.mockReset();
  mockedPeekRound.mockRejectedValue(new Error("not stubbed"));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const renderJoin = () =>
  render(
    <MemoryRouter initialEntries={["/join"]}>
      <Routes>
        <Route path="/join" element={<JoinRoundPage />} />
        <Route path="/round/:roundId" element={<div>round view</div>} />
      </Routes>
    </MemoryRouter>,
  );

describe("JoinRoundPage", () => {
  it("uppercases a lowercase-typed code before sending it", async () => {
    mockedJoinRound.mockResolvedValue({ roundId: roundId("round-1"), token: "tok-1", golferId: golferId("bo") });

    renderJoin();

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "abc123" } });
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Bo" } });
    fireEvent.change(screen.getByLabelText(/^tee$/i), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /join round/i }));

    await waitFor(() => expect(mockedJoinRound).toHaveBeenCalledTimes(1));
    expect(mockedJoinRound).toHaveBeenCalledWith({ code: "ABC123", name: "Bo", tee: "white", courseHandicap: 2 });
  });

  it("saves the credential (with the code the golfer typed — joinRound's response carries none) and navigates to the round", async () => {
    mockedJoinRound.mockResolvedValue({ roundId: roundId("round-2"), token: "tok-2", golferId: golferId("cal") });

    renderJoin();

    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "def456" } });
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Cal" } });
    fireEvent.change(screen.getByLabelText(/^tee$/i), { target: { value: "blue" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "14" } });
    fireEvent.click(screen.getByRole("button", { name: /join round/i }));

    await waitFor(() => expect(screen.getByText("round view")).toBeTruthy());
    expect(credentialStore.load(roundId("round-2"))).toEqual({ token: "tok-2", golferId: golferId("cal"), name: "Cal", joinCode: "DEF456" });
  });

  it("once the code is 6 chars, debounces a peek that swaps the free-text tee for a picker of the round's tee names", async () => {
    vi.useFakeTimers();
    mockedPeekRound.mockResolvedValue({ courseName: "Fixture Links 18", teeSets: [{ name: "white", rating: 71.6, slope: 128 }, { name: "blue", rating: 74.0, slope: 140 }] });

    renderJoin();
    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "abc123" } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(mockedPeekRound).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockedPeekRound).toHaveBeenCalledWith("ABC123");
    expect(screen.getByText(/joining fixture links 18/i)).toBeTruthy();

    const select = screen.getByLabelText(/^tee$/i) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["white", "blue"]);
  });

  it("a failed peek falls back to free text with a note — joining is never blocked by it", async () => {
    vi.useFakeTimers();
    mockedPeekRound.mockRejectedValue(new Error("no round with that code"));
    mockedJoinRound.mockResolvedValue({ roundId: roundId("round-3"), token: "tok-3", golferId: golferId("dee") });

    renderJoin();
    fireEvent.change(screen.getByLabelText(/code/i), { target: { value: "zzz999" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    // Still a free-text input, not a picker — and a note explains why.
    const teeField = screen.getByLabelText(/^tee$/i);
    expect(teeField.tagName).toBe("INPUT");
    expect(screen.getByText(/could not look up/i)).toBeTruthy();
    vi.useRealTimers(); // nothing past this point depends on the debounce — waitFor below needs real timers to poll

    // And joining still works from that free-text field.
    fireEvent.change(teeField, { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Dee" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /join round/i }));

    await waitFor(() => expect(mockedJoinRound).toHaveBeenCalledWith({ code: "ZZZ999", name: "Dee", tee: "white", courseHandicap: 5 }));
  });
});
