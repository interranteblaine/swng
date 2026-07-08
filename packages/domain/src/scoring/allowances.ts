import { roundHalfUp } from "./strokes.js";
import type { GameConfig } from "./game.js";

// WHS handicap allowances by format: individual stroke play and stableford both
// play 95% of course handicap; singles match play plays the full difference (100%).
export const defaultAllowance = (kind: GameConfig["kind"]): number => {
  switch (kind) {
    case "stroke-play":
    case "stableford":
      return 0.95;
    case "singles-match":
      return 1;
  }
};

export const playingHandicap = (courseHandicap: number, allowance: number): number => roundHalfUp(courseHandicap * allowance);
