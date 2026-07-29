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

// One treatment line for every kind, gross included — the ONE copy every panel and the
// add-game preview render through. Replaces allowancePhrase + strokePlayTreatment, whose split
// left the non-stroke-play kinds rendering a percentage that no longer exists.
export const gameTreatment = (config: GameConfig): string => {
  if ("scoring" in config && config.scoring === "gross") return "Gross — raw scores, no strokes";
  switch (config.kind) {
    case "stroke-play":
    case "skins":
    case "stableford":
      return "Net — uses the strokes on the card";
    case "singles-match":
      return "Strokes are the difference between you two";
    case "fourball-match":
      return "Everyone plays off the lowest of the four";
  }
};

// A note on WHOSE strokes a game's field is measured against — the sentence under the treatment
// line. Every kind now applies the same rule (the difference from the lowest in its own field),
// so what differs per kind is only who "the field" is; the percentages this once explained are
// gone. Undefined for a gross game: it allocates nothing, so there is no field to describe.
export const strokesNote = (config: GameConfig): string | undefined => {
  if ("scoring" in config && config.scoring === "gross") return undefined;
  switch (config.kind) {
    case "singles-match":
      return "Only the higher number gets strokes — the lower plays off scratch.";
    case "fourball-match":
      return "All four play off the lowest of the four.";
    case "stroke-play":
    case "stableford":
    case "skins":
      return "Everyone in this game plays off the lowest in it.";
  }
};

// Golf's own "red numbers" convention — strictly below par, never at or above it. A pure
// presentation predicate (no golf RESULT computed here), so the web renders through it
// directly wherever a gross or net score sits beside its hole's par.
export const underPar = (score: number, par: number): boolean => score < par;
