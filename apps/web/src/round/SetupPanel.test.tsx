import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureLinks, gameId, golferId, roundId } from "@swng/domain";
import type { GameConfig, Participant, RoundState } from "@swng/domain";
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
const noopSetHandicap = vi.fn().mockResolvedValue(undefined);

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
  noopSetHandicap.mockClear();
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SetupPanel", () => {
  it("shows the join code prominently", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetHandicap: noopSetHandicap });

    expect(screen.getByText("ABC123")).toBeTruthy();
  });

  // The standard card (spec 2026-07-19 §2a: the card never changes) — a roster row reads
  // `name — tee — CH X`, full stop, whether or not any game exists.
  it("shows the roster row as `name — tee — CH X`, with no game badges", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetHandicap: noopSetHandicap });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    expect(annRow).toBeTruthy();
    expect(annRow!.textContent).toMatch(/Ann — white — CH 8/);
    expect(screen.queryByText(/^Games/)).toBeNull();
  });

  // accounts-only identity spec §4: a departed participant is NOT removed from the roster — they
  // keep their seat data (their played holes are facts) and gain a "left" marker a present
  // participant never shows.
  it("marks a departed participant with a 'left' marker, keeping their seat data on the roster", () => {
    const state = baseState({
      participants: [participant(ANN, "Ann", "white", 8), { ...participant(BO, "Bo", "white", 4), departed: true }],
    });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetHandicap: noopSetHandicap });

    const boRow = screen.getAllByRole("listitem").find((li) => /Bo — white — CH 4/.test(li.textContent ?? ""));
    expect(boRow).toBeTruthy(); // still on the roster, seat data intact
    expect(within(boRow!).getByText(/^left$/i)).toBeTruthy();

    // A present participant carries no such marker.
    const annRow = screen.getAllByRole("listitem").find((li) => /Ann — white — CH 8/.test(li.textContent ?? ""));
    expect(within(annRow!).queryByText(/^left$/i)).toBeNull();
  });

  // The standard card is game-agnostic (spec 2026-07-19 §2a): a game existing in state.games —
  // terminated or not — never adds a badge, never changes the roster row, and the deleted
  // "Not yet in a game" copy is gone for good.
  it("a game in state.games changes nothing about the roster — no badges, no 'Not yet in a game', even terminated", () => {
    const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN] };
    const state = baseState({ games: [stableford], terminatedGameIds: new Set([stableford.id]) });

    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetHandicap: noopSetHandicap });

    const annRow = screen.getAllByRole("listitem").find((li) => /CH 8/.test(li.textContent ?? ""));
    expect(annRow).toBeTruthy();
    // Scoped to the roster row itself — the Add Game form below also renders a "Stableford"
    // radio-card label, which is a different surface entirely, not a roster badge. The identity
    // line itself is byte-identical; the row also carries an Edit affordance now (mid-round
    // handicap correction spec 2026-07-20), so the match is anchored (with a trailing word
    // boundary, so a regression rendering "CH 85" would fail this), not exact.
    expect(annRow!.textContent).toMatch(/^Ann — white — CH 8\b/);
    expect(screen.queryByText(/Not yet in a game/)).toBeNull();
  });

  // The link sweep (navigation spec, task 6): every rendered noun's name is its address — the
  // roster's own identity row links each golfer's name to /golfers/:golferId, the tee/CH suffix
  // staying plain text.
  it("links each roster name to /golfers/:golferId, leaving the tee/CH suffix as plain text", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetHandicap: noopSetHandicap });

    const annLink = screen.getByRole("link", { name: "Ann" });
    expect(annLink.getAttribute("href")).toBe(`/golfers/${ANN}`);
    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    // Anchored, not exact (mid-round handicap correction spec 2026-07-20 adds an Edit
    // affordance after the identity line) — the tee/CH suffix itself is still plain text. The
    // trailing word boundary catches a regression rendering "CH 85" that a bare start-anchor
    // would miss.
    expect(annRow!.textContent).toMatch(/^Ann — white — CH 8\b/);
  });

  it("renders each participant's identity row exactly once even once games exist — no second, dots-only roster", () => {
    const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN] };
    const state = baseState({ games: [stableford] });

    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetHandicap: noopSetHandicap });

    // Scope to <li> rows specifically (not the Add Game form's player checkboxes, which are
    // <label> elements, not list items) — Ann must appear as exactly one roster row.
    const annRows = screen.getAllByRole("listitem").filter((li) => /Ann/.test(li.textContent ?? ""));
    expect(annRows).toHaveLength(1);
    // And that single row still carries the full identity — tee and courseHandicap didn't
    // get dropped in favor of a dots-only line.
    expect(annRows[0]?.textContent).toMatch(/white/);
    expect(annRows[0]?.textContent).toMatch(/CH 8/);

    // Bo has no game either — still gets an identity row, byte-identical shape.
    const boRows = screen.getAllByRole("listitem").filter((li) => /Bo/.test(li.textContent ?? ""));
    expect(boRows).toHaveLength(1);
    expect(boRows[0]?.textContent).toMatch(/CH 4/);
  });
});

// The wall (accounts-only identity spec §3): nobody puts anyone on a card. The "Add player"
// ghost form is deleted; the join code — already rendered above — is framed as the one way in.
describe("SetupPanel — share the code, not add a player", () => {
  it("frames the join code as the one way in — new players sign up on the way", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetHandicap: noopSetHandicap });

    expect(screen.getByText(/players join with this code — new players create their account on the way/i)).toBeTruthy();
  });

  it("has no 'Add player' ghost form at all — no name field, no Add player button", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetHandicap: noopSetHandicap });

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

    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetHandicap: noopSetHandicap });

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

    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetHandicap: noopSetHandicap });

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
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetHandicap: noopSetHandicap });

    const plusRow = screen.getAllByRole("listitem").find((li) => /Plus/.test(li.textContent ?? ""));
    expect(plusRow).toBeTruthy();
    expect(plusRow!.textContent).toMatch(/CH \+1\b/);
    expect(plusRow!.textContent).not.toMatch(/CH -1/);

    // A normal positive handicap is byte-unchanged — a plain "CH 13", no sign.
    const normRow = screen.getAllByRole("listitem").find((li) => /Norm/.test(li.textContent ?? ""));
    expect(normRow!.textContent).toMatch(/CH 13\b/);
    expect(normRow!.textContent).not.toMatch(/\+/);
  });
});

// Mid-round handicap correction (spec 2026-07-20): the roster row IS the editor — any participant
// corrects any participant's course handicap, retroactively, with no optimistic local write (the
// corrected CH arrives via the fold once the caller sync()s). These tests drive the row's controls
// by accessible name, the e2e-reconciliation lesson.
describe("SetupPanel — mid-round handicap correction (spec 2026-07-20)", () => {
  const PLUS = golferId("plus");

  it("Edit opens an inline editor holding the raw signed CH, with the whole-round teaching line", async () => {
    const user = userEvent.setup();
    const state = baseState({ participants: [participant(PLUS, "Plus", "white", -2), participant(ANN, "Ann", "white", 8)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetHandicap: noopSetHandicap });

    const plusRow = screen.getAllByRole("listitem").find((li) => /Plus/.test(li.textContent ?? ""));
    expect(plusRow).toBeTruthy();
    // A plus handicap renders "CH +2" in the static row (the domain's own sign convention) — but
    // the editable input underneath must hold the RAW signed value the engine consumes: "-2", the
    // editable-input carve-out from the plus-handicap render gate.
    expect(plusRow!.textContent).toMatch(/CH \+2\b/);

    await user.click(within(plusRow!).getByRole("button", { name: "Edit" }));

    const input = within(plusRow!).getByRole("spinbutton", { name: "Course handicap for Plus" });
    expect((input as HTMLInputElement).value).toBe("-2");
    expect(screen.getByText("Strokes apply to the whole round — dots and games update everywhere.")).toBeTruthy();

    // The swap (review finding): the static formatted "CH +2" must NOT still be on screen while
    // the editor holds the raw "-2" underneath it — a plus handicap is exactly where two
    // sign-opposite representations of the same number would otherwise appear at once.
    expect(plusRow!.textContent).not.toMatch(/CH \+2/);

    // Ann's row is untouched — only Plus's row entered edit mode.
    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    expect(within(annRow!).queryByRole("spinbutton")).toBeNull();
    expect(within(annRow!).getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("Save submits the parsed signed integer for THAT golfer and closes the editor", async () => {
    const user = userEvent.setup();
    const state = baseState({ participants: [participant(ANN, "Ann", "white", 8), participant(BO, "Bo", "white", 4)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetHandicap: noopSetHandicap });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    await user.click(within(annRow!).getByRole("button", { name: "Edit" }));

    const input = within(annRow!).getByRole("spinbutton", { name: "Course handicap for Ann" });
    await user.clear(input);
    await user.type(input, "13");
    await user.click(within(annRow!).getByRole("button", { name: "Save" }));

    expect(noopSetHandicap).toHaveBeenCalledTimes(1);
    expect(noopSetHandicap).toHaveBeenCalledWith(ANN, 13);

    // No optimistic local write (the corrected CH arrives via the fold, not local state): the
    // editor closes and the static row reappears showing the UNCHANGED prop value — asserting the
    // spy's args, never the row text, is the point of this test.
    await waitFor(() => expect(within(annRow!).queryByRole("spinbutton")).toBeNull());
    expect(within(annRow!).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByText("Strokes apply to the whole round — dots and games update everywhere.")).toBeNull();
  });

  it("Cancel restores the static row (the swap back) without calling onSetHandicap", async () => {
    const user = userEvent.setup();
    // The plus-handicap fixture is where the swap actually bites: static "CH +2" vs. the raw
    // "-2" the editor holds — Cancel must bring the sign-formatted static text back, not leave
    // the row showing nothing or the raw value.
    const state = baseState({ participants: [participant(PLUS, "Plus", "white", -2), participant(ANN, "Ann", "white", 8)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetHandicap: noopSetHandicap });

    const plusRow = screen.getAllByRole("listitem").find((li) => /Plus/.test(li.textContent ?? ""));
    await user.click(within(plusRow!).getByRole("button", { name: "Edit" }));

    const input = within(plusRow!).getByRole("spinbutton", { name: "Course handicap for Plus" });
    expect(plusRow!.textContent).not.toMatch(/CH \+2/); // swapped out while editing
    await user.clear(input);
    await user.type(input, "99");
    await user.click(within(plusRow!).getByRole("button", { name: "Cancel" }));

    expect(noopSetHandicap).not.toHaveBeenCalled();
    expect(within(plusRow!).queryByRole("spinbutton")).toBeNull();
    // Swapped back: the static "CH +2" text is on screen again, anchored with a word boundary.
    expect(plusRow!.textContent).toMatch(/^Plus — white — CH \+2\b/);
  });

  it("a failed save surfaces the error text and keeps the editor open", async () => {
    const user = userEvent.setup();
    const failingSetHandicap = vi.fn().mockRejectedValue(new Error("network exploded"));
    const state = baseState({ participants: [participant(ANN, "Ann", "white", 8), participant(BO, "Bo", "white", 4)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetHandicap: failingSetHandicap });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    await user.click(within(annRow!).getByRole("button", { name: "Edit" }));

    const input = within(annRow!).getByRole("spinbutton", { name: "Course handicap for Ann" });
    await user.clear(input);
    await user.type(input, "9");
    await user.click(within(annRow!).getByRole("button", { name: "Save" }));

    // Never a raw generic Error's message (papercut 12's own precedent) — an honest fallback,
    // and the editor stays open (retry one tap away).
    expect(await within(annRow!).findByRole("alert")).toBeTruthy();
    expect(within(annRow!).getByRole("alert").textContent).toBe("Could not update the course handicap — try again.");
    expect(document.body.textContent).not.toMatch(/network exploded/);
    expect(within(annRow!).getByRole("spinbutton", { name: "Course handicap for Ann" })).toBeTruthy();
  });

  // Review finding (Minor): a slow save in flight must not be interruptible by switching rows —
  // otherwise save()'s own setEditing(undefined)/setError lands on whichever row is open when the
  // request settles, not necessarily the row that started it. A deferred promise (held open until
  // resolved by hand) exposes the mid-flight window — same fixture shape as HomePage.test.tsx's/
  // CreateRoundPage.test.tsx's own deferred-GET-/me tests, applied here to onSetHandicap.
  it("disables Edit on OTHER rows and Cancel on the editing row while a save is in flight, re-enabling once it settles", async () => {
    const user = userEvent.setup();
    let resolveSetHandicap: (() => void) | undefined;
    const pendingSetHandicap = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSetHandicap = resolve;
        }),
    );
    const state = baseState({ participants: [participant(ANN, "Ann", "white", 8), participant(BO, "Bo", "white", 4)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetHandicap: pendingSetHandicap });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    const boRow = screen.getAllByRole("listitem").find((li) => /Bo/.test(li.textContent ?? ""));
    await user.click(within(annRow!).getByRole("button", { name: "Edit" }));

    const input = within(annRow!).getByRole("spinbutton", { name: "Course handicap for Ann" });
    await user.clear(input);
    await user.type(input, "9");
    await user.click(within(annRow!).getByRole("button", { name: "Save" }));

    // Mid-flight, before resolveSetHandicap fires: Ann's own Cancel is disabled, and Bo's Edit —
    // a DIFFERENT row — is disabled too, so it can't be tapped to open a second editor while
    // Ann's save is still in the air.
    expect((within(annRow!).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(boRow!).getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);

    resolveSetHandicap?.();
    await waitFor(() => expect(within(annRow!).queryByRole("spinbutton")).toBeNull());

    // Settled: Bo's Edit is enabled again.
    expect((within(boRow!).getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
