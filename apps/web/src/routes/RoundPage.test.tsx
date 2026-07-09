import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryOutboxStore } from "@swng/client";
import { deviceId, fixtureLinks, golferId, opId, roundId } from "@swng/domain";
import type { GolferId, OpId, RoundEvent, RoundId } from "@swng/domain";
import { credentialStore } from "../identity";
import { createUseRoundSession } from "../session/useRoundSession";
import type { ResolveSessionConfig } from "../session/useRoundSession";
import { createScriptedTransport, stampSeq } from "../testSupport/scriptedTransport";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { createRoundPage } from "./RoundPage";

const SERVER_DEVICE = deviceId("server");

// One live round's worth of server log — creation + a join + start, no games. Local to this
// file (server-log scenarios are per-spec, per testSupport/scriptedTransport's own
// documentation; only the transport plumbing itself is shared).
const buildServerLog = (roundIdValue: RoundId, golferIdValue: GolferId, name: string): RoundEvent[] => {
  let wallMs = 1_000;
  const nextHlc = () => ({ wallMs: wallMs++, counter: 0, deviceId: SERVER_DEVICE });
  let opCounter = 0;
  const nextOpId = (): OpId => opId(`server-op-${(opCounter += 1)}`);
  const events: RoundEvent[] = [
    { kind: "round-created", roundId: roundIdValue, card: fixtureLinks, authorId: golferIdValue, opId: nextOpId(), hlc: nextHlc() },
    { kind: "participant-joined", participant: { golferId: golferIdValue, name, tee: "white", courseHandicap: 8 }, authorId: golferIdValue, opId: nextOpId(), hlc: nextHlc() },
    { kind: "round-started", authorId: golferIdValue, opId: nextOpId(), hlc: nextHlc() },
  ];
  return stampSeq(events);
};

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RoundPage", () => {
  it("redirects to /join when there's no saved credential for this round", async () => {
    // Real (default-bound) RoundPage: with no credential, RoundPageContent — the only place
    // that calls useRoundSession — is never rendered, so no scripted transport is needed.
    const { RoundPage } = await import("./RoundPage");

    render(
      <MemoryRouter initialEntries={[`/round/${roundId("round-1")}`]}>
        <Routes>
          <Route path="/round/:roundId" element={<RoundPage />} />
          <Route path="/join" element={<div>join page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("join page")).toBeTruthy());
  });

  it("shows a skeleton while hydrating, then the SetupPanel once hydrated", async () => {
    const id = roundId("round-2");
    const golfer = golferId("ann");
    credentialStore.save(id, { token: "tok-1", golferId: golfer, name: "Ann", joinCode: "ABC123" });

    const transport = createScriptedTransport(buildServerLog(id, golfer, "Ann"));
    const resolveSessionConfig: ResolveSessionConfig = () => ({
      transport,
      store: createMemoryOutboxStore(),
      roundId: id,
      golferId: golfer,
      deviceId: deviceId("ann-tab"),
    });
    const RoundPageUnderTest = createRoundPage(createUseRoundSession(resolveSessionConfig));

    render(
      <MemoryRouter initialEntries={[`/round/${id}`]}>
        <Routes>
          <Route path="/round/:roundId" element={<RoundPageUnderTest />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("status")).toBeTruthy(); // skeleton, before hydration

    await waitFor(() => expect(screen.getByText("ABC123")).toBeTruthy()); // SetupPanel's join code banner
    expect(screen.queryByRole("status")).toBeNull();
    // "Ann" alone is ambiguous (also a checkbox label in the Add Game form's players list) —
    // the roster line's fuller text disambiguates.
    expect(screen.getByText(/Ann.*white.*CH 8/)).toBeTruthy();
  });

  it("remounts the session (keyed by the route's roundId) when navigating from one round to another", async () => {
    const roundA = roundId("round-a");
    const roundB = roundId("round-b");
    const ann = golferId("ann");
    const bo = golferId("bo");
    credentialStore.save(roundA, { token: "tok-a", golferId: ann, name: "Ann", joinCode: "AAA111" });
    credentialStore.save(roundB, { token: "tok-b", golferId: bo, name: "Bo", joinCode: "BBB222" });

    const transportA = createScriptedTransport(buildServerLog(roundA, ann, "Ann"));
    const transportB = createScriptedTransport(buildServerLog(roundB, bo, "Bo"));
    const resolveSessionConfig: ResolveSessionConfig = (id) =>
      id === roundA
        ? { transport: transportA, store: createMemoryOutboxStore(), roundId: roundA, golferId: ann, deviceId: deviceId("ann-tab") }
        : { transport: transportB, store: createMemoryOutboxStore(), roundId: roundB, golferId: bo, deviceId: deviceId("bo-tab") };
    const RoundPageUnderTest = createRoundPage(createUseRoundSession(resolveSessionConfig));

    const router = createMemoryRouter([{ path: "/round/:roundId", element: <RoundPageUnderTest /> }], { initialEntries: [`/round/${roundA}`] });
    render(<RouterProvider router={router} />);

    // Join codes are unambiguous (unlike "Ann"/"Bo", which also appear as Add Game player
    // checkbox labels) — the cleanest signal that round A's own hydrated state rendered.
    await waitFor(() => expect(screen.getByText("AAA111")).toBeTruthy());
    expect(screen.queryByText("BBB222")).toBeNull();

    await act(async () => {
      await router.navigate(`/round/${roundB}`);
    });

    await waitFor(() => expect(screen.getByText("BBB222")).toBeTruthy());
    // Stale-snapshot gap (Task 3's flagged M4→M5 handoff item): without the key={roundId}
    // remount, this would still show round A's join code from the reused session instance.
    expect(screen.queryByText("AAA111")).toBeNull();
  });
});
