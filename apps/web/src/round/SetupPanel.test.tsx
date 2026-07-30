import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureLinks, gameId, golferId, roundId } from "@swng/domain";
import type { GameConfig, RosterEntry, RoundState } from "@swng/domain";
import { AuthProvider } from "../auth/useAuth";
import { tokenStore } from "../auth/tokenStore";
import { createMemoryStorage } from "../testSupport/memoryStorage";
import { SetupPanel } from "./SetupPanel";
import type { SetupPanelProps } from "./SetupPanel";

const ANN = golferId("ann");
const BO = golferId("bo");
const CAL = golferId("cal");
const DEE = golferId("dee");

// `overPar` is what the seat STATED; `strokes` is what the fold derived for it across the whole
// roster (spec 2026-07-29 §2b). The row renders both, so both are given per seat rather than one
// being inferred here.
const participant = (id: ReturnType<typeof golferId>, name: string, tee: string, overPar: number, strokes: number): RosterEntry => ({
  golferId: id,
  name,
  tee,
  basis: { kind: "normally-shoots", overPar },
  strokes,
});

// The shared roster: stated +8/+4/+14/+2 on the 9-hole fixtureLinks card. Dee's +2 anchors the
// field, so the fold halves each difference once at the end — 3 / 1 / 6 / 0.
const baseState = (overrides: Partial<RoundState> = {}): RoundState => ({
  id: roundId("round-1"),
  status: "live",
  card: fixtureLinks,
  participants: [participant(ANN, "Ann", "white", 8, 3), participant(BO, "Bo", "white", 4, 1), participant(CAL, "Cal", "white", 14, 6), participant(DEE, "Dee", "white", 2, 0)],
  games: [],
  cells: {},
  terminatedGameIds: new Set(),
  ...overrides,
});

const noopAddGame = vi.fn().mockResolvedValue(undefined);
const noopSetBasis = vi.fn().mockResolvedValue(undefined);

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
  noopSetBasis.mockClear();
  vi.stubGlobal("localStorage", createMemoryStorage());
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SetupPanel", () => {
  it("shows the join code prominently", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: noopSetBasis });

    expect(screen.getByText("ABC123")).toBeTruthy();
  });

  // The standard card (spec 2026-07-19 §2a: the card never changes) — a roster row reads
  // `name — tee — normally +N · gets M`, full stop, whether or not any game exists: what the
  // player STATED and what the whole field's rule turned it into (spec 2026-07-29 §2).
  it("shows the roster row as `name — tee — normally +N · gets M`, with no game badges", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: noopSetBasis });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    expect(annRow).toBeTruthy();
    expect(annRow!.textContent).toMatch(/Ann — white — normally \+8 · gets 3/);
    expect(screen.queryByText(/^Games/)).toBeNull();
  });

  // A seat that stated its strokes DIRECTLY (spec 2026-07-29 §2a's second constructor — "just give
  // him 18") has no normal score to show, so the row says where the number came from rather than
  // implying one was measured.
  it("shows a directly-given seat as `gets M (given directly)`, with no 'normally' claim", () => {
    const given: RosterEntry = { golferId: ANN, name: "Ann", tee: "white", basis: { kind: "strokes", strokes: 18 }, strokes: 18 };
    renderPanel({ state: baseState({ participants: [given] }), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: noopSetBasis });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    expect(annRow!.textContent).toMatch(/Ann — white — gets 18 \(given directly\)/);
    expect(annRow!.textContent).not.toMatch(/normally/);
  });

  // accounts-only identity spec §4: a departed participant is NOT removed from the roster — they
  // keep their seat data (their played holes are facts) and gain a "left" marker a present
  // participant never shows.
  it("marks a departed participant with a 'left' marker, keeping their seat data on the roster", () => {
    const state = baseState({
      participants: [participant(ANN, "Ann", "white", 8, 3), { ...participant(BO, "Bo", "white", 4, 1), departed: true }],
    });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: noopSetBasis });

    const boRow = screen.getAllByRole("listitem").find((li) => /Bo — white — normally \+4 · gets 1/.test(li.textContent ?? ""));
    expect(boRow).toBeTruthy(); // still on the roster, seat data intact
    expect(within(boRow!).getByText(/^left$/i)).toBeTruthy();

    // A present participant carries no such marker.
    const annRow = screen.getAllByRole("listitem").find((li) => /Ann — white — normally \+8 · gets 3/.test(li.textContent ?? ""));
    expect(within(annRow!).queryByText(/^left$/i)).toBeNull();
  });

  // The standard card is game-agnostic (spec 2026-07-19 §2a): a game existing in state.games —
  // terminated or not — never adds a badge, never changes the roster row, and the deleted
  // "Not yet in a game" copy is gone for good.
  it("a game in state.games changes nothing about the roster — no badges, no 'Not yet in a game', even terminated", () => {
    const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN] };
    const state = baseState({ games: [stableford], terminatedGameIds: new Set([stableford.id]) });

    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: noopSetBasis });

    const annRow = screen.getAllByRole("listitem").find((li) => /normally \+8/.test(li.textContent ?? ""));
    expect(annRow).toBeTruthy();
    // Scoped to the roster row itself — the Add Game form below also renders a "Stableford"
    // radio-card label, which is a different surface entirely, not a roster badge. The identity
    // line itself is unchanged by any game; the row also carries the correction affordances
    // (spec 2026-07-20), so the match is anchored (with a trailing word boundary, so a regression
    // rendering "gets 35" would fail this), not exact.
    expect(annRow!.textContent).toMatch(/^Ann — white — normally \+8 · gets 3\b/);
    expect(screen.queryByText(/Not yet in a game/)).toBeNull();
  });

  // The link sweep (navigation spec, task 6): every rendered noun's name is its address — the
  // roster's own identity row links each golfer's name to /golfers/:golferId, the tee/CH suffix
  // staying plain text.
  it("links each roster name to /golfers/:golferId, leaving the tee/CH suffix as plain text", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: noopSetBasis });

    const annLink = screen.getByRole("link", { name: "Ann" });
    expect(annLink.getAttribute("href")).toBe(`/golfers/${ANN}`);
    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    // Anchored, not exact (spec 2026-07-20's correction affordances follow the identity line) —
    // the tee/strokes suffix itself is still plain text. The trailing word boundary catches a
    // regression rendering "gets 35" that a bare start-anchor would miss.
    expect(annRow!.textContent).toMatch(/^Ann — white — normally \+8 · gets 3\b/);
  });

  it("renders each participant's identity row exactly once even once games exist — no second, dots-only roster", () => {
    const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN] };
    const state = baseState({ games: [stableford] });

    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: noopSetBasis });

    // Scope to <li> rows specifically (not the Add Game form's player checkboxes, which are
    // <label> elements, not list items) — Ann must appear as exactly one roster row.
    const annRows = screen.getAllByRole("listitem").filter((li) => /Ann/.test(li.textContent ?? ""));
    expect(annRows).toHaveLength(1);
    // And that single row still carries the full identity — tee, stated number and strokes didn't
    // get dropped in favor of a dots-only line.
    expect(annRows[0]?.textContent).toMatch(/white/);
    expect(annRows[0]?.textContent).toMatch(/normally \+8 · gets 3/);

    // Bo has no game either — still gets an identity row, byte-identical shape.
    const boRows = screen.getAllByRole("listitem").filter((li) => /Bo/.test(li.textContent ?? ""));
    expect(boRows).toHaveLength(1);
    expect(boRows[0]?.textContent).toMatch(/normally \+4 · gets 1/);
  });
});

// The wall (accounts-only identity spec §3): nobody puts anyone on a card. The "Add player"
// ghost form is deleted; the join code — already rendered above — is framed as the one way in.
describe("SetupPanel — share the code, not add a player", () => {
  it("frames the join code as the one way in — new players sign up on the way", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: noopSetBasis });

    expect(screen.getByText(/players join with this code — new players create their account on the way/i)).toBeTruthy();
  });

  it("has no 'Add player' ghost form at all — no name field, no Add player button", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: noopSetBasis });

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

    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: noopSetBasis });

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

    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: noopSetBasis });

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
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: noopSetBasis });

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
    renderPanel({ state: baseState(), games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: noopSetBasis });

    fireEvent.click(screen.getByRole("button", { name: "Copy invite link" }));

    await screen.findByText(/Copy this link —/);
    expect(screen.getByText(`${window.location.origin}/join?code=ABC123`)).toBeTruthy();
  });

  it("hides Copy invite link entirely on an empty cached code (legacy re-mint credential)", () => {
    renderPanel({ state: baseState(), games: [], joinCode: "", onAddGame: noopAddGame, onSetBasis: noopSetBasis });

    expect(screen.queryByRole("button", { name: "Copy invite link" })).toBeNull();
  });
});

// The setup roster is a LIVE render surface, and an UNDER-PAR normal score is where the sign
// convention bites: minus means under par, and under the relative model that player is the field's
// anchor and receives nothing (spec 2026-07-29 §2b/§4 — there is one sign convention now, and
// negative is simply negative).
describe("SetupPanel — an under-par normal score renders with its minus, and receives nothing", () => {
  const UNDER = golferId("under");
  const NORMAL = golferId("normal");

  it("renders a stated -1 as 'normally -1 · gets 0', never a plus-handicap '+1'", () => {
    // Under's -1 anchors the field; Norm's +13 is 14 away, halved on this nine-hole card → 7.
    const state = baseState({ participants: [participant(UNDER, "Under", "white", -1, 0), participant(NORMAL, "Norm", "white", 13, 7)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: noopSetBasis });

    const underRow = screen.getAllByRole("listitem").find((li) => /Under/.test(li.textContent ?? ""));
    expect(underRow).toBeTruthy();
    expect(underRow!.textContent).toMatch(/normally -1 · gets 0\b/);
    expect(underRow!.textContent).not.toMatch(/normally \+1\b/); // NOT the retired plus-handicap notation

    const normRow = screen.getAllByRole("listitem").find((li) => /Norm/.test(li.textContent ?? ""));
    expect(normRow!.textContent).toMatch(/normally \+13 · gets 7\b/);
  });
});

// Mid-round basis correction (spec 2026-07-20, re-shaped by 2026-07-29): the roster row IS the
// editor — any participant corrects any participant's stated number, retroactively, with no
// optimistic local write (the correction arrives via the fold once the caller sync()s). Two
// controls, because the two constructors are different KINDS of statement (spec §2a). These tests
// drive the row's controls by accessible name, the e2e-reconciliation lesson.
describe("SetupPanel — mid-round basis correction (spec 2026-07-20)", () => {
  const UNDER = golferId("under");

  it("Edit opens an inline editor holding the raw signed normal score, with its teaching line", async () => {
    const user = userEvent.setup();
    const state = baseState({ participants: [participant(UNDER, "Under", "white", -2, 0), participant(ANN, "Ann", "white", 8, 5)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: noopSetBasis });

    const underRow = screen.getAllByRole("listitem").find((li) => /Under/.test(li.textContent ?? ""));
    expect(underRow).toBeTruthy();
    expect(underRow!.textContent).toMatch(/normally -2 · gets 0\b/);

    await user.click(within(underRow!).getByRole("button", { name: "Edit" }));

    const input = within(underRow!).getByRole("spinbutton", { name: "What Under normally shoots, relative to par" });
    expect((input as HTMLInputElement).value).toBe("-2");
    expect(screen.getByText("Strokes come from the difference across the group — dots and games update everywhere.")).toBeTruthy();

    // The swap (2026-07-20 review finding): the static numbers must NOT still be on screen while
    // the editor holds the raw value underneath them — two representations of one number at once.
    expect(underRow!.textContent).not.toMatch(/normally -2/);

    // Ann's row is untouched — only Under's row entered edit mode.
    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    expect(within(annRow!).queryByRole("spinbutton")).toBeNull();
    expect(within(annRow!).getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("Save submits a normally-shoots basis for THAT golfer and closes the editor", async () => {
    const user = userEvent.setup();
    const state = baseState({ participants: [participant(ANN, "Ann", "white", 8, 3), participant(BO, "Bo", "white", 4, 1)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: noopSetBasis });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    await user.click(within(annRow!).getByRole("button", { name: "Edit" }));

    const input = within(annRow!).getByRole("spinbutton", { name: "What Ann normally shoots, relative to par" });
    await user.clear(input);
    await user.type(input, "13");
    await user.click(within(annRow!).getByRole("button", { name: "Save" }));

    expect(noopSetBasis).toHaveBeenCalledTimes(1);
    expect(noopSetBasis).toHaveBeenCalledWith(ANN, { kind: "normally-shoots", overPar: 13 });

    // No optimistic local write (the correction arrives via the fold, not local state): the editor
    // closes and the static row reappears showing the UNCHANGED prop values — asserting the spy's
    // args, never the row text, is the point of this test.
    await waitFor(() => expect(within(annRow!).queryByRole("spinbutton")).toBeNull());
    expect(within(annRow!).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByText("Strokes come from the difference across the group — dots and games update everywhere.")).toBeNull();
  });

  // The SECOND constructor (spec 2026-07-29 §2a): "just give him 18" is its own statement, not a
  // fudge of a normal score — so it is its own control, and the number it posts is a `strokes`
  // basis. Its editor starts BLANK on a seat that stated a normal score: there is nothing honest
  // to convert between the two (one is a fact about the player, the other about this round).
  it("Give strokes directly opens its own editor, blank, and Save posts a strokes basis", async () => {
    const user = userEvent.setup();
    const state = baseState({ participants: [participant(ANN, "Ann", "white", 8, 3)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: noopSetBasis });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    await user.click(within(annRow!).getByRole("button", { name: "Give strokes directly" }));

    const input = within(annRow!).getByRole("spinbutton", { name: "Strokes for Ann" });
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Strokes given directly, for the whole round — dots and games update everywhere.")).toBeTruthy();

    await user.type(input, "18");
    await user.click(within(annRow!).getByRole("button", { name: "Save" }));

    expect(noopSetBasis).toHaveBeenCalledTimes(1);
    expect(noopSetBasis).toHaveBeenCalledWith(ANN, { kind: "strokes", strokes: 18 });
  });

  it("Cancel restores the static row (the swap back) without calling onSetBasis", async () => {
    const user = userEvent.setup();
    // The under-par fixture is where the swap actually bites: the static "normally -2 · gets 0"
    // against the raw "-2" the editor holds — Cancel must bring the static text back, not leave
    // the row showing nothing or the raw value.
    const state = baseState({ participants: [participant(UNDER, "Under", "white", -2, 0), participant(ANN, "Ann", "white", 8, 5)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: noopSetBasis });

    const underRow = screen.getAllByRole("listitem").find((li) => /Under/.test(li.textContent ?? ""));
    await user.click(within(underRow!).getByRole("button", { name: "Edit" }));

    const input = within(underRow!).getByRole("spinbutton", { name: "What Under normally shoots, relative to par" });
    expect(underRow!.textContent).not.toMatch(/normally -2/); // swapped out while editing
    await user.clear(input);
    await user.type(input, "99");
    await user.click(within(underRow!).getByRole("button", { name: "Cancel" }));

    expect(noopSetBasis).not.toHaveBeenCalled();
    expect(within(underRow!).queryByRole("spinbutton")).toBeNull();
    // Swapped back: the static text is on screen again, anchored with a word boundary.
    expect(underRow!.textContent).toMatch(/^Under — white — normally -2 · gets 0\b/);
  });

  it("a failed save surfaces the error text and keeps the editor open", async () => {
    const user = userEvent.setup();
    const failingSetBasis = vi.fn().mockRejectedValue(new Error("network exploded"));
    const state = baseState({ participants: [participant(ANN, "Ann", "white", 8, 3), participant(BO, "Bo", "white", 4, 1)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: failingSetBasis });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    await user.click(within(annRow!).getByRole("button", { name: "Edit" }));

    const input = within(annRow!).getByRole("spinbutton", { name: "What Ann normally shoots, relative to par" });
    await user.clear(input);
    await user.type(input, "9");
    await user.click(within(annRow!).getByRole("button", { name: "Save" }));

    // Never a raw generic Error's message (papercut 12's own precedent) — an honest fallback,
    // and the editor stays open (retry one tap away).
    expect(await within(annRow!).findByRole("alert")).toBeTruthy();
    expect(within(annRow!).getByRole("alert").textContent).toBe("Could not update this player's strokes — try again.");
    expect(document.body.textContent).not.toMatch(/network exploded/);
    expect(within(annRow!).getByRole("spinbutton", { name: "What Ann normally shoots, relative to par" })).toBeTruthy();
  });

  // Review finding (Minor): a slow save in flight must not be interruptible by switching rows —
  // otherwise save()'s own setEditing(undefined)/setError lands on whichever row is open when the
  // request settles, not necessarily the row that started it. A deferred promise (held open until
  // resolved by hand) exposes the mid-flight window — same fixture shape as HomePage.test.tsx's/
  // CreateRoundPage.test.tsx's own deferred-GET-/me tests, applied here to onSetBasis.
  it("disables Edit on OTHER rows and Cancel on the editing row while a save is in flight, re-enabling once it settles", async () => {
    const user = userEvent.setup();
    let resolveSetBasis: (() => void) | undefined;
    const pendingSetBasis = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSetBasis = resolve;
        }),
    );
    const state = baseState({ participants: [participant(ANN, "Ann", "white", 8, 3), participant(BO, "Bo", "white", 4, 1)] });
    renderPanel({ state, games: [], joinCode: "ABC123", onAddGame: noopAddGame, onSetBasis: pendingSetBasis });

    const annRow = screen.getAllByRole("listitem").find((li) => /Ann/.test(li.textContent ?? ""));
    const boRow = screen.getAllByRole("listitem").find((li) => /Bo/.test(li.textContent ?? ""));
    await user.click(within(annRow!).getByRole("button", { name: "Edit" }));

    const input = within(annRow!).getByRole("spinbutton", { name: "What Ann normally shoots, relative to par" });
    await user.clear(input);
    await user.type(input, "9");
    await user.click(within(annRow!).getByRole("button", { name: "Save" }));

    // Mid-flight, before resolveSetBasis fires: Ann's own Cancel is disabled, and Bo's Edit —
    // a DIFFERENT row — is disabled too, so it can't be tapped to open a second editor while
    // Ann's save is still in the air.
    expect((within(annRow!).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(boRow!).getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);

    resolveSetBasis?.();
    await waitFor(() => expect(within(annRow!).queryByRole("spinbutton")).toBeNull());

    // Settled: Bo's Edit is enabled again.
    expect((within(boRow!).getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
