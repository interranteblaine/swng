import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { golferId, roundId } from "@swng/domain";
import { credentialStore } from "../identity";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary, same idiom as CreateRoundPage.test.tsx — JoinRoundPage
// only ever calls joinRound.
vi.mock("../api", () => ({
  joinRound: vi.fn(),
}));

import { joinRound } from "../api";
import { JoinRoundPage } from "./JoinRoundPage";

const mockedJoinRound = vi.mocked(joinRound);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  mockedJoinRound.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
});
