import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { cardId, courseId, deviceId, fixtureLinks, gameId, golferId, opId, roundId } from "@swng/domain";
import type { GameConfig, OpId, RoundEvent, RoundId } from "@swng/domain";
import { AuthProvider } from "../auth/useAuth";
import { roundLabel } from "../roundLabel";
import type { WatchRoundView } from "./useWatchRound";
import { createWatchPage } from "./WatchPage";

// WatchPage renders inside the app's root AuthProvider in production (App.tsx wraps everything) —
// this wrapper mirrors that ancestor. ResultsView no longer reads auth itself (the claim
// affordance is gone), so it's belt-and-suspenders, but harmless and keeps parity with the other
// page specs.
const renderWithAuth = (ui: React.ReactElement) => render(<AuthProvider>{ui}</AuthProvider>);

afterEach(() => cleanup());

const ROUND_ID = roundId("watch-round-1");
const ANN_ID = golferId("ann");
const BO_ID = golferId("bo");
const SERVER_DEVICE = deviceId("server");

const buildLiveLog = (): RoundEvent[] => {
  let wallMs = 1_000;
  const nextHlc = () => ({ wallMs: wallMs++, counter: 0, deviceId: SERVER_DEVICE });
  let opCounter = 0;
  const nextOpId = (): OpId => opId(`server-op-${(opCounter += 1)}`);
  const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN_ID, BO_ID] };
  return [
    { kind: "round-created", roundId: ROUND_ID, card: fixtureLinks, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "participant-joined", participant: { golferId: ANN_ID, name: "Ann", tee: "white", basis: { kind: "normally-shoots", overPar: 8 } }, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "participant-joined", participant: { golferId: BO_ID, name: "Bo", tee: "white", basis: { kind: "normally-shoots", overPar: 2 } }, authorId: BO_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "round-started", authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "game-added", config: stableford, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    {
      kind: "score-recorded",
      golferId: ANN_ID,
      hole: 1,
      result: { kind: "strokes", strokes: 4 },
      authorId: ANN_ID,
      opId: nextOpId(),
      hlc: nextHlc(),
    },
  ];
};

const buildFinalLog = (): RoundEvent[] => [...buildLiveLog(), { kind: "round-finalized", authorId: ANN_ID, opId: opId("op-finalize"), hlc: { wallMs: 9_000, counter: 0, deviceId: SERVER_DEVICE } }];

// The link sweep's own course-carrying variant (navigation spec, task 6) — the SAME logs above,
// with the genesis event's frozen card carrying a `source` (write-time provenance, course-cards
// spec §2), so the heading's course-name half has a courseId to link.
const WATCH_COURSE_ID = courseId("course-watch-1");
const withCourseSource = (log: readonly RoundEvent[]): RoundEvent[] => {
  const created = log[0] as Extract<RoundEvent, { kind: "round-created" }>;
  return [{ ...created, card: { ...created.card, source: { courseId: WATCH_COURSE_ID, cardId: cardId("card-1") } } }, ...log.slice(1)];
};
const buildLiveLogWithCourse = (): RoundEvent[] => withCourseSource(buildLiveLog());
const buildFinalLogWithCourse = (): RoundEvent[] => withCourseSource(buildFinalLog());

const buildAbandonedLog = (): RoundEvent[] => [...buildLiveLog(), { kind: "round-abandoned", authorId: ANN_ID, opId: opId("op-abandon"), hlc: { wallMs: 9_000, counter: 0, deviceId: SERVER_DEVICE } }];

// A fixed WatchRoundView, no hook/transport machinery — WatchPage's own contract only needs a
// `(roundId, token) => WatchRoundView` function (same "hand a fixed view, not a live hook" idiom
// this suite uses throughout), so a test can drive the LIVE and FINAL render paths directly
// from a hand-built RoundState instead of standing up a scripted transport for every case.
const fixedUseWatchRound = (view: WatchRoundView) => (_roundId: RoundId, _token: string) => view;

const renderWatchPage = (path: string, useWatchRound: (roundId: RoundId, token: string) => WatchRoundView) => {
  const WatchPageUnderTest = createWatchPage(useWatchRound);
  return renderWithAuth(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/watch/:roundId" element={<WatchPageUnderTest />} />
      </Routes>
    </MemoryRouter>,
  );
};

describe("WatchPage", () => {
  it("shows a loading skeleton before hydration, using the token from the URL FRAGMENT (not a query param)", () => {
    const idle: WatchRoundView = { hydrated: false, error: false, state: undefined, games: [], createdAt: undefined };
    let seenToken: string | undefined;
    renderWatchPage(`/watch/${ROUND_ID}#spectator-tok-1`, (_roundId, token) => {
      seenToken = token;
      return idle;
    });

    expect(screen.getByRole("status", { name: "Loading round" })).toBeTruthy();
    expect(seenToken).toBe("spectator-tok-1"); // the leading "#" is stripped
  });

  // Papercut 14 (M9 hardening): a mistyped/dead link surfaces an honest message instead of
  // spinning "Loading round…" forever — never the raw error/exception text.
  it("shows an honest 'not valid' message (not perpetual loading) when useWatchRound surfaces a terminal error", () => {
    const errored: WatchRoundView = { hydrated: false, error: true, state: undefined, games: [], createdAt: undefined };
    renderWatchPage(`/watch/${ROUND_ID}#dead-token`, () => errored);

    expect(screen.getByText(/isn.t valid/i)).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading round" })).toBeNull();
  });

  it("renders an incomplete-link message when the fragment carries no token", () => {
    renderWatchPage(`/watch/${ROUND_ID}`, () => {
      throw new Error("useWatchRound must never be called with no token");
    });

    expect(screen.getByText(/looks incomplete/)).toBeTruthy();
  });

  it("renders the live scorecard + standings from fake events, structurally with NO score buttons", async () => {
    const { reduceRound, scoreGame } = await import("@swng/domain");
    const events = buildLiveLog();
    const state = reduceRound(events);
    const games = state.games.map((g) => scoreGame(g, state));
    // buildLiveLog's genesis carries wallMs 1_000 — the round's created-at, which WatchPage's
    // header renders via the canonical designation (spec §5).
    const view: WatchRoundView = { hydrated: true, error: false, state, games, createdAt: 1_000 };

    renderWatchPage(`/watch/${ROUND_ID}#spectator-tok-2`, fixedUseWatchRound(view));

    // The canonical course + date header identifies WHICH round the spectator is watching
    // (fixtureLinks' courseName + created-at 1_000ms), replacing the bare course name.
    expect(await screen.findByText(roundLabel({ courseName: "Fixture Links", createdAt: 1_000 }))).toBeTruthy();
    // Nav infrastructure Task 2: usePageTitle re-runs once the round hydrates — the same
    // canonical designation the page's own header renders.
    expect(document.title).toBe(`${roundLabel({ courseName: "Fixture Links", createdAt: 1_000 })} · swng`);
    // The live grid + standings actually render (a real spectator sees the scorecard).
    await waitFor(() => expect(screen.getByRole("button", { name: /Stableford/ })).toBeTruthy());
    expect(screen.getByRole("columnheader", { name: "Ann" })).toBeTruthy();
    // Ann's hole-1 score (a "4") rendered as static text inside a disabled cell, not a live
    // number a spectator could imagine tapping to change.
    const cell = screen.getByRole("button", { name: "Ann hole 1" });
    expect(cell.hasAttribute("disabled")).toBe(true);

    // Structural proof of "no score buttons": every rendered button is either the disabled
    // grid cells above or a StandingsHeader game-select CHIP (a disclosure toggle — the one
    // other button kind here carries aria-expanded) — never a ScorePad value button
    // (1..12/"Picked up"/"Conceded"), never an "End game…" trigger (no onTerminate passed
    // here at all), never "Finalize round"/"Add game"/"Add player" (SetupPanel/FinalizeControl
    // are never rendered by WatchPage in the first place).
    const buttons = screen.getAllByRole("button");
    for (const button of buttons) {
      const isGameChip = button.hasAttribute("aria-expanded");
      expect(isGameChip || button.hasAttribute("disabled")).toBe(true);
    }
    expect(screen.queryByRole("dialog")).toBeNull(); // ScorePad/FinalizeControl/StandingsHeader's own confirm dialogs never open
    expect(screen.queryByRole("button", { name: /Finalize round/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Add /i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^End /i })).toBeNull();
  });

  it("flips to the archived card (ResultsView) once status is final", async () => {
    const { reduceRound, scoreGame } = await import("@swng/domain");
    const events = buildFinalLog();
    const state = reduceRound(events);
    const games = state.games.map((g) => scoreGame(g, state));
    const view: WatchRoundView = { hydrated: true, error: false, state, games, createdAt: 1_000 };

    renderWatchPage(`/watch/${ROUND_ID}#spectator-tok-3`, fixedUseWatchRound(view));

    await waitFor(() => expect(screen.getByText("Final results")).toBeTruthy());
    // WatchPage's own ResultsView reuse carries NO shareToken — a spectator can't mint a NEW
    // share link (the route is participant-only) — so "Share round" must never appear here.
    expect(screen.queryByRole("button", { name: "Share round" })).toBeNull();
    // Every archived-card cell is disabled too (ResultsView's own readOnly contract).
    const cell = screen.getByRole("button", { name: "Ann hole 1" });
    expect(cell.hasAttribute("disabled")).toBe(true);
  });

  // task-15: a scrapped round is terminal with nothing to show a spectator — an honest notice,
  // never a crash, never a stale live grid or a results view.
  it("renders an honest scrapped notice once status is abandoned — no scorecard, no results", async () => {
    const { reduceRound, scoreGame } = await import("@swng/domain");
    const events = buildAbandonedLog();
    const state = reduceRound(events);
    const games = state.games.map((g) => scoreGame(g, state));
    const view: WatchRoundView = { hydrated: true, error: false, state, games, createdAt: 1_000 };

    renderWatchPage(`/watch/${ROUND_ID}#spectator-tok-abandoned`, fixedUseWatchRound(view));

    await waitFor(() => expect(screen.getByText(/was scrapped/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Stableford/ })).toBeNull();
    expect(screen.queryByText("Final results")).toBeNull();
  });

  // The link sweep's own watch pin (navigation spec, task 6, brief Step 2): the heading's
  // course-name half links to the course (public — allowed on a spectator view) while every
  // GOLFER name renders plain, no anchor — PlainNamesContext reaches the whole tree, live AND
  // archived.
  it("the plain-names pin (live): the course-name heading links to the course while participant names render with NO anchor", async () => {
    const { reduceRound, scoreGame } = await import("@swng/domain");
    const events = buildLiveLogWithCourse();
    const state = reduceRound(events);
    const games = state.games.map((g) => scoreGame(g, state));
    const view: WatchRoundView = { hydrated: true, error: false, state, games, createdAt: 1_000 };

    renderWatchPage(`/watch/${ROUND_ID}#tok-plain-live`, fixedUseWatchRound(view));

    const courseLink = await screen.findByRole("link", { name: "Fixture Links" });
    expect(courseLink.getAttribute("href")).toBe(`/courses/${WATCH_COURSE_ID}`);

    // Expand the Stableford chip to reach GamePanel's own participant-name render sites — the
    // one place a spectator's live view would otherwise show a GolferLink.
    fireEvent.click(screen.getByRole("button", { name: /Stableford/ }));
    await waitFor(() => expect(screen.getByRole("region")).toBeTruthy());

    expect(screen.getAllByText("Ann").length).toBeGreaterThan(0); // renders — just never as a link
    expect(screen.queryByRole("link", { name: "Ann" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Bo" })).toBeNull();
  });

  it("the plain-names pin (archived/final): the course-name heading links to the course while ResultsView's names render with NO anchor", async () => {
    const { reduceRound, scoreGame } = await import("@swng/domain");
    const events = buildFinalLogWithCourse();
    const state = reduceRound(events);
    const games = state.games.map((g) => scoreGame(g, state));
    const view: WatchRoundView = { hydrated: true, error: false, state, games, createdAt: 1_000 };

    renderWatchPage(`/watch/${ROUND_ID}#tok-plain-final`, fixedUseWatchRound(view));

    await waitFor(() => expect(screen.getByText("Final results")).toBeTruthy());

    const courseLink = screen.getByRole("link", { name: "Fixture Links" });
    expect(courseLink.getAttribute("href")).toBe(`/courses/${WATCH_COURSE_ID}`);

    // ResultsView's roster + handicapping rows both name Ann — neither renders as a link here.
    expect(screen.getAllByText("Ann").length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Ann" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Bo" })).toBeNull();
  });
});
