import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  cellKey,
  deviceId,
  fieldDeck18,
  fixtureLinks18,
  gameStrokeAllocation,
  golferId,
  opId,
  playGoldenRoundLog,
  reduceRound,
  roundId,
  scoreGame,
  settleRound,
} from "@swng/domain";
import type { RoundState, ScoreCell } from "@swng/domain";
import type { FinalizeRoundResponse } from "@swng/contracts";
import { describeGame } from "../games/describeGame";
import { ResultsView } from "./ResultsView";

afterEach(() => cleanup());

describe("ResultsView — the agreement assertion (brief-mandated)", () => {
  const { players, fourball, skins, scores, corrections } = fieldDeck18;

  // A full, finalized log for the M5 field deck — the same fixture fieldDeck18.test.ts pins
  // fourballFinal/skinsFinal against.
  const events = playGoldenRoundLog(fixtureLinks18, players, [fourball, skins], scores, corrections, true);
  const state = reduceRound(events);
  const localGames = state.games.map((config) => scoreGame(config, state));

  // The faked API response: literally what settleRound produces for this SAME log — not a
  // hand-invented payload, so it genuinely CAN disagree with localGames if either side has a
  // bug (the brief's own framing: "same domain, same log; a mismatch is a real bug").
  const archive = settleRound(events);
  const response: FinalizeRoundResponse = { results: archive.results, handicapping: archive.handicapping };

  it("round is genuinely final and every game resolved — sanity, not the assertion itself", () => {
    expect(state.status).toBe("final");
    expect(response.results).toHaveLength(2);
  });

  it("the response's per-game results field-for-field match local games() for the same games", () => {
    const fourballResult = response.results.find((r) => r.id === fourball.id);
    const fourballLocal = localGames.find((g) => g.id === fourball.id);
    expect(fourballResult).toMatchObject({ kind: "fourball-match", outcome: { winner: "a", closing: "2&1" } });
    expect(fourballLocal).toMatchObject({ outcome: { winner: "a", closing: "2&1" } });
    expect(fourballResult?.kind === "fourball-match" && fourballLocal?.kind === "fourball-match" && fourballLocal.outcome).toEqual(
      fourballResult?.kind === "fourball-match" ? fourballResult.outcome : undefined,
    );

    const skinsResult = response.results.find((r) => r.id === skins.id);
    const skinsLocal = localGames.find((g) => g.id === skins.id);
    // resultOf's `won` is every configured player (including 0-skin ones), same shape/order as
    // GameState's own `lines` — not filtered to winners only.
    expect(skinsResult?.kind === "skins" ? skinsResult.won : undefined).toEqual(skinsLocal?.kind === "skins" ? skinsLocal.lines : undefined);
    expect(skinsResult?.kind === "skins" ? skinsResult.carriedOut : undefined).toBe(skinsLocal?.kind === "skins" ? skinsLocal.carriedOut : undefined);
  });

  it("ResultsView renders exactly what describeGame(games()...) renders locally — the brief's literal check", () => {
    render(<ResultsView state={state} games={localGames} response={response} />);

    for (const game of localGames) {
      const { line } = describeGame(game, state);
      expect(screen.getByText(line)).toBeTruthy();
    }
    // Matches the brief's own literal target strings for this exact fixture.
    expect(screen.getByText("Ann & Bo win 2&1")).toBeTruthy();
    expect(screen.getByText("Bo 7 · Dee 8 · 3 carried out")).toBeTruthy();
  });

  it("handicapping rows render the server's response verbatim — no local recomputation when a response exists", () => {
    render(<ResultsView state={state} games={localGames} response={response} />);
    for (const row of response.handicapping) {
      if (row.kind !== "complete") continue;
      const name = state.participants.find((p) => p.golferId === row.golferId)!.name;
      expect(screen.getByText(new RegExp(`${name} — AGS ${row.ags}, differential ${row.differential.toFixed(1)}`))).toBeTruthy();
    }
  });

  it("the archived card reuses ScorecardGrid, read-only — a cell tap is inert", () => {
    render(<ResultsView state={state} games={localGames} response={response} />);
    const cell = screen.getByRole("button", { name: `${players[0]!.name} hole 1` });
    expect(cell.hasAttribute("disabled")).toBe(true);
  });

  it("StandingsHeader chips switch the archived grid's active game — the games[0]-only limitation is gone", () => {
    // An independent oracle (domain's own gameStrokeAllocation, not the component under test)
    // for Ann's per-hole dots under each config — fourball's relative playingHandicap is 7
    // (fieldDeck18's own pinned expectation), skins' is 8, so the SI-8 hole is Ann's cleanest
    // possible fixture: exactly zero dots under fourball, exactly one under skins.
    const annId = players[0]!.golferId;
    const fourballDots = gameStrokeAllocation(fourball, state.participants, state.card).get(annId)!;
    const skinsDots = gameStrokeAllocation(skins, state.participants, state.card).get(annId)!;
    const hole = [...fourballDots.keys()].find((h) => (fourballDots.get(h) ?? 0) === 0 && (skinsDots.get(h) ?? 0) > 0);
    expect(hole).toBeDefined();

    render(<ResultsView state={state} games={localGames} response={response} />);
    const cell = screen.getByRole("button", { name: `${players[0]!.name} hole ${hole}` });

    // fourball is games[0] (fieldDeck18's own [fourball, skins] order) — the default active
    // game before any chip tap, same convention as RoundPage's LiveRound.
    expect(cell.querySelector('span[aria-hidden]')).toBeNull(); // 0 dots renders no glyph at all (Cell's own contract)

    fireEvent.click(screen.getByRole("tab", { name: /skins/i }));

    expect(cell.querySelector('span[aria-hidden]')?.textContent).toBe("●".repeat(skinsDots.get(hole!)!));
  });
});

describe("ResultsView — no response (WS-pushed final, brief's other tab)", () => {
  it("derives handicapping locally, matching settleRound's own numbers for the identical log", () => {
    const { players, fourball, skins, scores, corrections } = fieldDeck18;
    const events = playGoldenRoundLog(fixtureLinks18, players, [fourball, skins], scores, corrections, true);
    const state = reduceRound(events);
    const localGames = state.games.map((config) => scoreGame(config, state));
    const archive = settleRound(events); // the true source — this tab never called finalize, only settleRound did (server-side)

    render(<ResultsView state={state} games={localGames} response={undefined} />);

    for (const row of archive.handicapping) {
      const name = state.participants.find((p) => p.golferId === row.golferId)!.name;
      if (row.kind === "complete") {
        expect(screen.getByText(new RegExp(`${name} — AGS ${row.ags}, differential ${row.differential.toFixed(1)}`))).toBeTruthy();
      } else {
        expect(screen.getByText(`${name} — incomplete`)).toBeTruthy();
      }
    }
  });

  it("still renders per-game results (from local games() alone) and the read-only card", () => {
    const { players, fourball, skins, scores, corrections } = fieldDeck18;
    const events = playGoldenRoundLog(fixtureLinks18, players, [fourball, skins], scores, corrections, true);
    const state = reduceRound(events);
    const localGames = state.games.map((config) => scoreGame(config, state));

    render(<ResultsView state={state} games={localGames} response={undefined} />);

    expect(screen.getByText("Ann & Bo win 2&1")).toBeTruthy();
    const cell = screen.getByRole("button", { name: `${players[0]!.name} hole 1` });
    expect(cell.hasAttribute("disabled")).toBe(true);
  });

  it("a golfer with an undecided card (a pickup mid-round, no finalize response) shows 'incomplete', not a crash", () => {
    // A tiny hand-built round: one participant, one hole recorded, never finished — the round
    // is marked final anyway (mirrors the WS-push scenario: this tab just observes status).
    const ann = golferId("ann");
    const cellValue: ScoreCell = { result: { kind: "strokes", strokes: 5 }, recordedBy: ann, hlc: { wallMs: 1, counter: 0, deviceId: deviceId("d") }, opId: opId("op-1") };
    const state: RoundState = {
      id: roundId("r1"),
      status: "final",
      card: fixtureLinks18,
      participants: [{ golferId: ann, name: "Ann", tee: "white", courseHandicap: 8 }],
      games: [],
      cells: { [cellKey(ann, 1)]: cellValue },
      terminatedGameIds: new Set(),
    };

    render(<ResultsView state={state} games={[]} response={undefined} />);
    expect(screen.getByText("Ann — incomplete")).toBeTruthy();
  });
});
