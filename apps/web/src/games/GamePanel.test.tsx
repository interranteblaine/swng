import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureLinks, gameId, gameKindBlurb, golferId, roundId } from "@swng/domain";
import type { GameConfig, GameState, Participant, RoundState } from "@swng/domain";
import { GamePanel } from "./GamePanel";

const ANN = golferId("ann");
const BO = golferId("bo");
const CY = golferId("cy");
const PAT = golferId("pat");
const ALEX = golferId("alex");
const SAM = golferId("sam");
const DANA = golferId("dana");

const baseState = (games: readonly GameConfig[], participants: readonly Participant[], overrides: Partial<RoundState> = {}): RoundState => ({
  id: roundId("round-1"),
  status: "live",
  card: fixtureLinks,
  participants,
  games,
  cells: {},
  terminatedGameIds: new Set(),
  ...overrides,
});

afterEach(() => cleanup());

describe("GamePanel", () => {
  it("stroke play lists EVERY player sorted by vs-par (thru all 18, so ties never engage), not just leaders", () => {
    const participants: readonly Participant[] = [
      { golferId: ANN, name: "Ann", tee: "white", courseHandicap: 8 },
      { golferId: BO, name: "Bo", tee: "white", courseHandicap: 2 },
      { golferId: CY, name: "Cy", tee: "white", courseHandicap: 12 },
    ];
    const config: GameConfig = { kind: "stroke-play", id: gameId("g1"), scoring: "net", players: [ANN, BO, CY] };
    // Net totals 40/38/44, vs-par +4/+2/+8 — Bo (lowest vs-par) leads, but ALL THREE must
    // render, in ascending vs-par order (this fixture's totals happen to agree with vs-par
    // order too, since everyone is thru 18 — the divergent mid-round case is its own test below).
    const game: GameState = {
      kind: "stroke-play",
      id: config.id,
      scoring: "net",
      complete: true,
      leaders: [BO],
      lines: [
        { golferId: ANN, thru: 18, gross: { total: 42, pickups: 0 }, net: { total: 40, pickups: 0 }, relativeToPar: 4 },
        { golferId: BO, thru: 18, gross: { total: 40, pickups: 0 }, net: { total: 38, pickups: 0 }, relativeToPar: 2 },
        { golferId: CY, thru: 18, gross: { total: 46, pickups: 0 }, net: { total: 44, pickups: 0 }, relativeToPar: 8 },
      ],
    };
    const state = baseState([config], participants);

    render(<GamePanel game={game} state={state} />);

    const rows = screen.getAllByRole("row");
    // rows[0] is the header; the three data rows must read 38, 40, 44 in that order.
    expect(within(rows[1]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Bo", "38", "18", "(+2)"]);
    expect(within(rows[2]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Ann", "40", "18", "(+4)"]);
    expect(within(rows[3]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Cy", "44", "18", "(+8)"]);
  });

  // The owner ruling this arc closes (spec 2026-07-19 §2b): the OLD sort was by raw running
  // total, which always favors whoever's played FEWER holes — a thru-0 player's total is
  // always 0, the lowest possible raw number, regardless of how real leaders are actually
  // playing. Sorting by vs-par instead compares golfers on a fair, holes-played-independent
  // basis: a real leader who is genuinely UNDER par (relativeToPar -2) now correctly outranks
  // a thru-0 phantom whose "E" is only even because they haven't hit a shot — the exact
  // mid-round case (a leader with a low RAW total no longer masks a real leader's better rate).
  it("sorts by vs-par, not raw total — a real under-par leader outranks a thru-0 phantom's trivial E", () => {
    const participants: readonly Participant[] = [
      { golferId: PAT, name: "Pat", tee: "white", courseHandicap: 8 },
      { golferId: ALEX, name: "Alex", tee: "white", courseHandicap: 2 },
    ];
    const config: GameConfig = { kind: "stroke-play", id: gameId("g-sort-1"), scoring: "gross", players: [PAT, ALEX] };
    const game: GameState = {
      kind: "stroke-play",
      id: config.id,
      scoring: "gross",
      complete: false,
      leaders: [],
      lines: [
        // A thru-0 phantom: raw total 0 (the lowest possible number) but relativeToPar is
        // trivially 0 (E) too — old sort-by-total put this line first purely on that "0".
        { golferId: ALEX, thru: 0, gross: { total: 0, pickups: 0 }, relativeToPar: 0 },
        // A real leader, 2-under through 17 holes — genuinely better golf than a phantom E.
        { golferId: PAT, thru: 17, gross: { total: 68, pickups: 0 }, relativeToPar: -2 },
      ],
    };
    const state = baseState([config], participants);

    render(<GamePanel game={game} state={state} />);

    const rows = screen.getAllByRole("row");
    expect(within(rows[1]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Pat", "68", "17", "(-2)"]);
    expect(within(rows[2]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Alex", "0", "0", "(E)"]);
  });

  // The tie-break half of the same ruling: when two lines agree on vs-par, MORE holes played
  // ranks first — a golfer who has actually played a whole round dead even outranks a
  // thru-0 line that is only nominally "E" because it has no data at all.
  it("ties on vs-par break by holes played — a thru-17 E outranks a thru-0 E", () => {
    const participants: readonly Participant[] = [
      { golferId: PAT, name: "Pat", tee: "white", courseHandicap: 0 },
      { golferId: ALEX, name: "Alex", tee: "white", courseHandicap: 0 },
    ];
    const config: GameConfig = { kind: "stroke-play", id: gameId("g-sort-2"), scoring: "gross", players: [PAT, ALEX] };
    const game: GameState = {
      kind: "stroke-play",
      id: config.id,
      scoring: "gross",
      complete: false,
      leaders: [],
      lines: [
        { golferId: ALEX, thru: 0, gross: { total: 0, pickups: 0 }, relativeToPar: 0 },
        { golferId: PAT, thru: 17, gross: { total: 66, pickups: 0 }, relativeToPar: 0 },
      ],
    };
    const state = baseState([config], participants);

    render(<GamePanel game={game} state={state} />);

    const rows = screen.getAllByRole("row");
    expect(within(rows[1]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Pat", "66", "17", "(E)"]);
    expect(within(rows[2]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Alex", "0", "0", "(E)"]);
  });

  it("stableford leads with the decoder ring", () => {
    const participants: readonly Participant[] = [
      { golferId: ANN, name: "Ann", tee: "white", courseHandicap: 8 },
      { golferId: BO, name: "Bo", tee: "white", courseHandicap: 2 },
    ];
    const config: GameConfig = { kind: "stableford", id: gameId("g2"), players: [ANN, BO] };
    const game: GameState = {
      kind: "stableford",
      id: config.id,
      complete: true,
      leaders: [ANN], // deliberately just Ann — Bo must still render.
      lines: [
        { golferId: ANN, thru: 18, points: 30 },
        { golferId: BO, thru: 18, points: 25 },
      ],
    };
    const state = baseState([config], participants);

    render(<GamePanel game={game} state={state} />);

    expect(screen.getByText("Eagle 4 · Birdie 3 · Par 2 · Bogey 1 · worse 0")).toBeTruthy();
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Ann", "30", "18"]);
    expect(within(rows[2]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Bo", "25", "18"]);
  });

  it("a dormie match is explained in plain words", () => {
    const participants: readonly Participant[] = [
      { golferId: PAT, name: "Pat", tee: "white", courseHandicap: 8 },
      { golferId: ALEX, name: "Alex", tee: "white", courseHandicap: 2 },
    ];
    const config: GameConfig = { kind: "singles-match", id: gameId("m1"), a: PAT, b: ALEX };
    const game: GameState = {
      kind: "singles-match",
      id: config.id,
      up: 2,
      leader: PAT,
      thru: 16,
      remaining: 2,
      dormie: true,
      holes: [],
    };
    const state = baseState([config], participants);

    render(<GamePanel game={game} state={state} />);

    expect(screen.getByText("Pat is 2 UP with 2 to play — dormie: Alex must win every remaining hole to tie.")).toBeTruthy();
  });

  it("the match trail renders a row per side with ● won and · halved", () => {
    const participants: readonly Participant[] = [
      { golferId: PAT, name: "Pat", tee: "white", courseHandicap: 8 },
      { golferId: ALEX, name: "Alex", tee: "white", courseHandicap: 2 },
    ];
    const config: GameConfig = { kind: "singles-match", id: gameId("m2"), a: PAT, b: ALEX };
    const game: GameState = {
      kind: "singles-match",
      id: config.id,
      up: 1,
      leader: PAT,
      thru: 3,
      remaining: 15,
      dormie: false,
      holes: [
        { hole: 1, winner: "halved" },
        { hole: 2, winner: "a" },
        { hole: 3, winner: "b" },
      ],
    };
    const state = baseState([config], participants);

    render(<GamePanel game={game} state={state} />);

    const rows = screen.getAllByRole("row");
    // Header row (hole numbers), then side "a" (Pat), then side "b" (Alex) — the JSX's own order.
    expect(within(rows[1]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["·", "●", ""]);
    expect(within(rows[2]!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["·", "", "●"]);
    expect(screen.getByRole("rowheader", { name: "Pat" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "Alex" })).toBeTruthy();
  });

  it("a decided fourball match wins in the plural — the panel must match the chip", () => {
    const participants: readonly Participant[] = [
      { golferId: PAT, name: "Pat", tee: "white", courseHandicap: 8 },
      { golferId: SAM, name: "Sam", tee: "white", courseHandicap: 4 },
      { golferId: ALEX, name: "Alex", tee: "white", courseHandicap: 2 },
      { golferId: DANA, name: "Dana", tee: "white", courseHandicap: 10 },
    ];
    const config: GameConfig = { kind: "fourball-match", id: gameId("f1"), a: [PAT, SAM], b: [ALEX, DANA] };
    const game: GameState = {
      kind: "fourball-match",
      id: config.id,
      up: 2,
      leader: "a",
      thru: 17,
      remaining: 0,
      dormie: false,
      holes: [
        { hole: 1, winner: "a" },
        { hole: 2, winner: "halved" },
      ],
      outcome: { winner: "a", closing: "2&1" },
    };
    const state = baseState([config], participants, { terminatedGameIds: new Set([config.id]) });

    render(<GamePanel game={game} state={state} />);

    // describeGame's describeFourball already conjugates "win" for a pair — the panel must match it.
    expect(screen.getByText("Pat & Sam win 2&1")).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "Pat & Sam" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "Alex & Dana" })).toBeTruthy();
    // The game is in state.terminatedGameIds — the "Ended" badge must render too.
    expect(screen.getByText("Ended")).toBeTruthy();
  });

  it("the skins story collapses carry runs", () => {
    const participants: readonly Participant[] = [
      { golferId: PAT, name: "Pat", tee: "white", courseHandicap: 8 },
      { golferId: ALEX, name: "Alex", tee: "white", courseHandicap: 2 },
    ];
    const config: GameConfig = { kind: "skins", id: gameId("s1"), players: [PAT, ALEX] };
    const game: GameState = {
      kind: "skins",
      id: config.id,
      lines: [
        { golferId: PAT, skins: 3 },
        { golferId: ALEX, skins: 0 },
      ],
      carrying: 0,
      carriedOut: 0,
      complete: false,
      holesDecided: 4,
      holes: [
        { hole: 1, pot: 1 },
        { hole: 2, pot: 2 },
        { hole: 3, winner: PAT, pot: 3 },
        { hole: 4, pot: 1 },
      ],
    };
    const state = baseState([config], participants);

    render(<GamePanel game={game} state={state} />);

    expect(screen.getByText("Holes 1–2 — carried")).toBeTruthy();
    expect(screen.getByText("Hole 3 — Pat takes 3")).toBeTruthy();
    expect(screen.getByText("Hole 4 — carried")).toBeTruthy();
  });
});

// spec 2026-07-19 §2c: the panel header states the handicap treatment in words, up front —
// title, then the treatment line, then the strokes line, then a per-kind note — and the rules
// blurb (picker-only teaching copy) never repeats here.
describe("GamePanel — header (spec §2c)", () => {
  const singlesFixture = (): { config: GameConfig; game: GameState; state: RoundState } => {
    // Both at course handicap 0 — pins the all-zero strokes copy in the same fixture that
    // proves header ORDER, since strokesSummary's exact dot count needs no computation here.
    const participants: readonly Participant[] = [
      { golferId: PAT, name: "Pat", tee: "white", courseHandicap: 0 },
      { golferId: ALEX, name: "Alex", tee: "white", courseHandicap: 0 },
    ];
    const config: GameConfig = { kind: "singles-match", id: gameId("m-header"), a: PAT, b: ALEX };
    const game: GameState = { kind: "singles-match", id: config.id, up: 0, leader: undefined, thru: 0, remaining: 18, dormie: false, holes: [] };
    return { config, game, state: baseState([config], participants) };
  };

  it("renders region role (not dialog) named '{title} standings', with no ✕ close button", () => {
    const { game, state } = singlesFixture();
    render(<GamePanel game={game} state={state} />);

    expect(screen.getByRole("region", { name: "Match play standings" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("sets forest text color on the panel region for readability on the card surface", () => {
    const { game, state } = singlesFixture();
    render(<GamePanel game={game} state={state} />);

    const region = screen.getByRole("region", { name: "Match play standings" });
    expect(region.className).toContain("text-forest");
  });

  it("orders title, treatment line, strokes line, then note — and drops the rules blurb entirely", () => {
    const { game, state } = singlesFixture();
    render(<GamePanel game={game} state={state} />);

    const region = screen.getByRole("region", { name: "Match play standings" });
    const text = region.textContent ?? "";
    const titleAt = text.indexOf("Match play");
    const treatmentAt = text.indexOf("Full handicap (standard)");
    const strokesAt = text.indexOf("No strokes — everyone plays off 0.");
    const noteAt = text.indexOf("Match play uses the difference — only the higher handicap gets strokes.");

    expect(titleAt).toBeGreaterThanOrEqual(0);
    expect(treatmentAt).toBeGreaterThan(titleAt);
    expect(strokesAt).toBeGreaterThan(treatmentAt);
    expect(noteAt).toBeGreaterThan(strokesAt);

    // The rules blurb is picker-only now — teaching copy never repeats in the panel.
    expect(screen.queryByText(gameKindBlurb("singles-match"))).toBeNull();
  });

  it("stroke-play NET states the treatment as 'Net — {allowance}'", () => {
    const participants: readonly Participant[] = [{ golferId: PAT, name: "Pat", tee: "white", courseHandicap: 8 }];
    const config: GameConfig = { kind: "stroke-play", id: gameId("sp-net"), scoring: "net", players: [PAT] };
    const game: GameState = { kind: "stroke-play", id: config.id, scoring: "net", complete: false, leaders: [], lines: [] };
    const state = baseState([config], participants);

    render(<GamePanel game={game} state={state} />);

    expect(screen.getByText("Net — 95% handicap (standard)")).toBeTruthy();
  });

  it("stroke-play GROSS states 'Gross — raw scores, no strokes' and renders NO strokes line at all", () => {
    const participants: readonly Participant[] = [{ golferId: PAT, name: "Pat", tee: "white", courseHandicap: 8 }];
    const config: GameConfig = { kind: "stroke-play", id: gameId("sp-gross"), scoring: "gross", players: [PAT] };
    const game: GameState = { kind: "stroke-play", id: config.id, scoring: "gross", complete: false, leaders: [], lines: [] };
    const state = baseState([config], participants);

    render(<GamePanel game={game} state={state} />);

    expect(screen.getByText("Gross — raw scores, no strokes")).toBeTruthy();
    // No strokes line at all for gross stroke play — not even the all-zero copy.
    expect(screen.queryByText(/dots|gives|No strokes/)).toBeNull();
  });

  it("stableford and skins both render a strokes line", () => {
    const participants: readonly Participant[] = [{ golferId: PAT, name: "Pat", tee: "white", courseHandicap: 5 }];
    const stableford: GameConfig = { kind: "stableford", id: gameId("sf-strokes"), players: [PAT] };
    const stablefordState: GameState = { kind: "stableford", id: stableford.id, complete: false, leaders: [], lines: [] };
    const skins: GameConfig = { kind: "skins", id: gameId("sk-strokes"), players: [PAT] };
    const skinsState: GameState = { kind: "skins", id: skins.id, lines: [], carrying: 0, carriedOut: 0, complete: false, holesDecided: 0, holes: [] };

    const { unmount } = render(<GamePanel game={stablefordState} state={baseState([stableford], participants)} />);
    expect(screen.getByText(/Pat 5 dots/)).toBeTruthy();
    unmount();

    render(<GamePanel game={skinsState} state={baseState([skins], participants)} />);
    expect(screen.getByText(/Pat 5 dots/)).toBeTruthy();
  });

  it("the singles note reads verbatim", () => {
    const { game, state } = singlesFixture();
    render(<GamePanel game={game} state={state} />);
    expect(screen.getByText("Match play uses the difference — only the higher handicap gets strokes.")).toBeTruthy();
  });
});

// spec §2b: the "End game…" trigger moves into the panel footer (the destructive confirm sheet
// itself stays owned by StandingsHeader — GamePanel only ever triggers it via onTerminate).
describe("GamePanel — End game… trigger", () => {
  const fixture = (overrides: Partial<RoundState> = {}): { config: GameConfig; game: GameState; state: RoundState } => {
    const participants: readonly Participant[] = [
      { golferId: PAT, name: "Pat", tee: "white", courseHandicap: 8 },
      { golferId: ALEX, name: "Alex", tee: "white", courseHandicap: 2 },
    ];
    const config: GameConfig = { kind: "singles-match", id: gameId("m-end"), a: PAT, b: ALEX };
    const game: GameState = { kind: "singles-match", id: config.id, up: 0, leader: undefined, thru: 0, remaining: 18, dormie: false, holes: [] };
    return { config, game, state: baseState([config], participants, overrides) };
  };

  it("renders 'End game…' and calls onTerminate when tapped, for a live, unterminated game", () => {
    const onTerminate = vi.fn();
    const { game, state } = fixture();
    render(<GamePanel game={game} state={state} onTerminate={onTerminate} />);

    const button = screen.getByRole("button", { name: "End game…" });
    fireEvent.click(button);
    expect(onTerminate).toHaveBeenCalledTimes(1);
  });

  it("renders no End affordance at all when onTerminate is omitted (results/watch/archived reuse)", () => {
    const { game, state } = fixture();
    render(<GamePanel game={game} state={state} />);
    expect(screen.queryByRole("button", { name: /End /i })).toBeNull();
  });

  it("renders no End affordance once the game is terminated, even with onTerminate provided", () => {
    const { game, state } = fixture({ terminatedGameIds: new Set([gameId("m-end")]) });
    render(<GamePanel game={game} state={state} onTerminate={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /End /i })).toBeNull();
    // The Ended badge still shows in the header.
    expect(screen.getByText("Ended")).toBeTruthy();
  });

  it("renders no End affordance once the round is final, even with onTerminate provided (defense in depth)", () => {
    const { game, state } = fixture({ status: "final" });
    render(<GamePanel game={game} state={state} onTerminate={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /End /i })).toBeNull();
  });
});
