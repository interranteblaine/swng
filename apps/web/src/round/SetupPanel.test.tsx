import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureLinks, gameId, golferId, roundId } from "@swng/domain";
import { MAX_STROKES } from "@swng/contracts";
import type { GameConfig, RosterEntry, RoundState } from "@swng/domain";
import { ApiError } from "../api";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { SetupPanel } from "./SetupPanel";
import type { SetupPanelProps } from "./SetupPanel";

const ANN = golferId("ann");
const BO = golferId("bo");
const CAL = golferId("cal");
const DEE = golferId("dee");

// A roster seat: name, tee, and the strokes the group typed (spec 2026-07-30 §2) — the whole
// content of the row under test.
const participant = (id: ReturnType<typeof golferId>, name: string, tee: string, strokes: number): RosterEntry => ({
  golferId: id,
  name,
  tee,
  strokes,
});

// The shared roster: 3 / 1 / 6 / 0 strokes on the 9-hole fixtureLinks card, as typed.
const baseState = (overrides: Partial<RoundState> = {}): RoundState => ({
  id: roundId("round-1"),
  status: "live",
  card: fixtureLinks,
  playedAtMs: 1_000,
  participants: [participant(ANN, "Ann", "white", 3), participant(BO, "Bo", "white", 1), participant(CAL, "Cal", "white", 6), participant(DEE, "Dee", "white", 0)],
  games: [],
  cells: {},
  terminatedGameIds: new Set(),
  ...overrides,
});

const noopAddGame = vi.fn().mockResolvedValue(undefined);
const noopSetStrokes = vi.fn().mockResolvedValue(undefined);
const noopSetPlayedAt = vi.fn().mockResolvedValue(undefined);

// SetupPanel no longer touches auth (the claim affordance is gone), but the AuthProvider wrapper
// stays: it lets the signed-in pins below prove that even in the state that USED to render the
// claim button, nothing does — and that SetupPanel fires no fetch of its own.
const renderPanel = (props: SetupPanelProps) =>
  render(
    <MemoryRouter>
      <AuthProvider>
        <SetupPanel {...props} />
      </AuthProvider>
    </MemoryRouter>,
  );

const fakeResponse = (status: number, body: unknown): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const base64url = (obj: unknown): string =>
  btoa(JSON.stringify(obj))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const signIn = () => {
  const idToken = `${base64url({ alg: "none" })}.${base64url({ sub: "sub-1", email: "signed-in@example.com" })}.sig`;
  tokenStore.save({ idToken, refreshToken: "refresh-1", expiresAt: Date.now() + 3_600_000 });
};

beforeEach(() => {
  noopAddGame.mockClear();
  noopSetStrokes.mockClear();
  noopSetPlayedAt.mockClear();
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SetupPanel", () => {
  it("shows the join code prominently", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    expect(screen.getByText("ABC123")).toBeTruthy();
  });

  // Two lines and ONE control (spec 2026-07-30 §8): name + Edit, then `tee · N strokes`. There is
  // one thing to edit, so there is one button — no "normally", no "gets", no second affordance.
  it("shows the roster row as name + Edit over `tee · N strokes`, with no game badges", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    expect(annRow).toBeTruthy();
    expect(within(annRow!).getByText("white · 3 strokes")).toBeTruthy();
    expect(within(annRow!).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(annRow!).queryByRole("button", { name: "Give strokes directly" })).toBeNull();
    expect(annRow!.textContent).not.toMatch(/normally|gets/);
    expect(screen.queryByText(/^Games/)).toBeNull();
  });

  it("says `1 stroke`, not `1 strokes`", () => {
    const state = baseState({ participants: [participant(BO, "Bo", "white", 1)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    const boRow = screen.getAllByRole("listitem").find((li) => /Bo/.test(li.textContent ?? ""));
    expect(within(boRow!).getByText("white · 1 stroke")).toBeTruthy();
  });

  it("shows a zero-stroke seat as `tee · 0 strokes` — the default every seat starts on", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    const deeRow = screen.getAllByRole("listitem").find((li) => /Dee/.test(li.textContent ?? ""));
    expect(within(deeRow!).getByText("white · 0 strokes")).toBeTruthy();
  });

  // accounts-only identity spec §4: a departed participant is NOT removed from the roster — they
  // keep their seat data (their played holes are facts) and gain a "left" marker a present
  // participant never shows.
  it("marks a departed participant with a 'left' marker, keeping their seat data on the roster", () => {
    const state = baseState({
      participants: [participant(ANN, "Ann", "white", 3), { ...participant(BO, "Bo", "white", 1), departed: true }],
    });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    const boRow = screen.getAllByRole("listitem").find((li) => /Bo/.test(li.textContent ?? ""));
    expect(boRow).toBeTruthy(); // still on the roster, seat data intact
    expect(within(boRow!).getByText("white · 1 stroke")).toBeTruthy();
    expect(within(boRow!).getByText(/^left$/i)).toBeTruthy();

    // A present participant carries no such marker.
    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    expect(within(annRow!).queryByText(/^left$/i)).toBeNull();
  });

  // The standard card is game-agnostic (spec 2026-07-19 §2a): a game existing in state.games —
  // terminated or not — never adds a badge, never changes the roster row, and the deleted
  // "Not yet in a game" copy is gone for good.
  it("a game in state.games changes nothing about the roster — no badges, no 'Not yet in a game', even terminated", () => {
    const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN] };
    const state = baseState({ games: [stableford], terminatedGameIds: new Set([stableford.id]) });

    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    expect(annRow).toBeTruthy();
    // Scoped to the roster row itself — the Add Game form below also renders a "Stableford"
    // radio-card label, which is a different surface entirely, not a roster badge. The facts line
    // is EXACT: a regression rendering "30 strokes" would fail this.
    expect(within(annRow!).getByText("white · 3 strokes")).toBeTruthy();
    expect(screen.queryByText(/Not yet in a game/)).toBeNull();
  });

  // The link sweep (navigation spec, task 6): every rendered noun's name is its address — the
  // roster's own identity row links each golfer's name to /golfers/:golferId, the tee/CH suffix
  // staying plain text.
  it("links each roster name to /golfers/:golferId, leaving the tee/CH suffix as plain text", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    const annLink = screen.getByRole("link", { name: "Ann" });
    expect(annLink.getAttribute("href")).toBe(`/golfers/${ANN}`);
    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    // The facts line below the name stays plain text — only the name is a link.
    expect(within(annRow!).getByText("white · 3 strokes")).toBeTruthy();
    expect(within(annRow!).queryByRole("link", { name: /strokes/ })).toBeNull();
  });

  it("renders each participant's identity row exactly once even once games exist — no second, dots-only roster", () => {
    const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN] };
    const state = baseState({ games: [stableford] });

    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    // Scope to <li> rows specifically (not the Add Game form's player checkboxes, which are
    // <label> elements, not list items) — Ann must appear as exactly one roster row.
    const annRows = screen.getAllByRole("listitem").filter((li) => /Ann/.test(li.textContent ?? ""));
    expect(annRows).toHaveLength(1);
    // And that single row still carries the full identity — tee and strokes didn't get dropped in
    // favor of a dots-only line.
    expect(annRows[0]?.textContent).toMatch(/white · 3 strokes/);

    // Bo has no game either — still gets an identity row, byte-identical shape.
    const boRows = screen.getAllByRole("listitem").filter((li) => /Bo/.test(li.textContent ?? ""));
    expect(boRows).toHaveLength(1);
    expect(boRows[0]?.textContent).toMatch(/white · 1 stroke/);
  });
});

// The wall (accounts-only identity spec §3): nobody puts anyone on a card. The "Add player"
// ghost form is deleted; the join code — already rendered above — is framed as the one way in.
describe("SetupPanel — share the code, not add a player", () => {
  it("frames the join code as the one way in — new players sign up on the way", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    expect(screen.getByText(/players join with this code — new players create their account on the way/i)).toBeTruthy();
  });

  it("has no 'Add player' ghost form at all — no name field, no Add player button", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

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

    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

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
      if (path === "/me") return fakeResponse(200, { golfer: { golferId: "ann", name: "Ann" } });
      throw new Error(`unexpected fetch ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/me"), expect.anything()));
    // Every fetch the whole tree ever made was the AuthProvider's GET /me — SetupPanel itself
    // reached no endpoint (no /players, no /share, no /crews).
    for (const call of fetchMock.mock.calls) expect(new URL(String(call[0])).pathname).toBe("/me");
  });
});

// The joinCode-in-JoinRoundResponse arc (spec 2026-07-20 §2/§3): the join code panel is also the
// invite panel — a golfer already on the card can hand the code to the next player as a link, not
// just a code to retype. Derived on THIS device's own origin (never minted server-side), same
// discipline as ShareButton's own clipboard idiom.
describe("SetupPanel — Copy invite link", () => {
  it("Copy invite link copies the origin-relative join URL and shows Link copied with the url", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    fireEvent.click(screen.getByRole("button", { name: "Copy invite link" }));

    // No trailing space in the pattern (ShareButton.test.tsx's own idiom, same reason): the URL
    // lives in a sibling <span>, so this <p>'s own direct text node is "Link copied — " — and
    // dom-testing-library's default normalizer TRIMS that node's text before matching, so a
    // pattern requiring the trailing space right before the (sibling, not-included) url never
    // matches.
    await screen.findByText(/Link copied —/);
    const url = `${window.location.origin}/join?code=ABC123`;
    expect(writeText).toHaveBeenCalledWith(url);
    expect(screen.getByText(url)).toBeTruthy();
  });

  it("still shows the raw url with 'Copy this link' when clipboard access fails", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    fireEvent.click(screen.getByRole("button", { name: "Copy invite link" }));

    await screen.findByText(/Copy this link —/);
    expect(screen.getByText(`${window.location.origin}/join?code=ABC123`)).toBeTruthy();
  });

  it("hides Copy invite link entirely on an empty cached code (legacy re-mint credential)", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    expect(screen.queryByRole("button", { name: "Copy invite link" })).toBeNull();
  });
});

// Setting a player's strokes (spec 2026-07-30 §2/§8): the roster row IS the editor — any
// participant sets any participant's number, retroactively, with no optimistic local write (the
// change arrives via the fold once the caller sync()s). ONE control, because there is one thing to
// edit. These tests drive the row's controls by accessible name, the e2e-reconciliation lesson.
describe("SetupPanel — setting a player's strokes", () => {
  it("Edit opens an inline editor holding the seat's current number, with its teaching line", async () => {
    const user = userEvent.setup();
    const state = baseState({ participants: [participant(ANN, "Ann", "white", 3), participant(BO, "Bo", "white", 1)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    expect(annRow).toBeTruthy();
    await user.click(within(annRow!).getByRole("button", { name: "Edit" }));

    const input = within(annRow!).getByRole("spinbutton", { name: "Strokes for Ann" });
    expect((input as HTMLInputElement).value).toBe("3");
    expect(screen.getByText("Strokes apply to the whole round — dots and games update everywhere.")).toBeTruthy();

    // The swap (2026-07-20 review finding): the static facts line must NOT still be on screen
    // while the editor holds the same number — two representations of one value at once.
    expect(within(annRow!).queryByText("white · 3 strokes")).toBeNull();

    // Bo's row is untouched — only Ann's row entered edit mode.
    const boRow = screen.getAllByRole("listitem").find((li) => /Bo/.test(li.textContent ?? ""));
    expect(within(boRow!).queryByRole("spinbutton")).toBeNull();
    expect(within(boRow!).getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("Save submits the typed number for THAT golfer and closes the editor", async () => {
    const user = userEvent.setup();
    const state = baseState({ participants: [participant(ANN, "Ann", "white", 3), participant(BO, "Bo", "white", 1)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    await user.click(within(annRow!).getByRole("button", { name: "Edit" }));

    const input = within(annRow!).getByRole("spinbutton", { name: "Strokes for Ann" });
    await user.clear(input);
    await user.type(input, "20");
    await user.click(within(annRow!).getByRole("button", { name: "Save" }));

    expect(noopSetStrokes).toHaveBeenCalledTimes(1);
    expect(noopSetStrokes).toHaveBeenCalledWith(ANN, 20);

    // No optimistic local write (the change arrives via the fold, not local state): the editor
    // closes and the static row reappears showing the UNCHANGED prop value — asserting the spy's
    // args, never the row text, is the point of this test.
    await waitFor(() => expect(within(annRow!).queryByRole("spinbutton")).toBeNull());
    expect(within(annRow!).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByText("Strokes apply to the whole round — dots and games update everywhere.")).toBeNull();
  });

  it("Cancel restores the static row (the swap back) without calling onSetStrokes", async () => {
    const user = userEvent.setup();
    const state = baseState({ participants: [participant(ANN, "Ann", "white", 3), participant(BO, "Bo", "white", 1)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    await user.click(within(annRow!).getByRole("button", { name: "Edit" }));

    const input = within(annRow!).getByRole("spinbutton", { name: "Strokes for Ann" });
    expect(within(annRow!).queryByText("white · 3 strokes")).toBeNull(); // swapped out while editing
    await user.clear(input);
    await user.type(input, "99");
    await user.click(within(annRow!).getByRole("button", { name: "Cancel" }));

    expect(noopSetStrokes).not.toHaveBeenCalled();
    expect(within(annRow!).queryByRole("spinbutton")).toBeNull();
    // Swapped back: the static text is on screen again, at its unchanged value.
    expect(within(annRow!).getByText("white · 3 strokes")).toBeTruthy();
  });

  it("a failed save surfaces the error text and keeps the editor open", async () => {
    const user = userEvent.setup();
    const failingSetStrokes = vi.fn().mockRejectedValue(new Error("network exploded"));
    const state = baseState({ participants: [participant(ANN, "Ann", "white", 3), participant(BO, "Bo", "white", 1)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: failingSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    await user.click(within(annRow!).getByRole("button", { name: "Edit" }));

    const input = within(annRow!).getByRole("spinbutton", { name: "Strokes for Ann" });
    await user.clear(input);
    await user.type(input, "9");
    await user.click(within(annRow!).getByRole("button", { name: "Save" }));

    // Never a raw generic Error's message (papercut 12's own precedent) — an honest fallback,
    // and the editor stays open (retry one tap away).
    expect(await within(annRow!).findByRole("alert")).toBeTruthy();
    expect(within(annRow!).getByRole("alert").textContent).toBe("Could not update this player's strokes — try again.");
    expect(document.body.textContent).not.toMatch(/network exploded/);
    expect(within(annRow!).getByRole("spinbutton", { name: "Strokes for Ann" })).toBeTruthy();
  });

  // Review finding (Minor): a slow save in flight must not be interruptible by switching rows —
  // otherwise save()'s own setEditing(undefined)/setError lands on whichever row is open when the
  // request settles, not necessarily the row that started it. A deferred promise (held open until
  // resolved by hand) exposes the mid-flight window — same fixture shape as HomePage.test.tsx's/
  // CreateRoundPage.test.tsx's own deferred-GET-/me tests, applied here to onSetStrokes.
  it("disables Edit on OTHER rows and Cancel on the editing row while a save is in flight, re-enabling once it settles", async () => {
    const user = userEvent.setup();
    let resolveSetStrokes: (() => void) | undefined;
    const pendingSetStrokes = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSetStrokes = resolve;
        }),
    );
    const state = baseState({ participants: [participant(ANN, "Ann", "white", 3), participant(BO, "Bo", "white", 1)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: pendingSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    const boRow = screen.getAllByRole("listitem").find((li) => /Bo/.test(li.textContent ?? ""));
    await user.click(within(annRow!).getByRole("button", { name: "Edit" }));

    const input = within(annRow!).getByRole("spinbutton", { name: "Strokes for Ann" });
    await user.clear(input);
    await user.type(input, "9");
    await user.click(within(annRow!).getByRole("button", { name: "Save" }));

    // Mid-flight, before resolveSetStrokes fires: Ann's own Cancel is disabled, and Bo's Edit —
    // a DIFFERENT row — is disabled too, so it can't be tapped to open a second editor while
    // Ann's save is still in the air.
    expect((within(annRow!).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(boRow!).getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);

    resolveSetStrokes?.();
    await waitFor(() => expect(within(annRow!).queryByRole("spinbutton")).toBeNull());

    // Settled: Bo's Edit is enabled again.
    expect((within(boRow!).getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(false);
  });

  // Nobody gives strokes back (spec 2026-07-30 §2), so a negative is an illegal state the editor
  // declines to OFFER rather than reporting after a round trip against commands.ts's own min(0).
  it("refuses a negative — Save stays disabled, nothing is posted, and the input floors at 0", async () => {
    const user = userEvent.setup();
    const state = baseState({ participants: [participant(ANN, "Ann", "white", 3)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    await user.click(within(annRow!).getByRole("button", { name: "Edit" }));

    const input = within(annRow!).getByRole("spinbutton", { name: "Strokes for Ann" });
    expect(input.getAttribute("min")).toBe("0");

    await user.clear(input);
    await user.type(input, "-3");
    expect((within(annRow!).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(annRow!).getByRole("button", { name: "Save" }));
    expect(noopSetStrokes).not.toHaveBeenCalled();

    // 0 is legal — the floor is at zero, not above it.
    await user.clear(input);
    await user.type(input, "0");
    expect((within(annRow!).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(within(annRow!).getByRole("button", { name: "Save" }));
    expect(noopSetStrokes).toHaveBeenCalledWith(ANN, 0);
  });

  // The wire's ceiling reaches the control (review fix round 1): a bare digits-only predicate let
  // "60" enable Save, which POSTed, 400'd, and showed a generic "try again" that could never
  // succeed. Same defect class the prior arc caught here one bound over, on the floor. Written
  // against MAX_STROKES rather than literals so the control and the wire cannot drift apart when
  // the ceiling moves (it moved from 54 to 100 in the whole-branch fix wave, Minor 7).
  it("refuses a number above the wire's ceiling — Save stays disabled one over, enabled at the ceiling", async () => {
    const user = userEvent.setup();
    const state = baseState({ participants: [participant(ANN, "Ann", "white", 3)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    await user.click(within(annRow!).getByRole("button", { name: "Edit" }));

    const input = within(annRow!).getByRole("spinbutton", { name: "Strokes for Ann" });
    // The browser's own validation carries the same ceiling, not just the predicate.
    expect(input.getAttribute("max")).toBe(String(MAX_STROKES));

    await user.clear(input);
    await user.type(input, String(MAX_STROKES + 1));
    expect((within(annRow!).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(annRow!).getByRole("button", { name: "Save" }));
    expect(noopSetStrokes).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, String(MAX_STROKES));
    expect((within(annRow!).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(within(annRow!).getByRole("button", { name: "Save" }));
    expect(noopSetStrokes).toHaveBeenCalledWith(ANN, MAX_STROKES);
  });

  // The defect behind Minor 7: refusing the value was right, refusing it SILENTLY was not. Save
  // going dead with nothing on screen is a dead end — the golfer cannot tell a rejected value from
  // a broken button. One sentence, stating the whole legal range, for every illegal shape.
  it("says WHY Save is disabled while the field holds an illegal value, and stops once it is legal", async () => {
    const user = userEvent.setup();
    const state = baseState({ participants: [participant(ANN, "Ann", "white", 3)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    await user.click(within(annRow!).getByRole("button", { name: "Edit" }));
    const input = within(annRow!).getByRole("spinbutton", { name: "Strokes for Ann" });
    const reason = `Enter a whole number from 0 to ${MAX_STROKES}.`;

    // Seeded with the seat's own legal number: nothing to say yet.
    expect(within(annRow!).queryByText(reason)).toBeNull();

    // Over the ceiling, fractional, and negative all get the same true sentence — it states the
    // range rather than guessing which of the three mistakes was made.
    for (const illegal of [String(MAX_STROKES + 1), "12.5", "-3"]) {
      await user.clear(input);
      await user.type(input, illegal);
      expect(within(annRow!).getByText(reason)).toBeTruthy();
      expect((within(annRow!).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
      // The input names it as its own constraint (a11y), rather than firing an alert per keystroke.
      expect(input.getAttribute("aria-describedby")).toBe(within(annRow!).getByText(reason).id);
    }

    // An EMPTY field mid-edit is not a mistake to scold — Save is still disabled, silently.
    await user.clear(input);
    expect(within(annRow!).queryByText(reason)).toBeNull();
    expect((within(annRow!).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

    // Legal again: the reason goes away and the control comes back.
    await user.type(input, "12");
    expect(within(annRow!).queryByText(reason)).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBeNull();
    expect((within(annRow!).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("refuses a fractional number too — a stroke count is whole", async () => {
    const user = userEvent.setup();
    const state = baseState({ participants: [participant(ANN, "Ann", "white", 3)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    await user.click(within(annRow!).getByRole("button", { name: "Edit" }));

    const input = within(annRow!).getByRole("spinbutton", { name: "Strokes for Ann" });
    await user.clear(input);
    await user.type(input, "12.5");
    expect((within(annRow!).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(noopSetStrokes).not.toHaveBeenCalled();
  });
});

// The round's own played date (round-played-date spec 2026-08-01 §3b/§5), correctable while
// live — the SAME roster-strokes-editor idiom applied to a round-level fact, so these mirror the
// "setting a player's strokes" tests above one for one.
describe("SetupPanel — the played date", () => {
  const region = () => screen.getByRole("region", { name: "Date played" });

  it("Edit opens a datetime-local editor holding the round's own value; the static line and the editor are mutually exclusive", async () => {
    const user = userEvent.setup();
    const playedAtMs = new Date(2026, 5, 12, 9, 30, 0, 0).getTime();
    const state = baseState({ playedAtMs });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    expect(within(region()).getByText(/Jun 12, 2026/)).toBeTruthy();
    expect(within(region()).queryByLabelText("Date played")).toBeNull();

    await user.click(within(region()).getByRole("button", { name: "Edit" }));

    const input = within(region()).getByLabelText("Date played") as HTMLInputElement;
    expect(input.value).toBe("2026-06-12T09:30");

    // The swap (2026-07-20 review finding, applied here): the static line must NOT still be on
    // screen while the editor holds the same value — two representations of one value at once.
    expect(within(region()).queryByText(/Jun 12, 2026/)).toBeNull();
  });

  it("Save submits the instant shown in the field and closes the editor — no optimistic write", async () => {
    const user = userEvent.setup();
    const playedAtMs = new Date(2026, 5, 12, 9, 30, 0, 0).getTime();
    const state = baseState({ playedAtMs });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    await user.click(within(region()).getByRole("button", { name: "Edit" }));
    const input = within(region()).getByLabelText("Date played");
    // A back-date, crossing a calendar day AND a different time of day than the seeded value —
    // the pin that fails if Save ever sends something other than exactly what the field shows.
    fireEvent.change(input, { target: { value: "2026-06-09T07:00" } });
    await user.click(within(region()).getByRole("button", { name: "Save" }));

    expect(noopSetPlayedAt).toHaveBeenCalledTimes(1);
    expect(noopSetPlayedAt).toHaveBeenCalledWith(new Date(2026, 5, 9, 7, 0, 0, 0).getTime());

    // No optimistic local write (the change arrives via the fold, not local state): the editor
    // closes and the static line reappears showing the UNCHANGED prop value — asserting the
    // spy's args, never the rendered text, is the point of the assertion above.
    await waitFor(() => expect(within(region()).queryByLabelText("Date played")).toBeNull());
    expect(within(region()).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(region()).getByText(/Jun 12, 2026/)).toBeTruthy();
  });

  it("Cancel restores the static line (the swap back) without calling onSetPlayedAt", async () => {
    const user = userEvent.setup();
    const playedAtMs = new Date(2026, 5, 12, 9, 30, 0, 0).getTime();
    const state = baseState({ playedAtMs });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    await user.click(within(region()).getByRole("button", { name: "Edit" }));
    const input = within(region()).getByLabelText("Date played");
    expect(within(region()).queryByText(/Jun 12, 2026/)).toBeNull(); // swapped out while editing
    fireEvent.change(input, { target: { value: "2020-01-01T00:00" } });
    await user.click(within(region()).getByRole("button", { name: "Cancel" }));

    expect(noopSetPlayedAt).not.toHaveBeenCalled();
    expect(within(region()).queryByLabelText("Date played")).toBeNull();
    // Swapped back: the static text is on screen again, at its unchanged value.
    expect(within(region()).getByText(/Jun 12, 2026/)).toBeTruthy();
  });

  it("a failed save surfaces the error text and keeps the editor open", async () => {
    const user = userEvent.setup();
    const failingSetPlayedAt = vi.fn().mockRejectedValue(new Error("network exploded"));
    const state = baseState({ playedAtMs: new Date(2026, 5, 12, 9, 30, 0, 0).getTime() });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: failingSetPlayedAt });

    await user.click(within(region()).getByRole("button", { name: "Edit" }));
    // A genuine edit (Minor 5, task-7 review): Save with no change closes the editor without
    // calling onSetPlayedAt at all, which would make this failure path unreachable.
    const input = within(region()).getByLabelText("Date played");
    fireEvent.change(input, { target: { value: "2026-06-09T07:00" } });
    await user.click(within(region()).getByRole("button", { name: "Save" }));

    // Never a raw generic Error's message (papercut 12's own precedent) — an honest fallback,
    // and the editor stays open (retry one tap away).
    expect(await within(region()).findByRole("alert")).toBeTruthy();
    expect(within(region()).getByRole("alert").textContent).toBe("Could not update the played date — try again.");
    expect(document.body.textContent).not.toMatch(/network exploded/);
    expect(within(region()).getByLabelText("Date played")).toBeTruthy();
  });

  // Important 1 (task-7 review): the generic "try again" line is a dead end for a wire
  // rejection — this editor deliberately validates nothing beyond "non-empty, parseable" (a
  // second UI-side ceiling duplicating the wire's own bound is forbidden, the strokes editor's
  // own precedent), so a too-far-future/too-old playedAtMs, or a 409 once another device
  // finalizes the round first, are first-class reachable outcomes, not hypotheticals — "try
  // again" can never succeed for either. Same fix, same idiom as CreateRoundPage.tsx's own
  // submit: the server's own message reaches the screen when the rejection is an ApiError.
  it("a rejected ApiError surfaces the server's own message, not the generic fallback", async () => {
    const user = userEvent.setup();
    const failingSetPlayedAt = vi.fn().mockRejectedValue(new ApiError("invalid-request", 400, "playedAtMs: playedAtMs is too far in the future"));
    const state = baseState({ playedAtMs: new Date(2026, 5, 12, 9, 30, 0, 0).getTime() });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: failingSetPlayedAt });

    await user.click(within(region()).getByRole("button", { name: "Edit" }));
    const input = within(region()).getByLabelText("Date played");
    fireEvent.change(input, { target: { value: "2062-06-12T09:30" } });
    await user.click(within(region()).getByRole("button", { name: "Save" }));

    expect(await within(region()).findByRole("alert")).toBeTruthy();
    // The server's real message, not "Could not update the played date — try again." — that
    // fallback can never succeed on retry for exactly this rejection.
    expect(within(region()).getByRole("alert").textContent).toBe("playedAtMs: playedAtMs is too far in the future");
    expect(within(region()).getByLabelText("Date played")).toBeTruthy(); // editor stays open
  });

  it("refuses an empty field — Save stays disabled and nothing is posted", async () => {
    const user = userEvent.setup();
    const state = baseState({ playedAtMs: new Date(2026, 5, 12, 9, 30, 0, 0).getTime() });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    await user.click(within(region()).getByRole("button", { name: "Edit" }));
    const input = within(region()).getByLabelText("Date played");
    fireEvent.change(input, { target: { value: "" } });

    expect((within(region()).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(region()).getByRole("button", { name: "Save" }));
    expect(noopSetPlayedAt).not.toHaveBeenCalled();
  });

  // Minor 5 (task-7 review): toDatetimeLocalValue drops seconds (a datetime-local input can't
  // display them), so a round created with sub-minute precision would get its stored instant
  // silently rewritten up to 59.999s earlier by a Save the golfer typed nothing into. A Save
  // that alters stored data when nothing changed is worth not having — Edit then Save with no
  // edit in between must be a no-op, not a network round trip.
  it("Save with no change closes the editor without calling onSetPlayedAt", async () => {
    const user = userEvent.setup();
    // Sub-minute precision (12.345s) the datetime-local field cannot show — exactly the value a
    // round-created-with-no-explicit-playedAtMs carries, and exactly what a no-op Save must not
    // silently round away.
    const playedAtMs = new Date(2026, 5, 12, 9, 30, 12, 345).getTime();
    const state = baseState({ playedAtMs });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetStrokes: noopSetStrokes, onSetPlayedAt: noopSetPlayedAt });

    await user.click(within(region()).getByRole("button", { name: "Edit" }));
    await user.click(within(region()).getByRole("button", { name: "Save" }));

    expect(noopSetPlayedAt).not.toHaveBeenCalled();
    await waitFor(() => expect(within(region()).queryByLabelText("Date played")).toBeNull());
    expect(within(region()).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(region()).getByText(/Jun 12, 2026/)).toBeTruthy();
  });
});
