# Games Legibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the five games legible — a picker that teaches, a strokes preview instead of a raw allowance input, a per-game standings sheet on every card view, and plain-language results/ledger copy — per `docs/superpowers/specs/2026-07-18-games-legibility-design.md`.

**Architecture:** Game meaning (labels, blurbs, fits, allowance phrasing) becomes one tested domain module (`scoring/present.ts`, the `handicap/present.ts` precedent). The engines expose the per-hole trails their walks already compute, on **live `GameState` only** — the settled `GameResult` and every contracts schema stay byte-unchanged. The web renders through the domain formatters and existing client compute seams (`gameDots`/`totalDots`/`strokeGrant`); no new golf computation in `apps/web`.

**Tech Stack:** TypeScript ESM monorepo; Vitest (web component tests under happy-dom); React 19 + Tailwind 4; Playwright e2e.

## Global Constraints

- Work on local `main`. **NEVER push.**
- Per-task gate: the touched package's focused tests AND its `typecheck` (tests are typechecked even when `build` passes — the noUncheckedIndexedAccess lesson), then `pnpm validate` before each commit.
- **The settled wire is byte-unchanged:** no file under `packages/contracts` is edited in this arc; `resultOf` output for singles/fourball/skins must carry no `holes` key (pinned by test in Task 2/3).
- Wire kinds (`"singles-match"`, `"fourball-match"`, etc.) are unchanged everywhere; renames are presentation-only via `gameKindLabel`.
- Copy strings from the spec are **verbatim requirements** (spec §3 blurbs, §5 form copy, §6 sheet copy, §7 results/ledger copy). Labels: `Stroke play`, `Match play`, `Stableford`, `Four-ball`, `Skins`.
- The submit button text stays exactly `Add game`.
- No `eslint.config.mjs` changes: the new domain exports are formatters (not banned); `pnpm lint` stays green.
- Web focused test command: `pnpm -F @swng/web exec vitest run <file>`. Domain: `pnpm -F @swng/domain vitest run <file>`.
- Review-gate grep (Task 4 close + final review): `git grep -n "Singles match\|Fourball match" -- apps/web/src packages` returns nothing (spec/plan docs excluded by pathspec).

---

### Task 1: Domain — `scoring/present.ts` (labels, blurbs, fits, allowance phrase)

**Files:**
- Create: `packages/domain/src/scoring/present.ts`
- Create: `packages/domain/src/scoring/present.test.ts`
- Modify: `packages/domain/src/index.ts` (add one export line)

**Interfaces:**
- Consumes: `GameConfig` from `./game.js`, `defaultAllowance` from `./allowances.js`.
- Produces (later tasks rely on these exact signatures): `gameKindLabel(kind: GameConfig["kind"]): string`, `gameKindBlurb(kind): string`, `gameKindFits(kind): string`, `allowancePhrase(kind, allowance?: number): string` — all barrel-exported from `@swng/domain`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/domain/src/scoring/present.test.ts
import { describe, expect, it } from "vitest";
import { allowancePhrase, gameKindBlurb, gameKindFits, gameKindLabel } from "./present.js";

describe("gameKindLabel", () => {
  it("names every kind in golf's own plainest terms", () => {
    expect(gameKindLabel("stroke-play")).toBe("Stroke play");
    expect(gameKindLabel("singles-match")).toBe("Match play");
    expect(gameKindLabel("stableford")).toBe("Stableford");
    expect(gameKindLabel("fourball-match")).toBe("Four-ball");
    expect(gameKindLabel("skins")).toBe("Skins");
  });
});

describe("gameKindBlurb", () => {
  it("teaches each game in one plain line", () => {
    expect(gameKindBlurb("stroke-play")).toBe("Classic card golf — lowest total score wins.");
    expect(gameKindBlurb("singles-match")).toBe("Head-to-head, hole by hole. Win more holes to win the match.");
    expect(gameKindBlurb("stableford")).toBe("Points every hole — one blow-up hole can't sink you. Most points wins.");
    expect(gameKindBlurb("fourball-match")).toBe("2 v 2 — each side counts its better ball, hole by hole.");
    expect(gameKindBlurb("skins")).toBe("Every hole is worth a skin. Win the hole outright to take it — ties carry it to the next hole.");
  });
});

describe("gameKindFits", () => {
  it("states who each game fits", () => {
    expect(gameKindFits("singles-match")).toBe("2 players");
    expect(gameKindFits("fourball-match")).toBe("4 players");
    expect(gameKindFits("stroke-play")).toBe("2+ players");
    expect(gameKindFits("stableford")).toBe("2+ players");
    expect(gameKindFits("skins")).toBe("2+ players");
  });
});

describe("allowancePhrase", () => {
  it("reads the default as standard, in percent words", () => {
    expect(allowancePhrase("skins")).toBe("Full handicap (standard)");
    expect(allowancePhrase("singles-match", undefined)).toBe("Full handicap (standard)");
    expect(allowancePhrase("stableford")).toBe("95% handicap (standard)");
    expect(allowancePhrase("fourball-match")).toBe("90% handicap (standard)");
  });
  it("an explicit allowance equal to the default is still standard", () => {
    expect(allowancePhrase("stableford", 0.95)).toBe("95% handicap (standard)");
  });
  it("a changed allowance reads adjusted — including full handicap where full isn't the default", () => {
    expect(allowancePhrase("stableford", 0.85)).toBe("85% handicap (adjusted)");
    expect(allowancePhrase("stroke-play", 1)).toBe("Full handicap (adjusted)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @swng/domain vitest run src/scoring/present.test.ts`
Expected: FAIL — `Cannot find module './present.js'`

- [ ] **Step 3: Write the implementation**

```ts
// packages/domain/src/scoring/present.ts
import { defaultAllowance } from "./allowances.js";
import type { GameConfig } from "./game.js";

// The games' human meaning as domain truth — names, one-line rules, who a game fits, and
// how its handicap convention reads in words. One tested copy (the handicap/present.ts
// precedent): every surface that names a game renders through these, so the copy can never
// fork per view. Pure formatters — no golf RESULT is computed here, which is why the web
// may import them directly (they are not in the compute-fence banlist).
type GameKind = GameConfig["kind"];

export const gameKindLabel = (kind: GameKind): string => {
  switch (kind) {
    case "stroke-play":
      return "Stroke play";
    case "singles-match":
      // Golf's own plainer canonical name — the wire kind stays "singles-match".
      return "Match play";
    case "stableford":
      return "Stableford";
    case "fourball-match":
      return "Four-ball";
    case "skins":
      return "Skins";
  }
};

export const gameKindBlurb = (kind: GameKind): string => {
  switch (kind) {
    case "stroke-play":
      return "Classic card golf — lowest total score wins.";
    case "singles-match":
      return "Head-to-head, hole by hole. Win more holes to win the match.";
    case "stableford":
      return "Points every hole — one blow-up hole can't sink you. Most points wins.";
    case "fourball-match":
      return "2 v 2 — each side counts its better ball, hole by hole.";
    case "skins":
      return "Every hole is worth a skin. Win the hole outright to take it — ties carry it to the next hole.";
  }
};

export const gameKindFits = (kind: GameKind): string => {
  switch (kind) {
    case "singles-match":
      return "2 players";
    case "fourball-match":
      return "4 players";
    case "stroke-play":
    case "stableford":
    case "skins":
      return "2+ players";
  }
};

// "Full handicap (standard)" / "95% handicap (standard)" / "85% handicap (adjusted)" —
// standard means it matches the kind's WHS default; 100% always reads "Full handicap".
export const allowancePhrase = (kind: GameKind, allowance?: number): string => {
  const resolved = allowance ?? defaultAllowance(kind);
  const pct = Math.round(resolved * 100);
  const name = pct === 100 ? "Full handicap" : `${pct}% handicap`;
  return `${name}${resolved === defaultAllowance(kind) ? " (standard)" : " (adjusted)"}`;
};
```

In `packages/domain/src/index.ts`, after the line `export * from "./scoring/result.js";` add:

```ts
export * from "./scoring/present.js";
```

- [ ] **Step 4: Run tests + package gate**

Run: `pnpm -F @swng/domain vitest run src/scoring/present.test.ts` — Expected: PASS
Run: `pnpm -F @swng/domain typecheck && pnpm validate` — Expected: green

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/scoring/present.ts packages/domain/src/scoring/present.test.ts packages/domain/src/index.ts
git commit -m "feat(domain): scoring/present — game names, blurbs, fits, allowance phrasing as one tested copy"
```

---

### Task 2: Domain — match hole trails on live GameState (singles + fourball)

**Files:**
- Modify: `packages/domain/src/scoring/game.ts` (add `MatchHole`, extend two GameState arms)
- Modify: `packages/domain/src/scoring/singlesMatch.ts`
- Modify: `packages/domain/src/scoring/fourballMatch.ts`
- Test: `packages/domain/src/scoring/singlesMatch.test.ts`, `packages/domain/src/scoring/fourballMatch.test.ts`, `packages/domain/src/scoring/result.test.ts`

**Interfaces:**
- Produces: `export interface MatchHole { readonly hole: number; readonly winner: "a" | "b" | "halved" }` in `game.ts`; singles-match and fourball-match `GameState` arms gain `readonly holes: readonly MatchHole[]` — the decided prefix the ladder consumed, in card order, in the SAME `"a"/"b"` side vocabulary for both kinds (the web resolves names via the frozen config, the `describeFourball` precedent). An early closeout (3&2 thru 7 on the 9-hole fixture) yields exactly 7 entries.
- Invariant: `resultOf` is untouched (it already builds settled results from named fields) — the new field must NOT appear on any `GameResult`, pinned by test.

- [ ] **Step 1: Write the failing tests**

Append to `packages/domain/src/scoring/singlesMatch.test.ts` (inside the existing describe, reusing the file's `A`/`B`/`players`/`match` fixtures):

```ts
  it("exposes the decided hole trail the ladder consumed — and nothing past the closeout", () => {
    // Same card as the 3&2 test: h1 halve, h2 A, h3 A, h4 halve, h5 A, h6 B, h7 A → closed 3&2.
    const [state] = playGoldenRound(fixtureLinks, players, [match], {
      [A]: [5, 5, 3, 6, 4, 4, 5],
      [B]: [4, 5, 4, 5, 5, 3, 5],
    });
    expect(state).toMatchObject({
      holes: [
        { hole: 1, winner: "halved" },
        { hole: 2, winner: "a" },
        { hole: 3, winner: "a" },
        { hole: 4, winner: "halved" },
        { hole: 5, winner: "a" },
        { hole: 6, winner: "b" },
        { hole: 7, winner: "a" },
      ],
    });
  });
```

Append to `packages/domain/src/scoring/fourballMatch.test.ts` a trail test using that file's own existing fixture players/config and one of its existing score decks: assert `state.holes` matches the per-hole winners the test's own comment narrative already pins, and that `holes.length === state.thru`. (Write it against whichever existing case has a hole-by-hole comment — the assertion values come from that comment, exactly as the singles test above reuses its file's 3&2 narrative.)

Append to `packages/domain/src/scoring/result.test.ts`:

```ts
  it("settled match results carry no live hole trail — the wire stays lean", () => {
    const singles: GameState = {
      kind: "singles-match", id: gameId("m-lean"), up: 1, leader: golferId("a1"),
      thru: 9, remaining: 0, dormie: false,
      outcome: { winner: golferId("a1"), closing: "1 up" },
      holes: [{ hole: 1, winner: "a" }],
    };
    expect(resultOf(singles)).not.toHaveProperty("holes");

    const fourball: GameState = {
      kind: "fourball-match", id: gameId("f-lean"), up: 2, leader: "a",
      thru: 9, remaining: 0, dormie: false,
      outcome: { winner: "a", closing: "2 up" },
      holes: [{ hole: 1, winner: "a" }],
    };
    expect(resultOf(fourball)).not.toHaveProperty("holes");
  });
```

(Adjust imports at the top of `result.test.ts` if `GameState`/`gameId`/`golferId` aren't already imported there.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @swng/domain vitest run src/scoring/singlesMatch.test.ts src/scoring/fourballMatch.test.ts src/scoring/result.test.ts`
Expected: the new trail tests FAIL (no `holes` on state); the lean-wire test FAILS to compile or fails until the type exists — implement next.

- [ ] **Step 3: Implement**

In `packages/domain/src/scoring/game.ts`, after the `FourballOutcome` type add:

```ts
// One decided hole in a match's trail — the "a"/"b" side vocabulary for BOTH match kinds
// (singles resolves sides to golfers in leader/outcome, but the trail stays sides: views
// map to names via the frozen config, the describeFourball precedent). Live-GameState
// only — resultOf builds settled results from named fields, so this never reaches the wire.
export interface MatchHole {
  readonly hole: number;
  readonly winner: "a" | "b" | "halved";
}
```

Extend the two match arms of `GameState` with `readonly holes: readonly MatchHole[];` (after `dormie`, before `outcome`).

In `singlesMatch.ts`, after `const ladder = matchLadder(winners, holeCount);` add:

```ts
  // The trail is exactly the prefix the ladder consumed (thru): every entry inside it is
  // defined (the ladder stops at the first undefined), hence the non-null assertion.
  const holes = cardTeeSet.holes.slice(0, ladder.thru).map((hole, i) => ({ hole: hole.number, winner: winners[i]! }));
```

and add `holes,` to the returned object. Mirror the identical two lines in `fourballMatch.ts`.

- [ ] **Step 4: Run tests + package gate**

Run: `pnpm -F @swng/domain vitest run src/scoring/` — Expected: PASS (including the untouched golden decks)
Run: `pnpm -F @swng/domain typecheck && pnpm validate` — Expected: green (downstream packages only consume named GameState fields; the added field is additive)

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/scoring
git commit -m "feat(domain): match engines expose the decided hole trail on live GameState — settled wire untouched"
```

---

### Task 3: Domain — skins hole trail on live GameState

**Files:**
- Modify: `packages/domain/src/scoring/game.ts` (add `SkinsHole`, extend skins arm)
- Modify: `packages/domain/src/scoring/skins.ts`
- Test: `packages/domain/src/scoring/skins.test.ts`, `packages/domain/src/scoring/result.test.ts`

**Interfaces:**
- Produces: `export interface SkinsHole { readonly hole: number; readonly winner?: GolferId; readonly pot: number }` in `game.ts`; skins `GameState` arm gains `readonly holes: readonly SkinsHole[]` — one entry per decided hole (`holes.length === holesDecided`); `pot` = what the hole was worth (1 + carry-in); `winner` present iff one lowest net took it (and took `pot` skins), absent = carried.

- [ ] **Step 1: Write the failing test**

Append to `packages/domain/src/scoring/skins.test.ts` (reusing its `A`/`B`/`C`/`players3`/`game` fixtures):

```ts
  it("exposes the hole-by-hole story: pots, winners, carries", () => {
    // Same card as the golden test: carries on 1–3 build the pot to 4, Ann takes it on 4;
    // fresh skin carries on 5, Ann takes 2 on 6; Bo takes 1 on 7; carry on 8, Bo takes 2 on 9.
    const [state] = playGoldenRound(fixtureLinks, players3, [game], {
      [A]: [5, 5, 4, 6, 5, 4, 5, 6, "picked-up"],
      [B]: [4, 5, 3, 6, 4, 4, 4, 5, 4],
      [C]: [6, 7, 4, 8, 6, 5, 6, 7, 6],
    });
    expect(state).toMatchObject({
      holes: [
        { hole: 1, pot: 1 },
        { hole: 2, pot: 2 },
        { hole: 3, pot: 3 },
        { hole: 4, winner: A, pot: 4 },
        { hole: 5, pot: 1 },
        { hole: 6, winner: A, pot: 2 },
        { hole: 7, winner: B, pot: 1 },
        { hole: 8, pot: 1 },
        { hole: 9, winner: B, pot: 2 },
      ],
    });
    // Carried entries have no winner at all (absent key, not undefined-valued).
    const trail = (state as Extract<typeof state, { kind: "skins" }>).holes;
    expect(Object.keys(trail[0]!)).not.toContain("winner");
    expect(trail).toHaveLength(9);
  });
```

Append to `packages/domain/src/scoring/result.test.ts`:

```ts
  it("a settled skins result carries no live hole trail", () => {
    const skins: GameState = {
      kind: "skins", id: gameId("k-lean"),
      lines: [{ golferId: golferId("a1"), skins: 1 }],
      carrying: 0, carriedOut: 0, complete: true, holesDecided: 9,
      holes: [{ hole: 1, winner: golferId("a1"), pot: 1 }],
    };
    expect(resultOf(skins)).not.toHaveProperty("holes");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @swng/domain vitest run src/scoring/skins.test.ts src/scoring/result.test.ts`
Expected: FAIL (no `holes` field yet)

- [ ] **Step 3: Implement**

In `game.ts`, beside `MatchHole`:

```ts
// One decided hole in a skins trail. pot = what the hole was worth (1 + the carry riding
// in); winner present iff a single lowest net took it (and took `pot` skins) — absent
// means the pot carried. Live-GameState only, like MatchHole.
export interface SkinsHole {
  readonly hole: number;
  readonly winner?: GolferId;
  readonly pot: number;
}
```

Extend the skins `GameState` arm with `readonly holes: readonly SkinsHole[];` (after `holesDecided`).

In `skins.ts`: declare `const trail: SkinsHole[] = [];` beside `let carrying = 0;` (import the type), and inside the decided-hole walk record each outcome where the pot is settled:

```ts
    if (winners.length === 1) {
      const winner = winners[0]!.golferId;
      skinsWon.set(winner, skinsWon.get(winner)! + pot);
      trail.push({ hole: hole.number, winner, pot });
      carrying = 0;
    } else {
      // A tie carries the whole pot; so does a hole where everyone picked up.
      trail.push({ hole: hole.number, pot });
      carrying = pot;
    }
```

Add `holes: trail,` to the returned object.

- [ ] **Step 4: Run tests + package gate**

Run: `pnpm -F @swng/domain vitest run src/scoring/` — Expected: PASS
Run: `pnpm -F @swng/domain typecheck && pnpm validate` — Expected: green

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/scoring
git commit -m "feat(domain): skins engine exposes the hole-by-hole pot story on live GameState"
```

---

### Task 4: Web — the add-game form teaches (picker, who's-in, strokes preview)

**Files:**
- Create: `apps/web/src/round/AddGameForm.tsx` (extracted from SetupPanel and rebuilt)
- Create: `apps/web/src/round/AddGameForm.test.tsx`
- Modify: `apps/web/src/round/SetupPanel.tsx` (delete the in-file `AddGameForm` + `GAME_KIND_LABEL`; render the new component; badges label via `gameKindLabel`)
- Modify: `apps/web/src/round/dots.ts` (add the shared `strokesSummary` formatter)
- Modify: `apps/web/src/round/SetupPanel.test.tsx` (form tests move to `AddGameForm.test.tsx`; badge-label expectations update to `Match play`/`Four-ball` where present)

**Interfaces:**
- Consumes: Task 1's `gameKindLabel`/`gameKindBlurb`/`gameKindFits`/`allowancePhrase` (values from `@swng/domain` — legal, they're formatters); existing `gameDots`/`gamePlayers`/`totalDots` (`./dots`), `strokeGrant`/`gameId`/`golferId` (`@swng/domain`), `defaultAllowance` (`@swng/client`).
- Produces: `AddGameForm({ participants, card, onAddGame })`; `strokesSummary(config: GameConfig, participants, card): string` in `dots.ts` — Task 5's GameSheet reuses `strokesSummary` verbatim.

- [ ] **Step 1: Add `strokesSummary` to `dots.ts`** (shared by the form preview and Task 5's sheet — one copy):

```ts
// Append to apps/web/src/round/dots.ts. Add `strokeGrant` to the existing @swng/domain
// value import and `Participant`/`CourseCard`/`GolferId` to the type imports as needed.

// "Pat 5 dots · Alex 1 dot · Sam gives 1" — a game's strokes as one plain line, from the
// same allocation the card's dots render. Members with no strokes are omitted; a game
// where nobody gets any reads as scratch golf outright.
export const strokesSummary = (config: GameConfig, participants: readonly Participant[], card: CourseCard): string => {
  const dots = gameDots(config, participants, card);
  const nameOf = (id: GolferId): string => participants.find((p) => p.golferId === id)?.name ?? id;
  const parts = gameMembers(config).flatMap((id) => {
    const perHole = dots.get(id);
    const total = perHole ? totalDots(perHole) : 0;
    const grant = strokeGrant(total);
    if (grant.kind === "gives") return [`${nameOf(id)} gives ${grant.count}`];
    if (total === 0) return [];
    return [`${nameOf(id)} ${total} ${total === 1 ? "dot" : "dots"}`];
  });
  return parts.length > 0 ? parts.join(" · ") : "No strokes — everyone plays scratch.";
};
```

- [ ] **Step 2: Write the failing tests**

```tsx
// apps/web/src/round/AddGameForm.test.tsx — the shape; reuse SetupPanel.test.tsx's existing
// participant/card fixtures (import or copy its builders, matching that file's idiom).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AddGameForm } from "./AddGameForm";

// fixtures: four participants (Pat ch 5, Alex ch 2, Sam ch 0, Dana ch 8) on the test card —
// use SetupPanel.test.tsx's existing builders for Participant[] and CourseCard.

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
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm -F @swng/web exec vitest run src/round/AddGameForm.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 4: Implement `AddGameForm.tsx`**

```tsx
// apps/web/src/round/AddGameForm.tsx
import { useState } from "react";
import type { FormEvent } from "react";
import { defaultAllowance } from "@swng/client";
import { allowancePhrase, gameId, gameKindBlurb, gameKindFits, gameKindLabel, golferId } from "@swng/domain";
import type { CourseCard, GameConfig, GolferId, Participant } from "@swng/domain";
import type { GameConfigInput } from "@swng/contracts";
import { ApiError } from "../api";
import { strokesSummary } from "./dots";

type Kind = GameConfig["kind"];
const KINDS: readonly Kind[] = ["stroke-play", "singles-match", "stableford", "fourball-match", "skins"];

// The strokes preview needs a full GameConfig (gameDots' signature); ids are unvalidated
// brands, so a fixed placeholder id serves — it never leaves this component.
const PREVIEW_ID = gameId("preview");

export interface AddGameFormProps {
  readonly participants: readonly Participant[];
  readonly card: CourseCard;
  readonly onAddGame: (game: GameConfigInput) => Promise<void>;
}

export function AddGameForm({ participants, card, onAddGame }: AddGameFormProps) {
  const [kind, setKind] = useState<Kind>("stableford");
  const [scoring, setScoring] = useState<"gross" | "net">("net");
  const [players, setPlayers] = useState<readonly GolferId[]>([]);
  const [singleA, setSingleA] = useState<GolferId | undefined>(undefined);
  const [singleB, setSingleB] = useState<GolferId | undefined>(undefined);
  const [fbA1, setFbA1] = useState<GolferId | undefined>(undefined);
  const [fbA2, setFbA2] = useState<GolferId | undefined>(undefined);
  const [fbB1, setFbB1] = useState<GolferId | undefined>(undefined);
  const [fbB2, setFbB2] = useState<GolferId | undefined>(undefined);
  const [allowance, setAllowance] = useState<number>(defaultAllowance("stableford"));
  const [adjusting, setAdjusting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const changeKind = (next: Kind) => {
    setKind(next);
    setAllowance(defaultAllowance(next)); // re-anchor to the new kind's default; still adjustable
    setAdjusting(false);
    setPlayers([]);
    setSingleA(undefined);
    setSingleB(undefined);
    setFbA1(undefined);
    setFbA2(undefined);
    setFbB1(undefined);
    setFbB2(undefined);
    setError(undefined);
  };

  const togglePlayer = (id: GolferId) => {
    setPlayers((current) => (current.includes(id) ? current.filter((p) => p !== id) : [...current, id]));
  };

  const buildConfig = (): GameConfigInput | undefined => {
    switch (kind) {
      case "stroke-play":
        return players.length > 0 ? { kind, scoring, players: [...players], allowance } : undefined;
      case "stableford":
        return players.length > 0 ? { kind, players: [...players], allowance } : undefined;
      case "skins":
        // A skins pot needs at least two players contesting it — guarded here, not the wire.
        return players.length >= 2 ? { kind, players: [...players], allowance } : undefined;
      case "singles-match":
        return singleA && singleB && singleA !== singleB ? { kind, a: singleA, b: singleB, allowance } : undefined;
      case "fourball-match": {
        const ids = [fbA1, fbA2, fbB1, fbB2];
        if (ids.some((id) => !id)) return undefined;
        if (new Set(ids).size !== 4) return undefined; // four distinct players required
        return { kind, a: [fbA1!, fbA2!], b: [fbB1!, fbB2!], allowance };
      }
    }
  };

  const config = buildConfig();
  // GameConfigInput is GameConfig minus the server-assigned id — the placeholder restores it
  // purely so the preview can reuse the exact allocation the card's dots render.
  const preview = config ? strokesSummary({ ...config, id: PREVIEW_ID } as GameConfig, participants, card) : undefined;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!config) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await onAddGame(config);
      // No optimistic insert on success: the game-added event flows back through the session
      // (pull/WS) and the roster renders it from state.games once it arrives.
      changeKind(kind);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not add the game — try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const playerOption = (p: Participant) => (
    <option key={p.golferId} value={p.golferId}>
      {p.name}
    </option>
  );

  const selectPlayer = (label: string, value: GolferId | undefined, onChange: (id: GolferId | undefined) => void) => (
    <label className="flex flex-col gap-1">
      {label}
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value ? golferId(event.target.value) : undefined)}
        className="rounded-lg bg-slate-700 p-2"
      >
        <option value="">Select…</option>
        {participants.map(playerOption)}
      </select>
    </label>
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-lg bg-slate-900 p-4">
      <h2 className="text-lg font-semibold">Add game</h2>

      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Game</legend>
        {KINDS.map((k) => (
          <label
            key={k}
            className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-3 ${kind === k ? "border-emerald-500 bg-emerald-950" : "border-transparent bg-slate-800"}`}
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="flex items-center gap-2 font-semibold">
                <input type="radio" name="game-kind" aria-label={gameKindLabel(k)} checked={kind === k} onChange={() => changeKind(k)} className="h-4 w-4" />
                {gameKindLabel(k)}
              </span>
              <span className="text-xs text-slate-400">{gameKindFits(k)}</span>
            </span>
            <span className="text-sm text-slate-400">{gameKindBlurb(k)}</span>
          </label>
        ))}
      </fieldset>

      {kind === "stroke-play" && (
        <label className="flex flex-col gap-1">
          Scoring
          <select value={scoring} onChange={(event) => setScoring(event.target.value as "gross" | "net")} className="rounded-lg bg-slate-700 p-2">
            <option value="net">Net — with handicap strokes</option>
            <option value="gross">Gross — raw scores</option>
          </select>
        </label>
      )}

      {(kind === "stroke-play" || kind === "stableford" || kind === "skins") && (
        <fieldset role="group" aria-label="Who's in?" className="flex flex-col gap-2">
          <legend>Who&apos;s in?</legend>
          {participants.map((p) => (
            <label key={p.golferId} className="flex items-center gap-2">
              <input type="checkbox" checked={players.includes(p.golferId)} onChange={() => togglePlayer(p.golferId)} className="h-5 w-5" />
              {p.name}
            </label>
          ))}
        </fieldset>
      )}

      {kind === "singles-match" && (
        <fieldset className="flex flex-col gap-2">
          <legend>Who&apos;s playing?</legend>
          {selectPlayer("Player 1", singleA, setSingleA)}
          {selectPlayer("Player 2", singleB, setSingleB)}
        </fieldset>
      )}

      {kind === "fourball-match" && (
        <>
          <fieldset role="group" aria-label="Team 1" className="flex flex-col gap-2">
            <legend>Team 1</legend>
            {selectPlayer("First player", fbA1, setFbA1)}
            {selectPlayer("Second player", fbA2, setFbA2)}
          </fieldset>
          <fieldset role="group" aria-label="Team 2" className="flex flex-col gap-2">
            <legend>Team 2</legend>
            {selectPlayer("First player", fbB1, setFbB1)}
            {selectPlayer("Second player", fbB2, setFbB2)}
          </fieldset>
        </>
      )}

      {config && (
        <div className="flex flex-col gap-1 rounded-lg bg-slate-800 p-3">
          <span className="flex items-center justify-between">
            <span className="font-semibold">Strokes</span>
            <button type="button" onClick={() => setAdjusting((current) => !current)} className="text-sm text-emerald-400 underline">
              Adjust
            </button>
          </span>
          <span className="text-sm text-slate-400">{allowancePhrase(kind, allowance)}</span>
          {preview && <span className="text-sm">{preview}</span>}
          {kind === "singles-match" && <span className="text-sm text-slate-400">Match play uses the difference — only the higher handicap gets strokes.</span>}
          {adjusting && (
            <label className="flex flex-col gap-1 text-sm">
              Handicap %
              <input
                type="number"
                min={0}
                max={100}
                step="any"
                value={Math.round(allowance * 1000) / 10}
                onChange={(event) => setAllowance(Number(event.target.value) / 100)}
                className="rounded-lg bg-slate-700 p-2"
              />
            </label>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}

      <button type="submit" disabled={!config || submitting} className="rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold disabled:opacity-50">
        Add game
      </button>
    </form>
  );
}
```

- [ ] **Step 5: Rewire `SetupPanel.tsx`**

Delete the in-file `AddGameForm`, `AddGameFormProps`, `GAME_KIND_LABEL`, `KINDS`, and now-unused imports (`useState`, `FormEvent`, `defaultAllowance`, `golferId`, `GameConfigInput`, `ApiError`). Import `{ AddGameForm } from "./AddGameForm"` and `gameKindLabel` from `@swng/domain`. The badge label becomes `label: gameKindLabel(config.kind)`. The render site becomes:

```tsx
      <AddGameForm participants={state.participants} card={state.card} onAddGame={onAddGame} />
```

Move `SetupPanel.test.tsx`'s form-behavior tests into `AddGameForm.test.tsx` (deleting them from SetupPanel's file); update any badge-label expectations to the new labels. SetupPanel keeps its roster/badge/join-code tests.

- [ ] **Step 6: Run tests + gates**

Run: `pnpm -F @swng/web exec vitest run src/round/AddGameForm.test.tsx src/round/SetupPanel.test.tsx` — Expected: PASS
Run: `git grep -n "Singles match\|Fourball match" -- apps/web/src packages` — Expected: no output
Run: `pnpm -F @swng/web typecheck && pnpm validate` — Expected: green

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/round
git commit -m "feat(web): the add-game form teaches — game cards with blurbs, plain who's-in, strokes preview replacing the allowance input"
```

---

### Task 5: Web — the game sheet, on every card view

**Files:**
- Create: `apps/web/src/games/GameSheet.tsx`
- Create: `apps/web/src/games/GameSheet.test.tsx`
- Modify: `apps/web/src/games/describeGame.ts` (titles via `gameKindLabel`; drop ` · dormie`; export `vsPar`)
- Modify: `apps/web/src/games/describeGame.test.ts` (title/dormie expectations)
- Modify: `apps/web/src/round/StandingsHeader.tsx` (second-tap opens sheet; `›` cue)
- Modify: `apps/web/src/round/StandingsHeader.test.tsx`
- Modify: `apps/web/src/round/finalizeReadiness.test.ts` (only if it pins old titles)

**Interfaces:**
- Consumes: Tasks 1–3 (`gameKindLabel`/`gameKindBlurb`/`allowancePhrase`, `GameState.holes` trails), Task 4's `strokesSummary` from `./dots`, `describeGame` for status lines where shared.
- Produces: `GameSheet({ game, state, onClose })`; StandingsHeader behavior: tap inactive chip = select (unchanged), tap ACTIVE chip = open that game's sheet.

- [ ] **Step 1: `describeGame.ts` changes (write failing test updates first)**

In `describeGame.test.ts`: change expected titles to `Match play` / `Four-ball` / `Stroke play (net)` etc.; delete/invert any ` · dormie` line expectation (the chip line for a dormie match now reads `Pat 2 UP thru 16` with no suffix). Run `pnpm -F @swng/web exec vitest run src/games/describeGame.test.ts` — Expected: FAIL. Then in `describeGame.ts`:
  - `import { gameKindLabel } from "@swng/domain";`
  - titles: `` `${gameKindLabel("stroke-play")} (${game.scoring})` ``, `gameKindLabel("stableford")`, `gameKindLabel("singles-match")`, `gameKindLabel("fourball-match")`, `gameKindLabel("skins")`.
  - remove `${game.dormie ? " · dormie" : ""}` from `describeSingles` and `describeFourball`.
  - add `export` to `vsPar` (GameSheet reuses golf's vs-par notation — still the one definition site).

Re-run — Expected: PASS.

- [ ] **Step 2: Write failing GameSheet tests**

```tsx
// apps/web/src/games/GameSheet.test.tsx — build states via the same fixture idiom
// describeGame.test.ts already uses (RoundState + GameState literals). Key cases:
describe("GameSheet", () => {
  it("stroke play lists EVERY player sorted by total, not just leaders", () => {
    // three players, net totals 40/38/44 → rows in order 38, 40, 44; each row shows thru + vs par
  });
  it("stableford leads with the decoder ring", () => {
    // expect "Eagle 4 · Birdie 3 · Par 2 · Bogey 1 · worse 0"
  });
  it("a dormie match is explained in plain words", () => {
    // singles GameState: up 2, thru 16, remaining 2, dormie true, leader Pat
    // expect "Pat is 2 UP with 2 to play — dormie: Alex must win every remaining hole to tie."
  });
  it("the match trail renders a row per side with ● won and · halved", () => {
    // holes: [{1,"halved"},{2,"a"},{3,"b"}] → Pat's row cells: · ● (blank), Alex's: · (blank) ●
  });
  it("the skins story collapses carry runs", () => {
    // holes: [{1,pot 1},{2,pot 2},{3,winner Pat,pot 3},{4,pot 1}] →
    // "Holes 1–2 — carried", "Hole 3 — Pat takes 3", "Hole 4 — carried"
  });
  it("the header names the allowance in words and the blurb teaches", () => {
    // skins config, no explicit allowance → "Full handicap (standard)" + the skins blurb
  });
  it("close calls onClose", async () => { /* ✕ button */ });
});
```

Write these as real render assertions (`getByText`, `getAllByRole("row")` order) against hand-built `RoundState`/`GameState` fixtures. Run: `pnpm -F @swng/web exec vitest run src/games/GameSheet.test.tsx` — Expected: FAIL (no module).

- [ ] **Step 3: Implement `GameSheet.tsx`**

```tsx
// apps/web/src/games/GameSheet.tsx
import { allowancePhrase, gameKindBlurb, gameKindLabel } from "@swng/domain";
import type { GameConfig, GameState, GolferId, Participant, RoundState } from "@swng/domain";
import { strokesSummary } from "../round/dots";
import { vsPar } from "./describeGame";

export interface GameSheetProps {
  readonly game: GameState;
  readonly state: RoundState;
  readonly onClose: () => void;
}

const nameOf = (participants: readonly Participant[], id: GolferId): string => participants.find((p) => p.golferId === id)?.name ?? id;

// "Holes 2–3 — carried" / "Hole 4 — Alex takes 3": the skins trail as the story of the
// game, carry runs collapsed — a list, not a grid, because that's how skins are retold.
const skinsStory = (holes: readonly { hole: number; winner?: GolferId; pot: number }[], participants: readonly Participant[]): readonly string[] => {
  const items: string[] = [];
  let carryStart: number | undefined;
  let carryEnd = 0;
  const flushCarry = () => {
    if (carryStart === undefined) return;
    items.push(carryStart === carryEnd ? `Hole ${carryStart} — carried` : `Holes ${carryStart}–${carryEnd} — carried`);
    carryStart = undefined;
  };
  for (const entry of holes) {
    if (entry.winner === undefined) {
      if (carryStart === undefined) carryStart = entry.hole;
      carryEnd = entry.hole;
      continue;
    }
    flushCarry();
    items.push(`Hole ${entry.hole} — ${nameOf(participants, entry.winner)} takes ${entry.pot}`);
  }
  flushCarry();
  return items;
};

export function GameSheet({ game, state, onClose }: GameSheetProps) {
  const config = state.games.find((g): g is GameConfig => g.id === game.id);
  const title = game.kind === "stroke-play" ? `${gameKindLabel(game.kind)} (${game.scoring})` : gameKindLabel(game.kind);
  const terminated = state.terminatedGameIds.has(game.id);

  return (
    <div
      role="dialog"
      aria-label={`${title} standings`}
      className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80vh] flex-col gap-3 overflow-y-auto rounded-t-2xl bg-slate-900 p-4 text-slate-100 shadow-2xl"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-lg font-semibold">
            {title}
            {terminated && <span className="ml-2 rounded bg-slate-600 px-1.5 py-0.5 text-xs font-medium">Ended</span>}
          </span>
          {config && <span className="text-sm text-slate-400">{allowancePhrase(config.kind, config.allowance)}</span>}
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="min-h-10 rounded-lg bg-slate-800 px-3 text-lg text-slate-300">
          ✕
        </button>
      </div>

      <p className="text-sm text-slate-400">{gameKindBlurb(game.kind)}</p>

      {game.kind === "stroke-play" && <StrokePlayBody game={game} state={state} />}
      {game.kind === "stableford" && <StablefordBody game={game} state={state} />}
      {(game.kind === "singles-match" || game.kind === "fourball-match") && config && <MatchBody game={game} config={config} state={state} />}
      {game.kind === "skins" && <SkinsBody game={game} state={state} />}
    </div>
  );
}
```

Body components, in the same file (complete implementations; types via `Extract<GameState, { kind: ... }>` as `describeGame.ts` does):

```tsx
function StrokePlayBody({ game, state }: { game: Extract<GameState, { kind: "stroke-play" }>; state: RoundState }) {
  const total = (line: (typeof game.lines)[number]) => (game.scoring === "net" ? line.net!.total : line.gross.total);
  const sorted = [...game.lines].sort((a, b) => total(a) - total(b));
  if (sorted.length === 0) return <p className="text-sm text-slate-400">No scores yet</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-slate-400">
            <th className="py-1 pr-2 font-medium">Player</th>
            <th className="py-1 pr-2 font-medium">Total</th>
            <th className="py-1 pr-2 font-medium">Thru</th>
            <th className="py-1 font-medium">vs par</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((line) => (
            <tr key={line.golferId} className="border-t border-slate-800">
              <td className="py-2 pr-2">{nameOf(state.participants, line.golferId)}</td>
              <td className="py-2 pr-2">{total(line)}</td>
              <td className="py-2 pr-2">{line.thru}</td>
              <td className="py-2">{vsPar(line.relativeToPar)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StablefordBody({ game, state }: { game: Extract<GameState, { kind: "stableford" }>; state: RoundState }) {
  const sorted = [...game.lines].sort((a, b) => b.points - a.points);
  return (
    <>
      <p className="text-sm text-slate-400">Eagle 4 · Birdie 3 · Par 2 · Bogey 1 · worse 0</p>
      {sorted.length === 0 ? (
        <p className="text-sm text-slate-400">No scores yet</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-slate-400">
                <th className="py-1 pr-2 font-medium">Player</th>
                <th className="py-1 pr-2 font-medium">Points</th>
                <th className="py-1 font-medium">Thru</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((line) => (
                <tr key={line.golferId} className="border-t border-slate-800">
                  <td className="py-2 pr-2">{nameOf(state.participants, line.golferId)}</td>
                  <td className="py-2 pr-2">{line.points}</td>
                  <td className="py-2">{line.thru}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function MatchBody({ game, config, state }: { game: Extract<GameState, { kind: "singles-match" | "fourball-match" }>; config: GameConfig; state: RoundState }) {
  // Side names from the frozen config — the describeFourball precedent, applied to both kinds.
  const sideName = (side: "a" | "b"): string => {
    if (config.kind === "singles-match") return nameOf(state.participants, side === "a" ? config.a : config.b);
    if (config.kind === "fourball-match") return (side === "a" ? config.a : config.b).map((g) => nameOf(state.participants, g)).join(" & ");
    return side;
  };
  const leaderSide: "a" | "b" | undefined =
    game.kind === "singles-match"
      ? game.leader === undefined
        ? undefined
        : game.leader === (config.kind === "singles-match" ? config.a : undefined)
          ? "a"
          : "b"
      : game.leader;

  const status = (() => {
    if (game.outcome) {
      if ("halved" in game.outcome) return "Match halved";
      const winner = game.kind === "singles-match" ? nameOf(state.participants, (game.outcome as { winner: GolferId }).winner) : sideName((game.outcome as { winner: "a" | "b" }).winner);
      return `${winner} wins ${game.outcome.closing}`;
    }
    if (game.up === 0) return `All square thru ${game.thru}`;
    const leaderName = leaderSide ? sideName(leaderSide) : "";
    const trailerName = leaderSide ? sideName(leaderSide === "a" ? "b" : "a") : "";
    const base = `${leaderName} is ${game.up} UP with ${game.remaining} to play`;
    return game.dormie ? `${base} — dormie: ${trailerName} must win every remaining hole to tie.` : base;
  })();

  return (
    <>
      <p className="text-sm font-medium">{status}</p>
      {game.holes.length > 0 && (
        <div className="overflow-x-auto">
          <table className="text-xs">
            <thead>
              <tr className="text-slate-400">
                <th className="py-1 pr-2 text-left font-medium">Hole</th>
                {game.holes.map((h) => (
                  <th key={h.hole} className="px-1 py-1 text-center font-medium">
                    {h.hole}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(["a", "b"] as const).map((side) => (
                <tr key={side} className="border-t border-slate-800">
                  <th scope="row" className="py-1 pr-2 text-left font-medium whitespace-nowrap">
                    {sideName(side)}
                  </th>
                  {game.holes.map((h) => (
                    <td key={h.hole} className="px-1 py-1 text-center">
                      {h.winner === side ? "●" : h.winner === "halved" ? "·" : ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-sm text-slate-400">{strokesSummary(config, state.participants, state.card)}</p>
    </>
  );
}

function SkinsBody({ game, state }: { game: Extract<GameState, { kind: "skins" }>; state: RoundState }) {
  const status = game.complete
    ? game.carriedOut > 0
      ? `${game.carriedOut} carried out — the final pot was never won`
      : undefined
    : game.carrying > 0
      ? `Carrying ${game.carrying} into hole ${game.holesDecided + 1}`
      : undefined;
  const totals = [...game.lines].sort((a, b) => b.skins - a.skins);
  return (
    <>
      {status && <p className="text-sm font-medium">{status}</p>}
      <p className="text-sm">{totals.map((l) => `${nameOf(state.participants, l.golferId)} ${l.skins}`).join(" · ")}</p>
      {game.holes.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-slate-300">
          {skinsStory(game.holes, state.participants).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </>
  );
}
```

(Note: `MatchBody`'s singles leader-side derivation must compare against `config.a` when `config.kind === "singles-match"` — narrow `config` with a type guard at the top of `MatchBody` if the inline conditional fights the checker: `const singlesConfig = config.kind === "singles-match" ? config : undefined;` and use it in both `sideName` and `leaderSide`.)

- [ ] **Step 4: StandingsHeader integration (failing test first)**

Add to `StandingsHeader.test.tsx`:

```tsx
  it("tapping the active chip opens that game's sheet; tapping an inactive chip only selects", async () => {
    // render with two games, game[0] active; click game[1]'s chip → onSelect called, no dialog;
    // click game[0]'s (active) chip → a dialog with aria-label `${title} standings` appears;
    // its Close button removes it.
  });
  it("the active chip shows the › open cue", () => { /* active chip textContent contains "›" */ });
```

Run — FAIL. Then in `StandingsHeader.tsx`:
- `import { GameSheet } from "../games/GameSheet";` and add `const [sheetGameId, setSheetGameId] = useState<GameId | undefined>(undefined);`
- chip `onClick`: `active ? setSheetGameId(game.id) : onSelect(game.id)`
- inside the active chip's title span append: `{active && <span aria-hidden="true" className="ml-1">›</span>}`
- before the closing fragment: `{sheetGame && <GameSheet game={sheetGame} state={state} onClose={() => setSheetGameId(undefined)} />}` where `const sheetGame = games.find((g) => g.id === sheetGameId);`

- [ ] **Step 5: Run tests + gates**

Run: `pnpm -F @swng/web exec vitest run src/games src/round/StandingsHeader.test.tsx src/round/finalizeReadiness.test.ts` — Expected: PASS (fix finalizeReadiness title pins if they held old names)
Run: `pnpm -F @swng/web typecheck && pnpm validate` — Expected: green

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/games apps/web/src/round
git commit -m "feat(web): the game sheet — full standings, hole trails, dormie in plain words, one tap past the chip"
```

---

### Task 6: Web — results and ledger speak the same language

**Files:**
- Modify: `apps/web/src/round/ResultsView.tsx` + `ResultsView.test.tsx`
- Modify: `apps/web/src/crews/SeasonPanel.tsx` + `SeasonPanel.test.tsx`

**Interfaces:** Consumes nothing new; pure copy changes pinned by the spec §7 strings.

- [ ] **Step 1: Failing test updates**

`ResultsView.test.tsx`: expectations become — heading `Posted to handicaps`; complete row `Pat — adjusted score 82 · posts 12.3`; unrated row `Pat — adjusted score 82 · unrated course, not posted`; incomplete row `Pat — card incomplete, nothing posted`. `SeasonPanel.test.tsx`: column headers `Matches (W–L–H)`, `Stableford pts`, `Skins`; footnote text `From this season's counted rounds — match results, Stableford points, and skins for current members.`; head-to-head — leader case `Al leads Bo 5–4 · 2 halved`, tie case `Al and Bo are tied 4–4`. Run both files — Expected: FAIL.

- [ ] **Step 2: Implement**

`ResultsView.tsx` — the section becomes:

```tsx
        <h2 className="text-lg font-semibold">Posted to handicaps</h2>
        <ul className="flex flex-col gap-1">
          {handicapping.map((row) => {
            const name = state.participants.find((p) => p.golferId === row.golferId)?.name ?? row.golferId;
            return (
              <li key={row.golferId} className="text-sm text-slate-300">
                {row.kind === "complete"
                  ? `${name} — adjusted score ${row.ags} · posts ${row.differential.toFixed(1)}`
                  : row.kind === "unrated"
                    ? `${name} — adjusted score ${row.ags} · unrated course, not posted`
                    : `${name} — card incomplete, nothing posted`}
              </li>
            );
          })}
        </ul>
```

`SeasonPanel.tsx` — header cells become `Member` / `Rounds` / `Matches (W–L–H)` / `Stableford pts` / `Skins`; after the table's closing `</div>` add:

```tsx
      <p className="text-xs text-slate-500">From this season&apos;s counted rounds — match results, Stableford points, and skins for current members.</p>
```

and replace the head-to-head `<li>` body with a leader-first sentence via a local helper:

```tsx
// Head-to-head as a sentence, leader first — never the raw a/b row order.
const describeHeadToHead = (h2h: SeasonStandingsResponse["headToHead"][number], nameOf: (id: GolferId) => string): string => {
  const base =
    h2h.aWins === h2h.bWins
      ? `${nameOf(h2h.a)} and ${nameOf(h2h.b)} are tied ${h2h.aWins}–${h2h.bWins}`
      : h2h.aWins > h2h.bWins
        ? `${nameOf(h2h.a)} leads ${nameOf(h2h.b)} ${h2h.aWins}–${h2h.bWins}`
        : `${nameOf(h2h.b)} leads ${nameOf(h2h.a)} ${h2h.bWins}–${h2h.aWins}`;
  return h2h.halves > 0 ? `${base} · ${h2h.halves} halved` : base;
};
```

```tsx
              <li key={`${h2h.a}#${h2h.b}`}>{describeHeadToHead(h2h, nameOf)}</li>
```

- [ ] **Step 3: Run tests + gates**

Run: `pnpm -F @swng/web exec vitest run src/round/ResultsView.test.tsx src/crews/SeasonPanel.test.tsx` — Expected: PASS
Run: `pnpm -F @swng/web typecheck && pnpm validate` — Expected: green

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/round/ResultsView.tsx apps/web/src/round/ResultsView.test.tsx apps/web/src/crews
git commit -m "feat(web): results post in plain words; the season ledger names its games"
```

---

### Task 7: E2E reconciliation (the string-breakage lesson, done on purpose)

**Files:**
- Modify: `apps/web/e2e/support.ts` (game-form helpers drive the new picker/labels)
- Modify: `apps/web/e2e/unratedCourse.spec.ts`, `apps/web/e2e/fieldTest.spec.ts`, `apps/web/e2e/courseEntry.spec.ts` (chip/label strings)

**Interfaces:** Consumes the Task 4/5 accessible names: radios named by `gameKindLabel`, groups `Who's in?` / `Who's playing?` / `Team 1` / `Team 2`, selects `Player 1`/`Player 2`/`First player`/`Second player`, chips titled `Match play`/`Four-ball`.

- [ ] **Step 1: Rewrite the helpers in `support.ts`**

Replace `gameKindSelect(page).selectOption({ value: ... })` in every add-game helper with the picker tap, and update the field locators:

```ts
const pickGameKind = async (page: Page, label: string): Promise<void> => {
  await page.getByRole("radio", { name: label, exact: true }).check();
};

// singles → "Match play", two plain selects
export const addSinglesGame = async (page: Page, a: string, b: string): Promise<void> => {
  await pickGameKind(page, "Match play");
  await page.getByRole("combobox", { name: "Player 1", exact: true }).selectOption({ label: a });
  await page.getByRole("combobox", { name: "Player 2", exact: true }).selectOption({ label: b });
  await page.getByRole("button", { name: "Add game" }).click();
};

// fourball → "Four-ball", team fieldsets
export const addFourballGame = async (page: Page, sides: { readonly a1: string; readonly a2: string; readonly b1: string; readonly b2: string }): Promise<void> => {
  await pickGameKind(page, "Four-ball");
  const team1 = page.getByRole("group", { name: "Team 1" });
  await team1.getByRole("combobox", { name: "First player" }).selectOption({ label: sides.a1 });
  await team1.getByRole("combobox", { name: "Second player" }).selectOption({ label: sides.a2 });
  const team2 = page.getByRole("group", { name: "Team 2" });
  await team2.getByRole("combobox", { name: "First player" }).selectOption({ label: sides.b1 });
  await team2.getByRole("combobox", { name: "Second player" }).selectOption({ label: sides.b2 });
  await page.getByRole("button", { name: "Add game" }).click();
};

// skins/stableford → checkbox group renamed "Who's in?"
export const addSkinsGame = async (page: Page, names: readonly string[]): Promise<void> => {
  await pickGameKind(page, "Skins");
  const group = page.getByRole("group", { name: "Who's in?" });
  for (const name of names) {
    await group.getByLabel(name, { exact: true }).check();
  }
  await page.getByRole("button", { name: "Add game" }).click();
};
// addStablefordGame: identical shape with "Stableford"
```

(Match the existing helpers' exact export names and signatures — only their bodies and, where the old signature was `sides`-shaped, keep it. Delete `gameKindSelect` if nothing else uses it.)

- [ ] **Step 2: Update spec strings**

- `unratedCourse.spec.ts`: `chip(page, "Singles match")` → `chip(page, "Match play")`.
- `fieldTest.spec.ts`: every `chip(..., "Fourball match")` → `chip(..., "Four-ball")`.
- `courseEntry.spec.ts`: any singles-match setup/label strings per the new helpers.
- Sweep: `grep -rn "Singles match\|Fourball match\|Side A – Player\|Side B – Player\|getByRole(\"group\", { name: \"Players\" })" apps/web/e2e` — fix every hit; Expected after: no output.
- Check the fieldTest oracle for dormie: `grep -n "dormie" apps/web/e2e/support.ts apps/web/e2e/fieldTest.spec.ts` — if any pinned line carries ` · dormie`, drop it (the chip no longer renders it; `describeSinglesAt`/`describeFourballAt` style oracles that call the app's own `describeGame` self-update and need nothing).

- [ ] **Step 3: Gate**

Run: `pnpm validate` — Expected: green (validate typechecks the e2e specs; live runs happen at close-out, which needs AWS).

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e
git commit -m "test(e2e): game helpers drive the teaching picker; chips renamed Match play / Four-ball"
```

---

## Close-out (controller-run, after the whole-branch review)

Not a task for implementer subagents — the controller runs the milestone gate personally:

1. `pnpm validate` at HEAD — green.
2. `pnpm deploy:beta` (lambda-first: engines changed; wire unchanged, bundle kept in lockstep) then `publishWeb` (`pnpm --dir apps/infra-cdk exec node scripts/publishWeb.mjs` per the established close-out shape). **No data wipe** — nothing stored changes.
3. `pnpm e2e:beta` ×2 — 16/16 both.
4. Full `pnpm e2e:field` — all specs.
5. Browser walk on deployed beta.swng.golf: drive the picker (blurbs visible), read a strokes preview with a real handicap spread, Adjust to a non-default % and watch the phrase flip, add the game, open the live game sheet from the active chip (second tap), verify the skins story/match trail renders, check ResultsView's "Posted to handicaps" on a finalized round, and the crew ledger's named columns + head-to-head sentence.
6. Review-gate grep: `git grep -n "Singles match\|Fourball match" -- apps/web/src packages` — empty.
7. CLAUDE.md arc paragraph + ledger close.

## Self-Review (performed at write time)

- **Spec coverage:** §3→Task 1; §4→Tasks 2–3; §5→Task 4; §6→Task 5; §7→Task 6; §10.4→Task 7; §10.5→Close-out. §8 (right games) requires no task by design.
- **Type consistency:** `MatchHole`/`SkinsHole` names and `holes` field match across Tasks 2/3/5; `strokesSummary(config, participants, card)` matches between Tasks 4/5; `AddGameFormProps` gains `card` and SetupPanel passes `state.card`.
- **Known judgment calls baked in:** trail side-vocabulary is `"a"/"b"` for BOTH match kinds; skins trail is a story list, match trail a grid; the submit button stays `Add game`; `%` input rounds display to 0.1 (`Math.round(allowance * 1000) / 10`) to avoid input-fighting.
