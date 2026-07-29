import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureLinks, golferId } from "@swng/domain";
import type { CourseCard, Participant } from "@swng/domain";
import { AddGameForm } from "./AddGameForm";

afterEach(() => {
  cleanup();
});

const PAT = golferId("pat");
const ALEX = golferId("alex");
const SAM = golferId("sam");
const DANA = golferId("dana");

const participant = (id: ReturnType<typeof golferId>, name: string, tee: string, courseHandicap: number): Participant => ({
  golferId: id,
  name,
  tee,
  courseHandicap,
});

// Four participants on the shared fixture card (fixtureLinks — the same 9-hole "white" tee
// SetupPanel.test.tsx uses): Pat ch 5, Alex ch 2, Sam ch 0, Dana ch 8. Chosen so a game between
// Pat and Sam gives Pat the difference 5 − 0, halved on a nine-hole card = 3 dots spread by
// stroke index (the "Pat 3 dots" pin), while Sam — the lowest in that field — plays off scratch
// and is omitted from the line per strokesSummary's own rule.
const participants: readonly Participant[] = [
  participant(PAT, "Pat", "white", 5),
  participant(ALEX, "Alex", "white", 2),
  participant(SAM, "Sam", "white", 0),
  participant(DANA, "Dana", "white", 8),
];
const card: CourseCard = fixtureLinks;

describe("the picker teaches", () => {
  it("renders all five games as cards with label, fits, and blurb", () => {
    render(<AddGameForm participants={participants} card={card} onAddGame={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "Match play" })).toBeTruthy();
    expect(screen.getByText("2 players")).toBeTruthy();
    expect(screen.getByText("Head-to-head, hole by hole. Win more holes to win the match.")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Skins" })).toBeTruthy();
    expect(screen.getByText("Every hole is worth a skin. Win the hole outright to take it — ties carry it to the next hole.")).toBeTruthy();
  });
});

describe("who's in", () => {
  it("skins needs two players before Add enables", async () => {
    const user = userEvent.setup();
    render(<AddGameForm participants={participants} card={card} onAddGame={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: "Skins" }));
    await user.click(screen.getByRole("checkbox", { name: "Pat" }));
    expect(screen.getByRole("button", { name: "Add game" })).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("checkbox", { name: "Alex" }));
    expect(screen.getByRole("button", { name: "Add game" })).toHaveProperty("disabled", false);
  });

  it("match play asks in plain words and builds the config", async () => {
    const user = userEvent.setup();
    const onAddGame = vi.fn().mockResolvedValue(undefined);
    render(<AddGameForm participants={participants} card={card} onAddGame={onAddGame} />);
    await user.click(screen.getByRole("radio", { name: "Match play" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Player 1" }), "Pat");
    await user.selectOptions(screen.getByRole("combobox", { name: "Player 2" }), "Alex");
    await user.click(screen.getByRole("button", { name: "Add game" }));
    expect(onAddGame).toHaveBeenCalledWith(expect.objectContaining({ kind: "singles-match" }));
  });
});

describe("strokes preview", () => {
  it("states the treatment in words and the dots outcome before adding", async () => {
    const user = userEvent.setup();
    render(<AddGameForm participants={participants} card={card} onAddGame={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: "Skins" }));
    await user.click(screen.getByRole("checkbox", { name: "Pat" }));
    await user.click(screen.getByRole("checkbox", { name: "Sam" }));
    expect(screen.getByText("Net — everyone plays off the lowest in this game")).toBeTruthy();
    // Pat's 5 against Sam's 0, halved on a nine-hole card → "Pat 3 dots"; Sam is the lowest in
    // the field, so he plays off scratch and is omitted from the line.
    expect(screen.getByText(/Pat 3 dots/)).toBeTruthy();
    // No note under it: the treatment line already states this game's field, so a note would
    // render the same sentence twice.
    expect(screen.queryByText(/plays off scratch/)).toBeNull();
  });

  it("match play explains the difference rule", async () => {
    const user = userEvent.setup();
    render(<AddGameForm participants={participants} card={card} onAddGame={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: "Match play" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Player 1" }), "Pat");
    await user.selectOptions(screen.getByRole("combobox", { name: "Player 2" }), "Alex");
    expect(screen.getByText("Strokes are the difference between you two")).toBeTruthy();
    expect(screen.getByText("Only the higher number gets strokes — the lower plays off scratch.")).toBeTruthy();
  });

  // Live-walk finding (2026-07-19), carried forward: with Gross picked, the preview must state the
  // gross treatment and show no strokes at all — not the all-zero "everyone plays level" line,
  // which is false for a game that has no strokes by definition. Switching back to net restores it.
  // There is no allowance percentage left to adjust, so no Adjust affordance exists at all.
  it("gross stroke play states its own treatment — no strokes line, no percentage anywhere", async () => {
    const user = userEvent.setup();
    render(<AddGameForm participants={participants} card={card} onAddGame={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: "Stroke play" }));
    await user.click(screen.getByRole("checkbox", { name: "Pat" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Scoring" }), "gross");

    expect(screen.getByText("Gross — raw scores, no strokes")).toBeTruthy();
    expect(screen.queryByText("No strokes — everyone in this game plays level.")).toBeNull();
    expect(screen.queryByText(/dots/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/handicap|%/);

    await user.selectOptions(screen.getByRole("combobox", { name: "Scoring" }), "net");
    expect(screen.getByText("Net — everyone plays off the lowest in this game")).toBeTruthy();
    expect(screen.queryByText("Gross — raw scores, no strokes")).toBeNull();
  });

  // Skins earns the same gross/net choice stroke play has (spec §3) — the pot a group actually
  // plays. Gross skins allocates nothing, exactly like gross stroke play.
  it("skins offers the gross/net choice, and gross drops the strokes line", async () => {
    const user = userEvent.setup();
    render(<AddGameForm participants={participants} card={card} onAddGame={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: "Skins" }));
    await user.click(screen.getByRole("checkbox", { name: "Pat" }));
    await user.click(screen.getByRole("checkbox", { name: "Sam" }));
    expect(screen.getByText(/Pat 3 dots/)).toBeTruthy();

    await user.selectOptions(screen.getByRole("combobox", { name: "Scoring" }), "gross");
    expect(screen.getByText("Gross — raw scores, no strokes")).toBeTruthy();
    expect(screen.queryByText(/dots/)).toBeNull();
  });

  it("fourball explains that all four play off the lowest of the four", async () => {
    const user = userEvent.setup();
    render(<AddGameForm participants={participants} card={card} onAddGame={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: "Four-ball" }));
    const team1 = screen.getByRole("group", { name: "Team 1" });
    const team2 = screen.getByRole("group", { name: "Team 2" });
    await user.selectOptions(within(team1).getByRole("combobox", { name: "First player" }), "Pat");
    await user.selectOptions(within(team1).getByRole("combobox", { name: "Second player" }), "Alex");
    await user.selectOptions(within(team2).getByRole("combobox", { name: "First player" }), "Sam");
    await user.selectOptions(within(team2).getByRole("combobox", { name: "Second player" }), "Dana");
    expect(screen.getByText("Everyone plays off the lowest of the four")).toBeTruthy();
    expect(screen.getByText("Only the three higher numbers get strokes — the lowest plays off scratch.")).toBeTruthy();
  });
});

// Moved from SetupPanel.test.tsx (the old in-file AddGameForm's own behavior tests) and adapted
// to the new radio-card / Who's-in-checkbox / Team 1 & 2 UI — the underlying
// config-building and error-handling logic is unchanged, only the interactions that drive it.
describe("submitting", () => {
  it("adds a fourball-match game with the exact {kind, a, b} shape (ids from participants) and no id field", async () => {
    const user = userEvent.setup();
    const onAddGame = vi.fn().mockResolvedValue(undefined);
    render(<AddGameForm participants={participants} card={card} onAddGame={onAddGame} />);

    await user.click(screen.getByRole("radio", { name: "Four-ball" }));
    const team1 = screen.getByRole("group", { name: "Team 1" });
    const team2 = screen.getByRole("group", { name: "Team 2" });
    await user.selectOptions(within(team1).getByRole("combobox", { name: "First player" }), "Pat");
    await user.selectOptions(within(team1).getByRole("combobox", { name: "Second player" }), "Alex");
    await user.selectOptions(within(team2).getByRole("combobox", { name: "First player" }), "Sam");
    await user.selectOptions(within(team2).getByRole("combobox", { name: "Second player" }), "Dana");
    await user.click(screen.getByRole("button", { name: "Add game" }));

    expect(onAddGame).toHaveBeenCalledTimes(1);
    const sent = onAddGame.mock.calls[0]![0];
    expect(sent).toMatchObject({ kind: "fourball-match", a: [PAT, ALEX], b: [SAM, DANA] });
    expect(sent).not.toHaveProperty("id");
  });

  it("sends skins with the gross/net choice that was picked, and no allowance field at all", async () => {
    const user = userEvent.setup();
    const onAddGame = vi.fn().mockResolvedValue(undefined);
    render(<AddGameForm participants={participants} card={card} onAddGame={onAddGame} />);

    await user.click(screen.getByRole("radio", { name: "Skins" }));
    await user.click(screen.getByRole("checkbox", { name: "Pat" }));
    await user.click(screen.getByRole("checkbox", { name: "Sam" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Scoring" }), "gross");
    await user.click(screen.getByRole("button", { name: "Add game" }));

    expect(onAddGame).toHaveBeenCalledTimes(1);
    const sent = onAddGame.mock.calls[0]![0];
    expect(sent).toMatchObject({ kind: "skins", scoring: "gross", players: [PAT, SAM] });
    expect(sent).not.toHaveProperty("allowance");
  });

  it("re-anchors the gross/net choice back to net when the kind changes", async () => {
    const user = userEvent.setup();
    const onAddGame = vi.fn().mockResolvedValue(undefined);
    render(<AddGameForm participants={participants} card={card} onAddGame={onAddGame} />);

    await user.click(screen.getByRole("radio", { name: "Skins" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Scoring" }), "gross");
    await user.click(screen.getByRole("radio", { name: "Stroke play" }));
    await user.click(screen.getByRole("checkbox", { name: "Pat" }));
    await user.click(screen.getByRole("button", { name: "Add game" }));

    expect(onAddGame).toHaveBeenCalledWith(expect.objectContaining({ kind: "stroke-play", scoring: "net" }));
  });

  // Papercut 12 (M9 hardening, the never-raw-caught.message sweep): a failed Add game must never
  // surface a raw generic Error's message — only an honest fallback.
  it("never renders a raw generic Error's message from a failed Add game — only an honest fallback (papercut 12)", async () => {
    const user = userEvent.setup();
    const rejecting = vi.fn().mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'bar')"));
    render(<AddGameForm participants={participants} card={card} onAddGame={rejecting} />);

    await user.click(screen.getByRole("checkbox", { name: "Pat" })); // default kind stableford
    await user.click(screen.getByRole("button", { name: "Add game" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Could not add the game — try again.");
    expect(document.body.textContent).not.toMatch(/Cannot read properties/);
  });
});
