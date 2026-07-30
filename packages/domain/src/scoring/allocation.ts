import type { CourseCard } from "../course/card.js";
import { findTeeSet } from "../course/card.js";
import { DomainError } from "../errors.js";
import type { GolferId } from "../ids.js";
import type { Participant, RosterEntry } from "../round/participant.js";
import type { GameConfig } from "./game.js";
// game.js → the five engines → back here: the engines all read their dots from
// gameStrokeAllocation below, so this is a module cycle, and a deliberate one. It is safe because
// every use on both sides sits inside a function body — nothing here runs at module-evaluation
// time — and the alternative (a second copy of the rule, or a shallow module holding nothing but
// gameMembers) costs more than it buys. The engines must go through this function: it is the ONE
// place the per-game field rule lives.
import { gameMembers } from "./game.js";
import { dotsByHole } from "./strokes.js";

// `Participant`, not `RosterEntry`: everything read off a seat here — `strokes` and `tee` — lives
// on the narrower type. Nothing in this file reads `.departed` any more; a game's field is its own
// frozen members, and every one of them is allocated against, present or departed alike (a player
// who walked off after 12 holes still has those holes settled). The generic went with that read.
const participantFor = (participants: readonly Participant[], id: GolferId): Participant => {
  const found = participants.find((p) => p.golferId === id);
  if (!found) throw new DomainError("unknown-participant", `no participant "${id}" joined this round`);
  return found;
};

// A card is absolute, a match is relative (spec 2026-07-30 §3). Medal kinds use each player's own
// roster number, so they always agree with the card. Match kinds use the DIFFERENCE, allocated
// from the hardest hole down — "you get ten off me" puts those ten on SI 1-10, which is what
// stroke index is for. Same shot count as subtracting two absolute allocations, different holes,
// and the holes are the point: no test that counts dots can tell the two apart, so the hole
// placement is pinned explicitly in allocation.test.ts.
//
// Nobody in the history of golf has said "I get 20 and you get 10." They say "you get 10."
export const gameStrokeAllocation = (
  config: GameConfig,
  participants: readonly RosterEntry[],
  card: CourseCard,
): ReadonlyMap<GolferId, ReadonlyMap<number, number>> => {
  if ("scoring" in config && config.scoring === "gross") return new Map();
  const dotsFor = (id: GolferId, strokes: number) => {
    const p = participantFor(participants, id);
    return [id, dotsByHole(strokes, findTeeSet(card, p.tee))] as const;
  };
  const strokesOf = (id: GolferId) => participantFor(participants, id).strokes;

  switch (config.kind) {
    case "stroke-play":
    case "stableford":
    case "skins":
      return new Map(gameMembers(config).map((id) => dotsFor(id, strokesOf(id))));
    case "singles-match":
    case "fourball-match": {
      // Singles falls out of the SAME expression as four-ball: with two members the lowest is one
      // of them, so the higher receives the difference and the lower receives none. A separate
      // two-player branch would be a second copy of one rule.
      const members = gameMembers(config);
      const lowest = Math.min(...members.map(strokesOf));
      return new Map(members.map((id) => dotsFor(id, strokesOf(id) - lowest)));
    }
  }
};

// The STANDARD CARD's dots: each player's own roster strokes allocated by stroke index — no game
// at all (spec 2026-07-19 §2a: the card never changes). The medal kinds above therefore agree
// with this by construction, since they read the same per-player number; the match kinds
// deliberately do not, and their panel says so in words (spec 2026-07-30 §3).
export const roundStrokeAllocation = (
  participants: readonly RosterEntry[],
  card: CourseCard,
): ReadonlyMap<GolferId, ReadonlyMap<number, number>> =>
  new Map(participants.map((p) => [p.golferId, dotsByHole(p.strokes, findTeeSet(card, p.tee))]));

// dotsByHole's allocation always sums exactly to its input strokes value (allocateStrokes' own
// documented invariant, strokes.ts) — summing here is safe rather than re-deriving a parallel
// "total dots" formula that could drift from the per-hole one above.
export const totalDots = (perHole: ReadonlyMap<number, number>): number => [...perHole.values()].reduce((sum, dots) => sum + dots, 0);

// `handicappingFor` (adjusted gross score → score differential per participant) is DELETED with
// the whole WHS pipeline (spec 2026-07-29 §7) and so is RoundArchive.handicapping, which was its
// only home. What the record needs from a finished round is now the plain gross — archiveGolferLine
// sums it from `holeResults` via `scoreOf` (golfer/analytics.ts), and ResultsView's own totals come
// from `grossForHoles` over the cells it already renders.
