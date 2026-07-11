import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crewId as makeCrewId, defaultAllowance, fixtureLinks, gameId, golferId, playingHandicap, roundId } from "@swng/domain";
import type { GameConfig, GameState, Participant, RoundState } from "@swng/domain";
import { addParticipantRequestSchema } from "@swng/contracts";
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
const noopAddParticipant = vi.fn().mockResolvedValue(undefined);

// Every SetupPanel render now needs an AuthProvider ancestor (ClaimAffordance calls useAuth())
// — this is the one place that wrapping lives, so the other ~10 tests in this file that don't
// care about auth stay untouched otherwise.
const renderPanel = (props: Omit<SetupPanelProps, "onAddParticipant"> & Partial<Pick<SetupPanelProps, "onAddParticipant">>) =>
  render(
    <AuthProvider>
      <SetupPanel {...props} onAddParticipant={props.onAddParticipant ?? noopAddParticipant} />
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
  noopAddParticipant.mockClear();
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

  it("shows per-game dots once a game exists, on the same roster row as name/tee/CH", () => {
    const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN] };
    const state = baseState({ games: [stableford] });
    const games: GameState[] = [{ kind: "stableford", id: gameId("game-1"), lines: [], complete: false }];

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
    const games: GameState[] = [{ kind: "stableford", id: gameId("game-1"), lines: [], complete: false }];

    renderPanel({ state, games, joinCode: "ABC123", onAddGame: noopAddGame });

    const annRow = screen.getAllByRole("listitem").find((li) => /CH 8/.test(li.textContent ?? ""));
    expect(annRow).toBeTruthy();
    expect(within(annRow!).queryByText(/Stableford/)).toBeNull();
    expect(within(annRow!).getByText("Not yet in a game")).toBeTruthy();
  });

  it("renders each participant's identity row exactly once even once games exist — no second, dots-only roster", () => {
    const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN] };
    const state = baseState({ games: [stableford] });
    const games: GameState[] = [{ kind: "stableford", id: gameId("game-1"), lines: [], complete: false }];

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

  // Papercut 12 (M9 hardening, the never-raw-caught.message sweep): same fix as AddPlayerForm's
  // own sibling test — this form also used to catch `instanceof Error` too broadly.
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

// M7 Task 6: claim a ghost from the round roster — "This is me" on any row not already linked
// to the signed-in account, only once signed in. Corrected post-launch (a field smoke caught
// the original over-restriction): device round-identity (which row this browser tab scores as)
// is not account identity, so the affordance is NOT suppressed on "your own device's row" —
// the most common case is the round's creator signing in and claiming exactly that row.
describe("SetupPanel — claim a ghost", () => {
  it("shows no claim affordance at all when signed out", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame });

    expect(screen.queryByRole("button", { name: "This is me" })).toBeNull();
  });

  it("shows 'This is me' on the signed-in user's OWN device row too, when unlinked — the exact gap a field smoke caught", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(200, { golfer: null })),
    );
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame });

    // Ann, Bo, Cal, Dee — no row is special-cased just because it happens to be the device's
    // own round-session participant; every row is a candidate until the account is linked.
    await waitFor(() => expect(screen.getAllByRole("button", { name: "This is me" })).toHaveLength(4));

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    expect(within(annRow!).getByRole("button", { name: "This is me" })).toBeTruthy();
  });

  // M8 Task 5: the own-row arm now renders a steady "You" marker instead of a bare null — the
  // ClaimAffordance guard itself is unchanged (still hides the CLAIM button on this row), but
  // the row must say whose it is, not go silent.
  it("shows 'You' (not the claim button) on the row already linked to the signed-in account", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(200, { golfer: { golferId: "cal", name: "Cal" } })),
    );
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame });

    await waitFor(() => expect(screen.getAllByRole("button", { name: "This is me" })).toHaveLength(3)); // Ann, Bo, Dee — not Cal

    const calRow = screen.getAllByRole("listitem").find((li) => /Cal/.test(li.textContent ?? ""));
    expect(within(calRow!).queryByRole("button", { name: "This is me" })).toBeNull();
    expect(within(calRow!).getByText("You")).toBeTruthy();
  });

  it("This is me -> confirm -> POST /golfers/claim (carrying the roster row's name, papercut 5) -> success re-fetches /me", async () => {
    signIn();
    const calls: string[] = [];
    let claimBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/golfers/claim") {
          claimBody = JSON.parse(String(init?.body));
          return fakeResponse(200, { golfer: { golferId: "bo", name: "Bo" } });
        }
        if (path === "/me") return fakeResponse(200, { golfer: calls.includes("POST /golfers/claim") ? { golferId: "bo", name: "Bo" } : null });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame });

    const boRow = await waitFor(() => {
      const row = screen.getAllByRole("listitem").find((li) => /Bo/.test(li.textContent ?? ""));
      expect(row).toBeTruthy();
      return row!;
    });

    fireEvent.click(within(boRow).getByRole("button", { name: "This is me" }));
    expect(within(boRow).getByRole("dialog")).toBeTruthy();
    fireEvent.click(within(boRow).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(within(boRow).getByRole("status")).toBeTruthy());
    expect(calls).toContain("POST /golfers/claim");
    // The claim carries the ROSTER row's name ("Bo"), not any account/email default — a fresh
    // claim's profile is named after the row it claimed — and the round's own join code
    // (M9 hardening: claim proof-of-context), SetupPanel's own joinCode prop.
    expect(claimBody).toEqual({ golferId: "bo", name: "Bo", code: "ABC123" });
    // Re-fetches /me after a successful claim (brief) — a real second GET, not a locally
    // synthesized echo of the claim response.
    expect(calls.filter((c) => c === "GET /me").length).toBeGreaterThanOrEqual(2);
  });

  // The two collision arms in claimGolfer.ts both throw the SAME "golfer-already-claimed"
  // code, so the client must disambiguate by auth.golfer to give honest copy — arm 1 (the row
  // itself already claimed by someone else) only applies when THIS account has no golfer yet.
  it("a 409 with auth.golfer null shows 'already claimed by another account' (collision arm 1: the row itself was claimed by someone else)", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/golfers/claim") return fakeResponse(409, { code: "golfer-already-claimed", message: "already claimed" });
        if (path === "/me") return fakeResponse(200, { golfer: null });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame });

    const boRow = await waitFor(() => {
      const row = screen.getAllByRole("listitem").find((li) => /Bo/.test(li.textContent ?? ""));
      expect(row).toBeTruthy();
      return row!;
    });

    fireEvent.click(within(boRow).getByRole("button", { name: "This is me" }));
    fireEvent.click(within(boRow).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(within(boRow).getByText("Already claimed by another account.")).toBeTruthy());
  });

  it("a 409 with auth.golfer already set shows the honest 'your account already has a profile' copy (collision arm 2: THIS account's sub is already bound elsewhere)", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/golfers/claim") return fakeResponse(409, { code: "golfer-already-claimed", message: "sub already bound to golfer g-cal" });
        // Signed-in account already has ITS OWN golfer (Cal, not Bo) — the row it's trying to
        // claim ("This is me" on Bo) is a second, different ghost.
        if (path === "/me") return fakeResponse(200, { golfer: { golferId: "cal", name: "Cal" } });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame });

    const boRow = await waitFor(() => {
      const row = screen.getAllByRole("listitem").find((li) => /Bo/.test(li.textContent ?? ""));
      expect(row).toBeTruthy();
      return row!;
    });

    fireEvent.click(within(boRow).getByRole("button", { name: "This is me" }));
    fireEvent.click(within(boRow).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(within(boRow).getByText("Your account already has a profile — claiming another ghost isn't supported yet.")).toBeTruthy());
    // Never the misleading arm-1 copy for this case.
    expect(within(boRow).queryByText(/already claimed by another account/i)).toBeNull();
  });

  // M9 hardening (claim proof-of-context): a 403 claim-proof-required gets its own honest
  // copy — never the raw server message, and never confused with either 409 collision arm's
  // copy above.
  it("a 403 claim-proof-required shows the honest 'needs a round or crew code' copy", async () => {
    signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/golfers/claim") return fakeResponse(403, { code: "claim-proof-required", message: 'code "ABC123" does not prove membership for golfer bo' });
        if (path === "/me") return fakeResponse(200, { golfer: null });
        throw new Error(`unexpected fetch ${path}`);
      }),
    );
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame });

    const boRow = await waitFor(() => {
      const row = screen.getAllByRole("listitem").find((li) => /Bo/.test(li.textContent ?? ""));
      expect(row).toBeTruthy();
      return row!;
    });

    fireEvent.click(within(boRow).getByRole("button", { name: "This is me" }));
    fireEvent.click(within(boRow).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(within(boRow).getByText("This claim needs a round or crew code that includes this player.")).toBeTruthy());
    // Never the raw server message.
    expect(within(boRow).queryByText(/does not prove membership/i)).toBeNull();
  });
});

// M8 Task 5: "Add player" — the host types Dave in (or, for a crew round, taps one of the
// crew's not-yet-in-round members). POST /rounds/{roundId}/players; no optimistic insert, same
// precedent as the "Add game" form above — the new row only ever appears once the fold
// reflects it.
describe("SetupPanel — Add player", () => {
  const fakeResponse = (status: number, body: unknown): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

  it("free-text ghost: name + tee + courseHandicap -> onAddParticipant with NO golferId key; the row appears only once the fold reflects it", async () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onAddParticipant: noopAddParticipant });

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Dave" } });
    fireEvent.change(screen.getByLabelText(/^tee$/i), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: /^add player$/i }));

    await waitFor(() => expect(noopAddParticipant).toHaveBeenCalledTimes(1));
    const sent = noopAddParticipant.mock.calls[0]![0];
    expect(sent).toEqual({ name: "Dave", tee: "white", courseHandicap: 9 });
    expect(() => addParticipantRequestSchema.parse(sent)).not.toThrow();

    // No optimistic insert — "Dave" never appears in the roster from the click alone.
    expect(screen.queryByText(/Dave.*white.*CH 9/)).toBeNull();

    // Only once the parent re-renders with the new participant (as the real session would,
    // after participant-joined round-trips through pull/WS) does the row show up.
    cleanup();
    const withDave = baseState({ participants: [...baseState().participants, participant(golferId("dave-ghost"), "Dave", "white", 9)] });
    renderPanel({ state: withDave, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onAddParticipant: noopAddParticipant });
    expect(screen.getByText(/Dave.*white.*CH 9/)).toBeTruthy();
  });

  // Papercut 3 (M9 hardening): a Saturday roster is almost always the same tee — retyping it
  // for every player added in a row is the papercut. Only the identity fields (name/selection)
  // reset after a successful add; tee/courseHandicap survive.
  it("keeps tee/courseHandicap after a successful add — only name/selection reset (papercut 3)", async () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onAddParticipant: noopAddParticipant });

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Dave" } });
    fireEvent.change(screen.getByLabelText(/^tee$/i), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: /^add player$/i }));

    await waitFor(() => expect(noopAddParticipant).toHaveBeenCalledTimes(1));

    expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe(""); // identity resets
    expect((screen.getByLabelText(/^tee$/i) as HTMLInputElement).value).toBe("white"); // tee SURVIVES
    expect((screen.getByLabelText(/course handicap/i) as HTMLInputElement).value).toBe("9"); // CH SURVIVES

    // A second player only needs a name typed — tee/CH are already right from the last add.
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Erin" } });
    fireEvent.click(screen.getByRole("button", { name: /^add player$/i }));
    await waitFor(() => expect(noopAddParticipant).toHaveBeenCalledTimes(2));
    expect(noopAddParticipant.mock.calls[1]![0]).toEqual({ name: "Erin", tee: "white", courseHandicap: 9 });
  });

  // Papercut 12 (M9 hardening, the never-raw-caught.message sweep): this form used to catch
  // `instanceof Error`, which also matches a generic runtime exception (a bug, a network
  // TypeError) — not just the wire-honest ApiError the rest of the app disciplines itself to.
  it("never renders a raw generic Error's message — only an honest fallback (papercut 12)", async () => {
    const rejecting = vi.fn().mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'foo')"));
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onAddParticipant: rejecting });

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Dave" } });
    fireEvent.change(screen.getByLabelText(/^tee$/i), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: /^add player$/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toBe("Could not add the player — try again.");
    expect(document.body.textContent).not.toMatch(/Cannot read properties/);
  });

  it("no crewId on the round: no 'From your crew' quick-add section renders, even when signed in", async () => {
    signIn();
    // AuthProvider's own once-per-session GET /me fires on sign-in (useAuth.ts) — stubbed so
    // it resolves instead of hitting a real, unstubbed fetch (this test cares about the
    // ABSENCE of a crew fetch, not about the golfer identity itself).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(200, { golfer: null })),
    );
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onAddParticipant: noopAddParticipant });

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith(expect.stringContaining("/me"), expect.anything()));
    expect(screen.queryByText(/from your crew/i)).toBeNull();
    expect(screen.getByLabelText(/^name$/i)).toBeTruthy(); // the free-text form is still there
    // No crewId on the round -> the crew fetch is never attempted at all (not even a failed one).
    expect(vi.mocked(fetch)).not.toHaveBeenCalledWith(expect.stringContaining("/crews/"), expect.anything());
  });

  it("crew round: the crew's not-yet-in-round members render FIRST as one-tap quick-adds carrying their stable golferId; already-in-round members are excluded", async () => {
    signIn();
    const crew = makeCrewId("crew-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        if (path === `/crews/${crew}`) {
          return fakeResponse(200, {
            crew: {
              crewId: crew,
              name: "Sunday crew",
              joinCode: "SUN001",
              members: [
                { golferId: "ann", name: "Ann", role: "organizer", claimed: true }, // already in this round
                { golferId: "dave-crew", name: "Dave", role: "member", claimed: false }, // not yet in this round
              ],
            },
          });
        }
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderPanel({ state: baseState({ crewId: crew }), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onAddParticipant: noopAddParticipant });

    const daveButton = await screen.findByRole("button", { name: "Dave" });
    expect(screen.queryByRole("button", { name: "Ann" })).toBeNull(); // Ann's already in the round — not a quick-add candidate

    fireEvent.click(daveButton);
    expect(screen.getByText(/adding dave/i)).toBeTruthy();
    // The free-text Name field is replaced while a crew member is selected (mirrors the
    // as-self "Playing as" swap's own grammar) — no separate typed name for a quick-add.
    expect(screen.queryByLabelText(/^name$/i)).toBeNull();

    fireEvent.change(screen.getByLabelText(/^tee$/i), { target: { value: "white" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: /^add player$/i }));

    await waitFor(() => expect(noopAddParticipant).toHaveBeenCalledTimes(1));
    // The STABLE golferId travels with the quick-add, not a freshly-typed name alone.
    expect(noopAddParticipant.mock.calls[0]![0]).toEqual({ name: "Dave", tee: "white", courseHandicap: 12, golferId: "dave-crew" });
  });

  // The crew fetch is a nicety, never a gate (JoinRoundPage's peek-fallback precedent): a
  // non-member participant, a signed-out device, or a network failure must all degrade
  // silently to the free-text ghost form alone.
  it("a failed crew fetch (non-member 403, network failure, whatever) degrades silently to the free-text form alone", async () => {
    signIn();
    const crew = makeCrewId("crew-2");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(403, { code: "not-a-member", message: "not a member of this crew" })),
    );

    renderPanel({ state: baseState({ crewId: crew }), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onAddParticipant: noopAddParticipant });

    await waitFor(() => expect(screen.getByLabelText(/^name$/i)).toBeTruthy());
    expect(screen.queryByText(/from your crew/i)).toBeNull();

    // The free-text path still works exactly as it would with no crew at all.
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Fran" } });
    fireEvent.change(screen.getByLabelText(/^tee$/i), { target: { value: "blue" } });
    fireEvent.change(screen.getByLabelText(/course handicap/i), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: /^add player$/i }));

    await waitFor(() => expect(noopAddParticipant).toHaveBeenCalledWith({ name: "Fran", tee: "blue", courseHandicap: 3 }));
  });
});
