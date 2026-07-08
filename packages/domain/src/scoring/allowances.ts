import { roundHalfUp } from "./strokes.js";
import type { GameConfig } from "./game.js";

// WHS handicap allowances by format: individual stroke play and stableford both
// play 95% of course handicap; singles match play and skins play full handicap
// (100%); fourball plays 90% to offset the built-in advantage of counting the
// better ball.
export const defaultAllowance = (kind: GameConfig["kind"]): number => {
  switch (kind) {
    case "stroke-play":
    case "stableford":
      return 0.95;
    case "singles-match":
    case "skins":
      return 1;
    case "fourball-match":
      return 0.9;
  }
};

export const playingHandicap = (courseHandicap: number, allowance: number): number => roundHalfUp(courseHandicap * allowance);
