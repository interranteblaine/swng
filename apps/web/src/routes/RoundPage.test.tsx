import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryOutboxStore } from "@swng/client";
import { deviceId, fixtureLinks, gameId, golferId, opId, roundId } from "@swng/domain";
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

// Two participants + two games (a singles-match and a gross stroke-play) — buildServerLog
// above only ever joins ONE participant, which the standings-chip and hole-digest tests below
// both need more than one of to be meaningful (a hole can't "complete" with only one cell
// needed, and dots can't differ between games with only one player in each).
const buildTwoPlayerServerLog = (roundIdValue: RoundId, ann: GolferId, bo: GolferId): RoundEvent[] => {
  let wallMs = 2_000;
  const nextHlc = () => ({ wallMs: wallMs++, counter: 0, deviceId: SERVER_DEVICE });
  let opCounter = 0;
  const nextOpId = (): OpId => opId(`two-op-${(opCounter += 1)}`);
  const events: RoundEvent[] = [
    { kind: "round-created", roundId: roundIdValue, card: fixtureLinks, authorId: ann, opId: nextOpId(), hlc: nextHlc() },
    { kind: "participant-joined", participant: { golferId: ann, name: "Ann", tee: "white", courseHandicap: 8 }, authorId: ann, opId: nextOpId(), hlc: nextHlc() },
    { kind: "participant-joined", participant: { golferId: bo, name: "Bo", tee: "white", courseHandicap: 2 }, authorId: bo, opId: nextOpId(), hlc: nextHlc() },
    // Added in this order deliberately: state.games' join-order (by first-write hlc) makes
    // the singles-match the DEFAULT active game (Task 5's "default stays first game" rule).
    { kind: "game-added", config: { kind: "singles-match", id: gameId("single-1"), a: ann, b: bo }, authorId: ann, opId: nextOpId(), hlc: nextHlc() },
    { kind: "game-added", config: { kind: "stroke-play", id: gameId("gross-1"), scoring: "gross", players: [ann, bo] }, authorId: ann, opId: nextOpId(), hlc: nextHlc() },
    { kind: "round-started", authorId: ann, opId: nextOpId(), hlc: nextHlc() },
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

  it("scores a hole through the real ScorecardGrid + ScorePad, wired end to end through the session", async () => {
    const id = roundId("round-3");
    const golfer = golferId("ann");
    credentialStore.save(id, { token: "tok-3", golferId: golfer, name: "Ann", joinCode: "CCC333" });

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

    await waitFor(() => expect(screen.getByText("CCC333")).toBeTruthy());
    // Connected (the scripted transport's openSocket opens synchronously) — StatusChrome
    // wired to the real session renders no offline banner.
    expect(screen.queryByRole("status")).toBeNull();

    // Two taps, idle to posted: tap the cell (fixtureLinks hole 1, no games — plain gross),
    // then tap a value in the pad that opens.
    fireEvent.click(screen.getByRole("button", { name: "Ann hole 1" }));
    fireEvent.click(screen.getByRole("button", { name: "5" }));

    expect(screen.queryByRole("dialog")).toBeNull(); // posts and closes, no confirm step
    await waitFor(() => expect(screen.getByRole("button", { name: "Ann hole 1" }).textContent).toContain("5"));
  });

  it("tapping a standings chip changes which game drives the grid's dots (Task 5's fixed seam)", async () => {
    const id = roundId("round-chip");
    const ann = golferId("ann");
    const bo = golferId("bo");
    credentialStore.save(id, { token: "tok-chip", golferId: ann, name: "Ann", joinCode: "CHIP01" });

    const transport = createScriptedTransport(buildTwoPlayerServerLog(id, ann, bo));
    const resolveSessionConfig: ResolveSessionConfig = () => ({
      transport,
      store: createMemoryOutboxStore(),
      roundId: id,
      golferId: ann,
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
    await waitFor(() => expect(screen.getByText("CHIP01")).toBeTruthy());

    // Default active game is the singles-match (added first) — Ann (ch8) vs Bo (ch2) gives
    // Ann a dot on hole 1 (fixtureLinks SI 5, within her 6-dot allocation).
    const annHole1 = () => screen.getByRole("button", { name: "Ann hole 1" });
    await waitFor(() => expect(annHole1().textContent).toMatch("●"));

    // Tapping the gross stroke-play chip switches the active game — gross carries no
    // allowance at all (dots.ts's own rule), so Ann's dot disappears.
    fireEvent.click(screen.getByRole("tab", { name: /Stroke play \(gross\)/ }));
    expect(annHole1().textContent).not.toMatch("●");

    // And back — the singles-match chip is still there and still switches correctly.
    fireEvent.click(screen.getByRole("tab", { name: /Singles match/ }));
    expect(annHole1().textContent).toMatch("●");
  });

  it("completing a hole fires the between-holes digest exactly once, dismissible by tap", async () => {
    const id = roundId("round-digest");
    const ann = golferId("ann");
    const bo = golferId("bo");
    credentialStore.save(id, { token: "tok-digest", golferId: ann, name: "Ann", joinCode: "DIG001" });

    const transport = createScriptedTransport(buildTwoPlayerServerLog(id, ann, bo));
    const resolveSessionConfig: ResolveSessionConfig = () => ({
      transport,
      store: createMemoryOutboxStore(),
      roundId: id,
      golferId: ann,
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
    await waitFor(() => expect(screen.getByText("DIG001")).toBeTruthy());
    expect(screen.queryByText("After 1")).toBeNull();

    // Ann posts hole 1 alone — Bo hasn't, so hole 1 isn't complete yet: no digest.
    fireEvent.click(screen.getByRole("button", { name: "Ann hole 1" }));
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    expect(screen.queryByText("After 1")).toBeNull();

    // Bo posts hole 1 too — every participant now has a cell for it: the digest fires.
    fireEvent.click(screen.getByRole("button", { name: "Bo hole 1" }));
    fireEvent.click(screen.getByRole("button", { name: "4" }));
    await waitFor(() => expect(screen.getByText("After 1")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("After 1")).toBeNull();
  });

  it("a round that's already final (a rejoining/refreshed client) renders ResultsView directly, locked — no finalize call needed", async () => {
    const id = roundId("round-final");
    const ann = golferId("ann");
    credentialStore.save(id, { token: "tok-final", golferId: ann, name: "Ann", joinCode: "FIN001" });

    const finalized: RoundEvent = { kind: "round-finalized", authorId: ann, opId: opId("final-op"), hlc: { wallMs: 9_999, counter: 0, deviceId: SERVER_DEVICE } };
    const transport = createScriptedTransport(stampSeq([...buildServerLog(id, ann, "Ann"), finalized]));
    const resolveSessionConfig: ResolveSessionConfig = () => ({
      transport,
      store: createMemoryOutboxStore(),
      roundId: id,
      golferId: ann,
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

    await waitFor(() => expect(screen.getByText("Final results")).toBeTruthy());
    // The live scoring chrome never renders once status is already final — this tab never
    // called finalizeRound itself, so there is no response object either (brief's WS-push
    // contract: ResultsView must render fully from folded state + games() alone).
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("button", { name: "Finalize round" })).toBeNull();

    const cell = screen.getByRole("button", { name: "Ann hole 1" });
    expect(cell.hasAttribute("disabled")).toBe(true);
    fireEvent.click(cell);
    expect(screen.queryByRole("dialog")).toBeNull(); // the pad never opens on a final round
  });

  it("finalizing from this tab: confirm dialog -> POST /finalize -> ResultsView, using the response", async () => {
    const id = roundId("round-finalize-flow");
    const ann = golferId("ann");
    credentialStore.save(id, { token: "tok-flow", golferId: ann, name: "Ann", joinCode: "FLW001" });

    const transport = createScriptedTransport(buildServerLog(id, ann, "Ann"));
    const resolveSessionConfig: ResolveSessionConfig = () => ({
      transport,
      store: createMemoryOutboxStore(),
      roundId: id,
      golferId: ann,
      deviceId: deviceId("ann-tab"),
    });
    const RoundPageUnderTest = createRoundPage(createUseRoundSession(resolveSessionConfig));

    // Stands in for the real HTTP finalize endpoint: mirrors what it actually does server-side
    // (append round-finalized to the journal) directly onto the scripted transport's log, so
    // this tab's own session.sync() (called by RoundPage right after the fetch resolves) picks
    // it up the same way it would pick up a real server append.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(String(url)).toBe(`https://api.example.test/rounds/${id}/finalize`);
        expect(init?.method).toBe("POST");
        // `.log` is `readonly RoundEvent[]` on the shared ScriptedTransport type (every OTHER
        // test in this file only ever reads it) — this cast is scoped to this one push, not a
        // widening of the shared testSupport type for a single test's needs.
        (transport.log as RoundEvent[]).push({
          kind: "round-finalized",
          authorId: ann,
          opId: opId("srv-finalize"),
          hlc: { wallMs: 9_999, counter: 0, deviceId: SERVER_DEVICE },
          seq: transport.log.length + 1,
        });
        return { ok: true, status: 200, json: async () => ({ results: [], handicapping: [] }) } as unknown as Response;
      }),
    );

    render(
      <MemoryRouter initialEntries={[`/round/${id}`]}>
        <Routes>
          <Route path="/round/:roundId" element={<RoundPageUnderTest />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("FLW001")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Finalize round" }));
    expect(screen.getByRole("dialog", { name: "Confirm finalize" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Finalize" }));

    await waitFor(() => expect(screen.getByText("Final results")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Finalize round" })).toBeNull();
  });
});
