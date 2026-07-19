import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAllowance, fixtureLinks, gameId, golferId, playingHandicap, roundId } from "@swng/domain";
import type { GameConfig, GameState, Participant, RoundState } from "@swng/domain";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { SetupPanel } from "./SetupPanel";
import type { SetupPanelProps } from "./SetupPanel";

const ANN = golferId("ann");
const BO = golferId("bo");
const CAL = golferId("cal");
const DEE = golferId("dee");

const participant = (id: ReturnType<typeof golferId>, name: string, tee: string, courseHandicap: number): Participant => ({ golferId: id, name, tee, courseHandicap });

const baseState = (overrides: Partial<RoundState> = {}): RoundState => ({
  id: roundId("round-1"),
  status: "live",
  card: fixtureLinks,
  participants: [participant(ANN, "Ann", "white", 8), participant(BO, "Bo", "white", 4), participant(CAL, "Cal", "white", 14), participant(DEE, "Dee", "white", 2)],
  games: [],
  cells: {},
  terminatedGameIds: new Set(),
  ...overrides,
});

const noopAddGame = vi.fn().mockResolvedValue(undefined);

// SetupPanel no longer touches auth (the claim affordance is gone), but the AuthProvider wrapper
// stays: it lets the signed-in pins below prove that even in the state that USED to render the
// claim button, nothing does — and that SetupPanel fires no fetch of its own.
const renderPanel = (props: SetupPanelProps) =>
  render(
    <AuthProvider>
      <SetupPanel {...props} />
    </AuthProvider>,
  );

const fakeResponse = (status: number, body: unknown): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const base64url = (obj: unknown): string =>
  btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const signIn = () => {
  const idToken = `${base64url({ alg: "none" })}.${base64url({ sub: "sub-1", email: "signed-in@example.com" })}.sig`;
  tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 60_000 });
};

beforeEach(() => {
  noopAddGame.mockClear();
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SetupPanel", () => {
  it("shows the join code prominently", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame });

    expect(screen.getByText("ABC123")).toBeTruthy();
  });

  it("shows the plain roster (name, tee, courseHandicap) when no games exist yet", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame });

    expect(screen.getByText("Ann")).toBeTruthy();
    expect(screen.getByText(/CH 8/)).toBeTruthy();
    expect(screen.queryByText(/^Games/)).toBeNull(); // no games section before any game exists
  });

  // accounts-only identity spec §4: a departed participant is NOT removed from the roster — they
  // keep their seat data (their played holes are facts) and gain a "left" marker a present
  // participant never shows.
  it("marks a departed participant with a 'left' marker, keeping their seat data on the roster", () => {
    const state = baseState({
      participants: [participant(ANN, "Ann", "white", 8), { ...participant(BO, "Bo", "white", 4), departed: true }],
    });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame });

    const boRow = screen.getAllByRole("listitem").find((li) => /Bo — white — CH 4/.test(li.textContent ?? ""));
    expect(boRow).toBeTruthy(); // still on the roster, seat data intact
    expect(within(boRow!).getByText(/^left$/i)).toBeTruthy();

    // A present participant carries no such marker.
    const annRow = screen.getAllByRole("listitem").find((li) => /Ann — white — CH 8/.test(li.textContent ?? ""));
    expect(within(annRow!).queryByText(/^left$/i)).toBeNull();
  });

  it("shows per-game dots once a game exists, on the same roster row as name/tee/CH", () => {
    const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN] };
    const state = baseState({ games: [stableford] });
    const games: GameState[] = [{ kind: "stableford", id: gameId("game-1"), lines: [], complete: false, leaders: [] }];

    renderPanel({ state, games, joinCode: "ABC123", onAddGame: noopAddGame });

    const expectedDots = playingHandicap(8, defaultAllowance("stableford"));
    const annRow = screen.getAllByRole("listitem").find((li) => /CH 8/.test(li.textContent ?? ""));
    expect(annRow).toBeTruthy();
    // Same row carries both the identity (name/tee/CH) and the game's dots — one roster, not
    // a second list keyed off dots alone.
    expect(within(annRow!).getByText(new RegExp(`Stableford: ${expectedDots} dots`))).toBeTruthy();
  });

  // M7 Task 6: terminated games drop out of roster dot-badges (brief) — a terminated game has
  // stopped consuming scores, so it shouldn't still claim a dots badge on the roster.
  it("drops a terminated game's badge from the roster, even though the game config is still in state.games", () => {
    const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN] };
    const state = baseState({ games: [stableford], terminatedGameIds: new Set([stableford.id]) });
    const games: GameState[] = [{ kind: "stableford", id: gameId("game-1"), lines: [], complete: false, leaders: [] }];

    renderPanel({ state, games, joinCode: "ABC123", onAddGame: noopAddGame });

    const annRow = screen.getAllByRole("listitem").find((li) => /CH 8/.test(li.textContent ?? ""));
    expect(annRow).toBeTruthy();
    expect(within(annRow!).queryByText(/Stableford/)).toBeNull();
    expect(within(annRow!).getByText("Not yet in a game")).toBeTruthy();
  });

  it("renders each participant's identity row exactly once even once games exist — no second, dots-only roster", () => {
    const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN] };
    const state = baseState({ games: [stableford] });
    const games: GameState[] = [{ kind: "stableford", id: gameId("game-1"), lines: [], complete: false, leaders: [] }];

    renderPanel({ state, games, joinCode: "ABC123", onAddGame: noopAddGame });

    // Scope to <li> rows specifically (not the Add Game form's player checkboxes, which are
    // <label> elements, not list items) — Ann must appear as exactly one roster row.
    const annRows = screen.getAllByRole("listitem").filter((li) => /Ann/.test(li.textContent ?? ""));
    expect(annRows).toHaveLength(1);
    // And that single row still carries the full identity — tee and courseHandicap didn't
    // get dropped in favor of a dots-only line.
    expect(annRows[0]?.textContent).toMatch(/white/);
    expect(annRows[0]?.textContent).toMatch(/CH 8/);

    // Bo has no game yet — still gets an identity row (just no dots badge).
    const boRows = screen.getAllByRole("listitem").filter((li) => /Bo/.test(li.textContent ?? ""));
    expect(boRows).toHaveLength(1);
    expect(boRows[0]?.textContent).toMatch(/CH 4/);
  });

  it("adds a fourball-match game with the exact {kind, a, b} shape (ids from participants) and no id field", async () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame });
    noopAddGame.mockClear();

    fireEvent.change(screen.getByLabelText(/^kind$/i), { target: { value: "fourball-match" } });
    fireEvent.change(screen.getByLabelText(/side a.*player 1/i), { target: { value: ANN } });
    fireEvent.change(screen.getByLabelText(/side a.*player 2/i), { target: { value: BO } });
    fireEvent.change(screen.getByLabelText(/side b.*player 1/i), { target: { value: CAL } });
    fireEvent.change(screen.getByLabelText(/side b.*player 2/i), { target: { value: DEE } });
    fireEvent.click(screen.getByRole("button", { name: /add game/i }));

    expect(noopAddGame).toHaveBeenCalledTimes(1);
    const sent = noopAddGame.mock.calls[0]![0];
    expect(sent).toMatchObject({ kind: "fourball-match", a: [ANN, BO], b: [CAL, DEE] });
    expect(sent).not.toHaveProperty("id");
  });

  it("never renders the submitted game optimistically — it only appears once state.games reflects it", async () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame });

    fireEvent.change(screen.getByLabelText(/^kind$/i), { target: { value: "stableford" } });
    fireEvent.click(within(screen.getByRole("group", { name: /players/i })).getByLabelText("Ann"));
    fireEvent.click(screen.getByRole("button", { name: /add game/i }));

    expect(noopAddGame).toHaveBeenCalled();
    // Props are unchanged (still zero games) — the new game must not appear from the click
    // alone. Confirms the why-comment in SetupPanel: game-added arrives back through the
    // session, not from a local optimistic write.
    expect(screen.queryByText(/^Games/)).toBeNull();

    // Only once the parent re-renders with the new game (as the real session would, after the
    // game-added event round-trips) does it show up.
    const stableford: GameConfig = { kind: "stableford", id: gameId("game-9"), players: [ANN] };
    cleanup();
    renderPanel({ state: baseState({ games: [stableford] }), games: [], joinCode: "ABC123", onAddGame: noopAddGame });
    const expectedDots = playingHandicap(8, defaultAllowance("stableford"));
    expect(screen.getByText(new RegExp(`Stableford: ${expectedDots} dots`))).toBeTruthy();
  });

  it("sends a hand-edited allowance value (not the per-kind default) in onAddGame's config", async () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame });
    noopAddGame.mockClear();

    fireEvent.change(screen.getByLabelText(/^kind$/i), { target: { value: "stableford" } });
    fireEvent.click(within(screen.getByRole("group", { name: /players/i })).getByLabelText("Ann"));
    // 0.5 isn't stableford's default allowance (0.95, per defaultAllowance) — picking a value
    // that differs from the default is the point: this guards the step="any" fix (a stricter
    // step would have silently blocked this exact submit).
    fireEvent.change(screen.getByLabelText(/allowance/i), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: /add game/i }));

    expect(noopAddGame).toHaveBeenCalledTimes(1);
    const sent = noopAddGame.mock.calls[0]![0];
    expect(sent).toMatchObject({ kind: "stableford", players: [ANN], allowance: 0.5 });
  });

  // Papercut 12 (M9 hardening, the never-raw-caught.message sweep): a failed Add game must never
  // surface a raw generic Error's message — only an honest fallback.
  it("never renders a raw generic Error's message from a failed Add game — only an honest fallback (papercut 12)", async () => {
    const rejecting = vi.fn().mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'bar')"));
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: rejecting });

    fireEvent.change(screen.getByLabelText(/^kind$/i), { target: { value: "stableford" } });
    fireEvent.click(within(screen.getByRole("group", { name: /players/i })).getByLabelText("Ann"));
    fireEvent.click(screen.getByRole("button", { name: /add game/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toBe("Could not add the game — try again.");
    expect(document.body.textContent).not.toMatch(/Cannot read properties/);
  });
});

// The wall (accounts-only identity spec §3): nobody puts anyone on a card. The "Add player"
// ghost form is deleted; the join code — already rendered above — is framed as the one way in.
describe("SetupPanel — share the code, not add a player", () => {
  it("frames the join code as the one way in — new players sign up on the way", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame });

    expect(screen.getByText(/players join with this code — new players create their account on the way/i)).toBeTruthy();
  });

  it("has no 'Add player' ghost form at all — no name field, no Add player button", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame });

    expect(screen.queryByRole("button", { name: /^add player$/i })).toBeNull();
    expect(screen.queryByLabelText(/^name$/i)).toBeNull();
  });

  // Proof-of-negative (brief): the claim affordance is gone from the roster entirely — even in
  // the one state (signed in) that used to render "This is me" on every unlinked row.
  it("no 'This is me' claim affordance on any roster row, even signed in", async () => {
    signIn();
    const fetchMock = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/me") return fakeResponse(200, { golfer: null });
      throw new Error(`unexpected fetch ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame });

    // Let the AuthProvider's own GET /me settle so a claim button, if any, would have rendered.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/me"), expect.anything()));
    expect(screen.queryByRole("button", { name: "This is me" })).toBeNull();
  });

  // No new fetches (brief): the share panel is pure presentation of a code already in props — it
  // never mints a link or fetches participants/crews. The only fetch the tree makes is the
  // AuthProvider's own GET /me, and nothing else.
  it("makes no fetch of its own — the share panel reads only the joinCode already in props", async () => {
    signIn();
    const fetchMock = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/me") return fakeResponse(200, { golfer: { indexSource: { kind: "swng" }, golferId: "ann", name: "Ann" } });
      throw new Error(`unexpected fetch ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/me"), expect.anything()));
    // Every fetch the whole tree ever made was the AuthProvider's GET /me — SetupPanel itself
    // reached no endpoint (no /players, no /share, no /crews).
    for (const call of fetchMock.mock.calls) expect(new URL(String(call[0])).pathname).toBe("/me");
  });
});

// index-source one-tap + plus-handicap arc: the setup roster is a LIVE render surface too. A plus
// player (course handicap below 0) must show through the domain's sign conventions — a plus course
// handicap reads "CH +1" (never a bare "CH -1"), and a give-back dot total reads "gives N" (never a
// bare "-N dots"). A normal (positive/zero) participant's row and badge are byte-unchanged.
describe("SetupPanel — a plus handicap renders through the domain (CH +N, gives N)", () => {
  const PLUS = golferId("plus");
  const NORMAL = golferId("normal");

  it("renders a plus course handicap as 'CH +1', never a bare 'CH -1' — a normal handicap stays plain 'CH 13'", () => {
    const state = baseState({ participants: [participant(PLUS, "Plus", "white", -1), participant(NORMAL, "Norm", "white", 13)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame });

    const plusRow = screen.getAllByRole("listitem").find((li) => /Plus/.test(li.textContent ?? ""));
    expect(plusRow).toBeTruthy();
    expect(plusRow!.textContent).toMatch(/CH \+1\b/);
    expect(plusRow!.textContent).not.toMatch(/CH -1/);

    // A normal positive handicap is byte-unchanged — a plain "CH 13", no sign.
    const normRow = screen.getAllByRole("listitem").find((li) => /Norm/.test(li.textContent ?? ""));
    expect(normRow!.textContent).toMatch(/CH 13\b/);
    expect(normRow!.textContent).not.toMatch(/\+/);
  });

  it("renders a plus player's give-back dot total as 'gives N', never a bare '-N dots'; a normal total is unchanged", () => {
    // Skins is full-handicap (allowance 1): a plus player (CH -1) gives one stroke, so the dot
    // total is -1 — the exact bare-negative the arc closes everywhere else.
    const skins: GameConfig = { kind: "skins", id: gameId("game-1"), players: [PLUS, NORMAL] };
    const state = baseState({ participants: [participant(PLUS, "Plus", "white", -1), participant(NORMAL, "Norm", "white", 5)], games: [skins] });
    const games: GameState[] = [{ kind: "skins", id: gameId("game-1"), lines: [], carrying: 0, carriedOut: 0, complete: false, holesDecided: 0, holes: [] }];
    renderPanel({ state, games, joinCode: "ABC123", onAddGame: noopAddGame });

    const plusRow = screen.getAllByRole("listitem").find((li) => /Plus/.test(li.textContent ?? ""));
    expect(plusRow).toBeTruthy();
    expect(within(plusRow!).getByText("Skins: gives 1")).toBeTruthy();
    expect(plusRow!.textContent).not.toMatch(/-1 dots/);

    // A normal (receives) dot total is byte-identical to before: "{label}: N dots".
    const normRow = screen.getAllByRole("listitem").find((li) => /Norm/.test(li.textContent ?? ""));
    expect(within(normRow!).getByText("Skins: 5 dots")).toBeTruthy();
  });
});
