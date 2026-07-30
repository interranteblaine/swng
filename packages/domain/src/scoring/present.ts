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
//
// The net line does NOT say "uses the strokes on the card" (spec §3's first wording, corrected in
// §11): the card renders each player's FULL number, a game renders the difference from its own
// field's lowest, so the two genuinely disagree for any game played by a subset of the roster. This
// wording is true in every case, and it is the fourball line's own vocabulary.
export const gameTreatment = (config: GameConfig): string => {
  if ("scoring" in config && config.scoring === "gross") return "Gross — raw scores, no strokes";
  switch (config.kind) {
    case "stroke-play":
    case "skins":
    case "stableford":
      return "Net — everyone plays off the lowest in this game";
    case "singles-match":
      return "Strokes are the difference between you two";
    case "fourball-match":
      return "Everyone plays off the lowest of the four";
  }
};

// The sentence under the treatment line, for the two kinds where WHO RECEIVES is worth saying out
// loud: strokes are relative now, so in a match somebody receives nothing and it is worth naming
// which side. The other three get nothing here on purpose — gameTreatment's own net line already
// states their field, and a note repeating it would just be the same sentence twice.
//
// Neither arm says "plays off scratch" (controller ruling, post-task-1): that is the same
// misleading register this arc deleted from dots.ts's "everyone plays off 0", which wrongly told
// two equal +20 golfers they were scratch golfers. Under a relative model the anchor may be a +20
// who simply receives nothing, and "scratch" is handicap-era vocabulary for playing to par.
export const strokesNote = (kind: GameKind): string | undefined => {
  switch (kind) {
    case "singles-match":
      return "Only the higher number gets strokes — the lower gets none.";
    case "fourball-match":
      return "Only the three higher numbers get strokes — the lowest gets none.";
    case "stroke-play":
    case "stableford":
    case "skins":
      return undefined;
  }
};

// Golf's own "red numbers" convention — strictly below par, never at or above it. A pure
// presentation predicate (no golf RESULT computed here), so the web renders through it
// directly wherever a gross or net score sits beside its hole's par.
export const underPar = (score: number, par: number): boolean => score < par;

// A vs-par number: positive is over par, E is level, minus is under. The ONE signed-number
// convention left in the product (spec 2026-07-29 §4). Golf's "+2 means better than scratch"
// notation existed only because a handicap index is a number where lower is better; a vs-par
// score has no such problem, so the notation evaporates with the index that required it.
// Absorbs apps/web/src/ui/vsPar.ts so there is one copy.
export const formatOverPar = (value: number): string => (value === 0 ? "E" : value > 0 ? `+${value}` : `${value}`);
