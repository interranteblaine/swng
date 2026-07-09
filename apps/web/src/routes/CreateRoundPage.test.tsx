import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureLinks18, golferId, roundId } from "@swng/domain";
import { startRoundRequestSchema } from "@swng/contracts";
import { credentialStore } from "../identity";
import { createMemoryStorage } from "../testSupport/memoryStorage";

// Faking the api.ts module boundary (Task 3's own idiom for exercising the seam without a
// real fetch) — CreateRoundPage only ever calls createRound, so that's the only export this
// mock needs to supply.
vi.mock("../api", () => ({
  createRound: vi.fn(),
}));

import { createRound } from "../api";
import { CreateRoundPage } from "./CreateRoundPage";

const mockedCreateRound = vi.mocked(createRound);

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  mockedCreateRound.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderCreate = () =>
  render(
    <MemoryRouter initialEntries={["/create"]}>
      <Routes>
        <Route path="/create" element={<CreateRoundPage />} />
        <Route path="/round/:roundId" element={<div>round view</div>} />
      </Routes>
    </MemoryRouter>,
  );

describe("CreateRoundPage", () => {
  it("sends the exact startRoundRequestSchema body for fixtureLinks18 white tees, saves the credential, and navigates to the round", async () => {
    mockedCreateRound.mockResolvedValue({ roundId: roundId("round-9"), joinCode: "ZZZ999", token: "tok-9", golferId: golferId("ann") });

    renderCreate();

    fireEvent.change(screen.getByLabelText(/^course$/i), { target: { value: fixtureLinks18.courseName } });
    fireEvent.change(screen.getByLabelText(/^tee$/i), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Ann" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: /create round/i }));

    await waitFor(() => expect(mockedCreateRound).toHaveBeenCalledTimes(1));

    const body = mockedCreateRound.mock.calls[0]![0];
    expect(body).toEqual({ card: fixtureLinks18, host: { name: "Ann", tee: "white", courseHandicap: 8 } });
    expect(() => startRoundRequestSchema.parse(body)).not.toThrow(); // exact wire shape, not just a loose superset

    await waitFor(() => expect(screen.getByText("round view")).toBeTruthy());
    expect(credentialStore.load(roundId("round-9"))).toEqual({ token: "tok-9", golferId: golferId("ann"), name: "Ann", joinCode: "ZZZ999" });
  });

  it("accepts a negative (plus) course handicap", async () => {
    mockedCreateRound.mockResolvedValue({ roundId: roundId("round-10"), joinCode: "AAA000", token: "tok-10", golferId: golferId("bo") });

    renderCreate();

    fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: "Bo" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "-3" } });
    fireEvent.click(screen.getByRole("button", { name: /create round/i }));

    await waitFor(() => expect(mockedCreateRound).toHaveBeenCalledTimes(1));
    const body = mockedCreateRound.mock.calls[0]![0];
    expect(body.host.courseHandicap).toBe(-3);
  });
});
