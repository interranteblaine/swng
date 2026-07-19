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
