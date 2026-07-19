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
// SetupPanel.test.tsx uses): Pat ch 5, Alex ch 2, Sam ch 0, Dana ch 8. Chosen so a skins game
// (full handicap, allowance 1) gives Pat's own playingHandicap(5, 1) = 5 dots spread by stroke
// index — total 5, matching the "Pat 5 dots" pin — while Sam's playingHandicap(0, 1) = 0 dots,
// omitted from the line per strokesSummary's own rule.
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
  it("shows the allowance in words and the dots outcome before adding", async () => {
    const user = userEvent.setup();
    render(<AddGameForm participants={participants} card={card} onAddGame={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: "Skins" }));
    await user.click(screen.getByRole("checkbox", { name: "Pat" }));
    await user.click(screen.getByRole("checkbox", { name: "Sam" }));
    expect(screen.getByText("Full handicap (standard)")).toBeTruthy();
    // Pat ch 5 at full handicap → "Pat 5 dots"; Sam ch 0 → omitted from the line.
    expect(screen.getByText(/Pat 5 dots/)).toBeTruthy();
  });

  it("Adjust reveals a percent input — never a bare decimal — and the phrase flips to adjusted", async () => {
    const user = userEvent.setup();
    render(<AddGameForm participants={participants} card={card} onAddGame={vi.fn()} />);
    await user.click(screen.getByRole("checkbox", { name: "Pat" })); // default kind stableford
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    const pct = screen.getByRole("spinbutton", { name: "Handicap %" }) as HTMLInputElement;
    expect(pct.value).toBe("95");
    await user.clear(pct);
    await user.type(pct, "85");
    expect(screen.getByText("85% handicap (adjusted)")).toBeTruthy();
  });

  it("match play explains the difference rule", async () => {
    const user = userEvent.setup();
    render(<AddGameForm participants={participants} card={card} onAddGame={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: "Match play" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Player 1" }), "Pat");
    await user.selectOptions(screen.getByRole("combobox", { name: "Player 2" }), "Alex");
    expect(screen.getByText("Match play uses the difference — only the higher handicap gets strokes.")).toBeTruthy();
  });

  // Live-walk finding (2026-07-19): with Gross picked, the preview must match GamePanel's own
  // gross treatment line (packages/scoring/present + the panel's inline literal) — no allowance
  // phrase, no strokesSummary "everyone plays off 0" line, and no Adjust affordance, since an
  // allowance is meaningless for gross. Switching back to net restores everything.
  it("gross stroke play states its own treatment — no allowance phrase, no strokes line, no Adjust", async () => {
    const user = userEvent.setup();
    render(<AddGameForm participants={participants} card={card} onAddGame={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: "Stroke play" }));
    await user.click(screen.getByRole("checkbox", { name: "Pat" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Scoring" }), "gross");

    expect(screen.getByText("Gross — raw scores, no strokes")).toBeTruthy();
    expect(screen.queryByText("95% handicap (standard)")).toBeNull();
    expect(screen.queryByText("No strokes — everyone plays off 0.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Adjust" })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: "Handicap %" })).toBeNull();

    await user.selectOptions(screen.getByRole("combobox", { name: "Scoring" }), "net");
    expect(screen.getByText("95% handicap (standard)")).toBeTruthy();
    expect(screen.queryByText("Gross — raw scores, no strokes")).toBeNull();
    expect(screen.getByRole("button", { name: "Adjust" })).toBeTruthy();
  });

  // strokesNote (packages/domain/src/scoring/present.ts) is the one shared source for both
  // notes now — singles' string above is unchanged, but it comes from that shared function
  // rather than a literal hard-coded in this form; fourball gains its own note here too.
  it("fourball explains its lowest-handicap convention", async () => {
    const user = userEvent.setup();
    render(<AddGameForm participants={participants} card={card} onAddGame={vi.fn()} />);
    await user.click(screen.getByRole("radio", { name: "Four-ball" }));
    const team1 = screen.getByRole("group", { name: "Team 1" });
    const team2 = screen.getByRole("group", { name: "Team 2" });
    await user.selectOptions(within(team1).getByRole("combobox", { name: "First player" }), "Pat");
    await user.selectOptions(within(team1).getByRole("combobox", { name: "Second player" }), "Alex");
    await user.selectOptions(within(team2).getByRole("combobox", { name: "First player" }), "Sam");
    await user.selectOptions(within(team2).getByRole("combobox", { name: "Second player" }), "Dana");
    expect(screen.getByText("Four-ball plays everyone off the lowest handicap.")).toBeTruthy();
  });
});

// Moved from SetupPanel.test.tsx (the old in-file AddGameForm's own behavior tests) and adapted
// to the new radio-card / Who's-in-checkbox / Team 1 & 2 / Adjust-percent UI — the underlying
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

  it("sends the Adjust-ed percent as the submitted allowance (not the per-kind default)", async () => {
    const user = userEvent.setup();
    const onAddGame = vi.fn().mockResolvedValue(undefined);
    render(<AddGameForm participants={participants} card={card} onAddGame={onAddGame} />);

    await user.click(screen.getByRole("checkbox", { name: "Pat" })); // default kind stableford
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    const pct = screen.getByRole("spinbutton", { name: "Handicap %" });
    // 50 isn't stableford's default allowance percent (95) — picking a value that differs from
    // the default is the point: this guards the percent input's step="any" (a stricter step
    // would silently block this exact submit).
    await user.clear(pct);
    await user.type(pct, "50");
    await user.click(screen.getByRole("button", { name: "Add game" }));

    expect(onAddGame).toHaveBeenCalledTimes(1);
    const sent = onAddGame.mock.calls[0]![0];
    expect(sent).toMatchObject({ kind: "stableford", players: [PAT], allowance: 0.5 });
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
