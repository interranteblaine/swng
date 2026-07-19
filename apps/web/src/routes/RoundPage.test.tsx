import type { ReactElement } from "react";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryOutboxStore } from "@swng/client";
import { deviceId, fixtureLinks, gameId, golferId, opId, roundId } from "@swng/domain";
import type { GolferId, OpId, RoundEvent, RoundId } from "@swng/domain";
import { AuthProvider } from "../auth/useAuth";
import { credentialStore } from "../identity";
import { createUseRoundSession } from "../session/useRoundSession";
import type { ResolveSessionConfig } from "../session/useRoundSession";
import { createScriptedTransport, stampSeq } from "../testSupport/scriptedTransport";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { createRoundPage } from "./RoundPage";

// RoundPage now renders under an AuthProvider in the real app (SetupPanel's claim affordance
// calls useAuth) — no tokens are ever saved in this file, so the provider stays signed out and
// makes no fetches of its own; every existing call site keeps its shape via this shadowing.
const render = (ui: ReactElement) => rtlRender(<AuthProvider>{ui}</AuthProvider>);

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
// above only ever joins ONE participant, which the standings-chip and digest-absence tests below
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
    // M9 Task 3 (share): the live view carries its own "Share round" affordance, wired to
    // THIS device's own participant token (credentialStore.save above).
    expect(screen.getByRole("button", { name: "Share round" })).toBeTruthy();
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

  // The standard card (spec 2026-07-19 §2a: the card never changes) — StandingsHeader chips
  // still switch which game's OWN panel is active, but the grid underneath is chip-independent:
  // Ann's dots come from her own course handicap (8, on fixtureLinks' SI-5 hole 1) always.
  it("tapping a standings chip does NOT change the grid's dots — the card is game-agnostic", async () => {
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

    // Ann's own course handicap (8) allocates a dot on hole 1 (fixtureLinks SI 5) regardless
    // of which game (if any) is chip-selected.
    const annHole1 = () => screen.getByRole("button", { name: "Ann hole 1" });
    await waitFor(() => expect(annHole1().textContent).toMatch("●"));

    // Tapping the gross stroke-play chip switches StandingsHeader's own selection — the grid's
    // dot is unaffected (gross carries no allowance at all, but that's THAT game's own concern
    // now, never the card's).
    fireEvent.click(screen.getByRole("tab", { name: /Stroke play \(gross\)/ }));
    expect(annHole1().textContent).toMatch("●");

    // And back — still unaffected.
    fireEvent.click(screen.getByRole("tab", { name: /Match play/ }));
    expect(annHole1().textContent).toMatch("●");
  });

  // M7 Task 6: terminated games drop out of the default active-game selection (brief) — the
  // chip itself stays (with an "ended" badge, covered in StandingsHeader's own test suite),
  // but the grid should never silently default onto a game that's stopped scoring.
  it("the default active game skips a terminated one, falling through to the next live game", async () => {
    const id = roundId("round-term-default");
    const ann = golferId("ann");
    const bo = golferId("bo");
    credentialStore.save(id, { token: "tok-term-default", golferId: ann, name: "Ann", joinCode: "TERM01" });

    // The singles-match is added first (buildTwoPlayerServerLog's own ordering) — the default
    // WITHOUT this fix — but it's terminated here, so stroke-play should become the default.
    const terminated: RoundEvent = {
      kind: "game-terminated",
      gameId: gameId("single-1"),
      authorId: ann,
      opId: opId("term-op"),
      hlc: { wallMs: 9_000, counter: 0, deviceId: SERVER_DEVICE },
    };
    const transport = createScriptedTransport(stampSeq([...buildTwoPlayerServerLog(id, ann, bo), terminated]));
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
    await waitFor(() => expect(screen.getByText("TERM01")).toBeTruthy());

    const strokeTab = screen.getByRole("tab", { name: /Stroke play \(gross\)/ });
    expect(strokeTab.getAttribute("aria-selected")).toBe("true");
    const singlesTab = screen.getByRole("tab", { name: /Match play/ });
    expect(singlesTab.getAttribute("aria-selected")).toBe("false");
  });

  // The between-holes digest is deleted (accounts-only identity spec §6) — the proof-of-negative:
  // the exact transition that used to fire it (every participant scores hole 1, completing it)
  // now surfaces NO digest push-card at all (the card that used to read "After N").
  it("completing a hole produces NO between-holes digest (deleted, spec §6)", async () => {
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

    // Ann then Bo both post hole 1 — every participant now has a cell for it, the exact
    // incomplete→complete transition that used to open the digest.
    fireEvent.click(screen.getByRole("button", { name: "Ann hole 1" }));
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    fireEvent.click(screen.getByRole("button", { name: "Bo hole 1" }));
    fireEvent.click(screen.getByRole("button", { name: "4" }));

    // Both scores landed in the fold ...
    await waitFor(() => expect(screen.getByRole("button", { name: "Bo hole 1" }).textContent).toContain("4"));
    // ... and the digest that used to open here is gone: no "After N" card (its old header text),
    // and no Dismiss affordance that only the digest ever rendered.
    expect(screen.queryByText("After 1")).toBeNull();
    expect(screen.queryByText(/^after \d/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  // accounts-only identity spec §4: the leave flow, wired end to end — "Leave round" → confirm →
  // POST /rounds/{id}/leave → navigate home. Leaving is ONE POST then navigation (no sync(), no
  // credential/presence touch), so departure is "reflected" by this tab landing back on Home; the
  // participant-left event lands server-side for everyone else's fold.
  it("leave flow: 'Leave round' → confirm → POST /leave → navigates home", async () => {
    const id = roundId("round-leave-flow");
    const ann = golferId("ann");
    credentialStore.save(id, { token: "tok-leave", golferId: ann, name: "Ann", joinCode: "LVE001" });

    const transport = createScriptedTransport(buildServerLog(id, ann, "Ann"));
    const resolveSessionConfig: ResolveSessionConfig = () => ({
      transport,
      store: createMemoryOutboxStore(),
      roundId: id,
      golferId: ann,
      deviceId: deviceId("ann-tab"),
    });
    const RoundPageUnderTest = createRoundPage(createUseRoundSession(resolveSessionConfig));

    let leaveCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(String(url)).toBe(`https://api.example.test/rounds/${id}/leave`);
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok-leave");
        leaveCalls += 1;
        const event: RoundEvent = {
          kind: "participant-left",
          golferId: ann,
          authorId: ann,
          opId: opId("srv-leave"),
          hlc: { wallMs: 9_900, counter: 0, deviceId: SERVER_DEVICE },
          seq: transport.log.length + 1,
        };
        (transport.log as RoundEvent[]).push(event);
        return { ok: true, status: 200, json: async () => ({ events: [event] }) } as unknown as Response;
      }),
    );

    render(
      <MemoryRouter initialEntries={[`/round/${id}`]}>
        <Routes>
          <Route path="/round/:roundId" element={<RoundPageUnderTest />} />
          <Route path="/" element={<div>home probe</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("LVE001")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Leave round" }));
    const dialog = screen.getByRole("dialog", { name: "Confirm leave" });
    // Copy distinct from Scrap: personal, non-destructive (rejoin framing), never "counts nowhere".
    expect(dialog.textContent).toMatch(/rejoin/i);
    expect(dialog.textContent).not.toMatch(/counts nowhere/i);

    fireEvent.click(within(dialog).getByRole("button", { name: "Leave" }));

    await waitFor(() => expect(screen.getByText("home probe")).toBeTruthy());
    expect(leaveCalls).toBe(1);
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

  // task-15: the scrap flow, wired end to end — confirm dialog → POST /rounds/{id}/abandon → the
  // round-abandoned event folds back through this tab's own sync() → the whole page swaps to the
  // honest scrapped notice (NOT ResultsView — a scrapped round has no results).
  it("scrap flow: 'Scrap this round' → confirm → POST /abandon → the scrapped notice, no scoring chrome", async () => {
    const id = roundId("round-scrap-flow");
    const ann = golferId("ann");
    credentialStore.save(id, { token: "tok-scrap", golferId: ann, name: "Ann", joinCode: "SCR001" });

    const transport = createScriptedTransport(buildServerLog(id, ann, "Ann"));
    const resolveSessionConfig: ResolveSessionConfig = () => ({
      transport,
      store: createMemoryOutboxStore(),
      roundId: id,
      golferId: ann,
      deviceId: deviceId("ann-tab"),
    });
    const RoundPageUnderTest = createRoundPage(createUseRoundSession(resolveSessionConfig));

    // Same stand-in idiom as the finalize/terminate flow tests above: the fake endpoint appends
    // the round-abandoned event to the scripted transport's log, so this tab's own sync() (fired
    // by RoundPage right after the POST resolves) folds it like a real server append.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(String(url)).toBe(`https://api.example.test/rounds/${id}/abandon`);
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok-scrap");
        (transport.log as RoundEvent[]).push({
          kind: "round-abandoned",
          authorId: ann,
          opId: opId("srv-abandon"),
          hlc: { wallMs: 9_999, counter: 0, deviceId: SERVER_DEVICE },
          seq: transport.log.length + 1,
        });
        return { ok: true, status: 200, json: async () => ({ status: "abandoned" }) } as unknown as Response;
      }),
    );

    render(
      <MemoryRouter initialEntries={[`/round/${id}`]}>
        <Routes>
          <Route path="/round/:roundId" element={<RoundPageUnderTest />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("SCR001")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Scrap this round" }));
    expect(screen.getByRole("dialog", { name: "Confirm scrap" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Scrap round" }));

    await waitFor(() => expect(screen.getByText("This round was scrapped.")).toBeTruthy());
    // The live scoring chrome is gone — no finalize, no scrap control, no scorecard.
    expect(screen.queryByRole("button", { name: "Finalize round" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Scrap this round" })).toBeNull();
    expect(screen.queryByText("SCR001")).toBeNull();
  });

  // task-15: a client that lands on an already-abandoned round (refreshed/rejoining, or one that
  // only observed the status flip via WS/pull) renders the scrapped notice directly — never
  // ResultsView, never the live scorecard.
  it("a round that's already abandoned renders the scrapped notice directly — no scoring chrome", async () => {
    const id = roundId("round-already-abandoned");
    const ann = golferId("ann");
    credentialStore.save(id, { token: "tok-ab", golferId: ann, name: "Ann", joinCode: "ABN001" });

    const abandoned: RoundEvent = { kind: "round-abandoned", authorId: ann, opId: opId("abandon-op"), hlc: { wallMs: 9_999, counter: 0, deviceId: SERVER_DEVICE } };
    const transport = createScriptedTransport(stampSeq([...buildServerLog(id, ann, "Ann"), abandoned]));
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

    await waitFor(() => expect(screen.getByText("This round was scrapped.")).toBeTruthy());
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("button", { name: "Finalize round" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Scrap this round" })).toBeNull();
  });

  // M7 Task 6: the chip End-game flow, wired end to end — overflow → confirm → POST terminate
  // → the game-terminated event folds back through the session → chip stays with an Ended badge.
  it("chip End-game flow: overflow → confirm → POST terminate → chip stays with an Ended badge", async () => {
    const id = roundId("round-terminate-flow");
    const ann = golferId("ann");
    const bo = golferId("bo");
    credentialStore.save(id, { token: "tok-term", golferId: ann, name: "Ann", joinCode: "TRM002" });

    const transport = createScriptedTransport(buildTwoPlayerServerLog(id, ann, bo));
    const resolveSessionConfig: ResolveSessionConfig = () => ({
      transport,
      store: createMemoryOutboxStore(),
      roundId: id,
      golferId: ann,
      deviceId: deviceId("ann-tab"),
    });
    const RoundPageUnderTest = createRoundPage(createUseRoundSession(resolveSessionConfig));

    // Same stand-in idiom as the finalize test above: the fake endpoint appends the
    // game-terminated event to the scripted transport's log, so this tab's own sync() (called
    // by RoundPage right after the POST resolves) folds it like a real server append.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(String(url)).toBe(`https://api.example.test/rounds/${id}/games/single-1/terminate`);
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok-term");
        const event: RoundEvent = {
          kind: "game-terminated",
          gameId: gameId("single-1"),
          authorId: ann,
          opId: opId("srv-term"),
          hlc: { wallMs: 9_500, counter: 0, deviceId: SERVER_DEVICE },
          seq: transport.log.length + 1,
        };
        (transport.log as RoundEvent[]).push(event);
        return { ok: true, status: 200, json: async () => ({ events: [event] }) } as unknown as Response;
      }),
    );

    render(
      <MemoryRouter initialEntries={[`/round/${id}`]}>
        <Routes>
          <Route path="/round/:roundId" element={<RoundPageUnderTest />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("TRM002")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "End Match play" }));
    const dialog = screen.getByRole("dialog", { name: "End Match play" });
    expect(dialog.textContent).toMatch(/Match play/); // the confirm names the game

    fireEvent.click(screen.getByRole("button", { name: "End game" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: /Match play/ }).textContent).toMatch(/Ended/));
    // The chip STAYS (an ended badge, not a removal), and its overflow control is gone.
    expect(screen.getByRole("tab", { name: /Match play/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "End Match play" })).toBeNull();
  });

  // Papercut 4 (M9 hardening): onAddGame used to be the ONE mutation on this page with no
  // sync() call — @swng/client's session has no periodic poll timer (only an explicit sync()
  // or a WS push moves the pull cursor), so without this fix the new game would only appear
  // once some LATER, unrelated action happened to sync — a confusing wait for the host who
  // just added it. This test's own waitFor would time out pre-fix; the scripted transport is
  // fully synchronous, so post-fix it resolves promptly.
  it("Add game flow: form submit → POST /rounds/{roundId}/games → the new game's chip appears via sync(), not a later unrelated trigger", async () => {
    const id = roundId("round-add-game");
    const ann = golferId("ann");
    credentialStore.save(id, { token: "tok-addgame", golferId: ann, name: "Ann", joinCode: "GAME01" });

    const transport = createScriptedTransport(buildServerLog(id, ann, "Ann"));
    const resolveSessionConfig: ResolveSessionConfig = () => ({
      transport,
      store: createMemoryOutboxStore(),
      roundId: id,
      golferId: ann,
      deviceId: deviceId("ann-tab"),
    });
    const RoundPageUnderTest = createRoundPage(createUseRoundSession(resolveSessionConfig));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(String(url)).toBe(`https://api.example.test/rounds/${id}/games`);
        expect(init?.method).toBe("POST");
        const event: RoundEvent = {
          kind: "game-added",
          config: { kind: "stableford", id: gameId("game-added-1"), players: [ann] },
          authorId: ann,
          opId: opId("srv-add-game"),
          hlc: { wallMs: 9_700, counter: 0, deviceId: SERVER_DEVICE },
          seq: transport.log.length + 1,
        };
        (transport.log as RoundEvent[]).push(event);
        return { ok: true, status: 201, json: async () => ({ gameId: gameId("game-added-1"), seq: event.seq }) } as unknown as Response;
      }),
    );

    render(
      <MemoryRouter initialEntries={[`/round/${id}`]}>
        <Routes>
          <Route path="/round/:roundId" element={<RoundPageUnderTest />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("GAME01")).toBeTruthy());
    expect(screen.queryByRole("tab", { name: /Stableford/ })).toBeNull();

    // Default kind is already stableford — no kind select to drive anymore.
    fireEvent.click(within(screen.getByRole("group", { name: "Who's in?" })).getByLabelText("Ann"));
    fireEvent.click(screen.getByRole("button", { name: /add game/i }));

    await waitFor(() => expect(screen.getByRole("tab", { name: /Stableford/ })).toBeTruthy());
  });

  // Papercut 1: the finalize dialog computes unresolved games from the LOCAL fold and offers
  // ending them + finalizing as one action — terminates each, THEN finalizes (order asserted).
  it("finalize dialog lists unresolved games and 'End unfinished games & finalize' terminates each THEN finalizes", async () => {
    const id = roundId("round-end-and-finalize");
    const ann = golferId("ann");
    const bo = golferId("bo");
    credentialStore.save(id, { token: "tok-eaf", golferId: ann, name: "Ann", joinCode: "EAF001" });

    const transport = createScriptedTransport(buildTwoPlayerServerLog(id, ann, bo));
    const resolveSessionConfig: ResolveSessionConfig = () => ({
      transport,
      store: createMemoryOutboxStore(),
      roundId: id,
      golferId: ann,
      deviceId: deviceId("ann-tab"),
    });
    const RoundPageUnderTest = createRoundPage(createUseRoundSession(resolveSessionConfig));

    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        const terminateMatch = /games\/([^/]+)\/terminate$/.exec(u);
        if (terminateMatch) {
          calls.push(`terminate:${terminateMatch[1]}`);
          const event: RoundEvent = {
            kind: "game-terminated",
            gameId: gameId(terminateMatch[1]!),
            authorId: ann,
            opId: opId(`srv-term-${terminateMatch[1]}`),
            hlc: { wallMs: 9_000 + calls.length, counter: 0, deviceId: SERVER_DEVICE },
            seq: transport.log.length + 1,
          };
          (transport.log as RoundEvent[]).push(event);
          return { ok: true, status: 200, json: async () => ({ events: [event] }) } as unknown as Response;
        }
        if (u.endsWith("/finalize")) {
          calls.push("finalize");
          (transport.log as RoundEvent[]).push({
            kind: "round-finalized",
            authorId: ann,
            opId: opId("srv-finalize"),
            hlc: { wallMs: 9_999, counter: 0, deviceId: SERVER_DEVICE },
            seq: transport.log.length + 1,
          });
          return { ok: true, status: 200, json: async () => ({ results: [], handicapping: [] }) } as unknown as Response;
        }
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    render(
      <MemoryRouter initialEntries={[`/round/${id}`]}>
        <Routes>
          <Route path="/round/:roundId" element={<RoundPageUnderTest />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("EAF001")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Finalize round" }));

    // The dialog lists each unresolved game in the game chip's own naming, with what's missing
    // — computed from the local fold, not a server response.
    const dialog = screen.getByRole("dialog", { name: "Confirm finalize" });
    expect(dialog.textContent).toMatch(/Match play — holes 1–9 unscored for Ann, Bo/);
    expect(dialog.textContent).toMatch(/Stroke play \(gross\) — holes 1–9 unscored for Ann, Bo/);
    // The plain Finalize action is not offered while games are unresolved.
    expect(screen.queryByRole("button", { name: "Finalize" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "End unfinished games & finalize" }));

    await waitFor(() => expect(screen.getByText("Final results")).toBeTruthy());
    // Terminates each unresolved game (in state.games order) THEN finalizes — the exact order.
    expect(calls).toEqual(["terminate:single-1", "terminate:gross-1", "finalize"]);
  });

  // Papercut 1's other half: the raw-uuid catch is gone — a finalize rejection renders a
  // human line (and the dialog's own structured list), never caught.message verbatim.
  it("a finalize rejection never renders the raw server message", async () => {
    const id = roundId("round-finalize-409");
    const ann = golferId("ann");
    credentialStore.save(id, { token: "tok-409", golferId: ann, name: "Ann", joinCode: "ERR409" });

    const transport = createScriptedTransport(buildServerLog(id, ann, "Ann"));
    const resolveSessionConfig: ResolveSessionConfig = () => ({
      transport,
      store: createMemoryOutboxStore(),
      roundId: id,
      golferId: ann,
      deviceId: deviceId("ann-tab"),
    });
    const RoundPageUnderTest = createRoundPage(createUseRoundSession(resolveSessionConfig));

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ code: "game-unresolved", message: 'game "3f2b9c1d-raw-uuid" never resolved' }) }) as unknown as Response),
    );

    render(
      <MemoryRouter initialEntries={[`/round/${id}`]}>
        <Routes>
          <Route path="/round/:roundId" element={<RoundPageUnderTest />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("ERR409")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Finalize round" }));
    fireEvent.click(screen.getByRole("button", { name: "Finalize" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(document.body.textContent).not.toMatch(/3f2b9c1d-raw-uuid/); // the uuid line never reaches the golfer
    // The dialog stays open (retry stays one tap away) rather than closing on the error.
    expect(screen.getByRole("dialog", { name: "Confirm finalize" })).toBeTruthy();
  });
});
