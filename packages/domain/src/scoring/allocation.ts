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
import { anchorOf, resolveStrokes } from "./strokeBasis.js";
import { dotsByHole } from "./strokes.js";

// Generic in the entry type so a lookup preserves what the caller passed: `gameStrokeAllocation`
// reads `.departed` off the result, which only exists on a RosterEntry.
const participantFor = <T extends Participant>(participants: readonly T[], id: GolferId): T => {
  const found = participants.find((p) => p.golferId === id);
  if (!found) throw new DomainError("unknown-participant", `no participant "${id}" joined this round`);
  return found;
};

// ONE rule for every kind (spec §3): the game's field is its own members, strokes are the
// difference from the lowest among them, allocated by stroke index. The switch this replaced
// encoded five conventions and a hidden allowance percentage; there is nothing per-kind left.
export const gameStrokeAllocation = (
  config: GameConfig,
  participants: readonly RosterEntry[],
  card: CourseCard,
): ReadonlyMap<GolferId, ReadonlyMap<number, number>> => {
  if ("scoring" in config && config.scoring === "gross") return new Map();
  const members = gameMembers(config);
  // Any tee set answers "how many holes is this card", because every tee set on one card has the
  // same hole count — the whole-card supersession rule that made the card the stored unit pins it
  // (course-cards spec 2026-07-15: no hole-count change on an existing card, asserted structurally).
  // That is what lets the halving decision read teeSets[0] while the dots below are allocated
  // against each player's OWN tee set; a card with mismatched tee lengths would make the two
  // disagree, and none can exist.
  const holeCount = card.teeSets[0]?.holes.length ?? 18;
  const bases = members.map((id) => ({ golferId: id, basis: participantFor(participants, id).basis }));
  // A game's frozen players[] never drops a member who leaves, so the game's field excludes
  // departed players from its ANCHOR exactly as the card's does (spec §2b) — otherwise a
  // wrong-round joiner still anchors whichever game he was added to before leaving.
  const present = bases.filter(({ golferId }) => participantFor(participants, golferId).departed !== true);
  const strokes = resolveStrokes(bases, holeCount, anchorOf(present));
  return new Map(
    members.map((id) => [id, dotsByHole(strokes.get(id)!, findTeeSet(card, participantFor(participants, id).tee))]),
  );
};

// The STANDARD CARD's dots: each player's own ROUND strokes allocated by stroke index — no game
// at all (spec 2026-07-19 §2a: the card never changes; a game's own strokes, resolved off its own
// field, live in that game's panel and are stated there in words). Reads the value reduceRound
// already derived across the round's present roster (spec 2026-07-29 §2b) rather than re-running
// the rule, which is why this takes a RosterEntry and gameStrokeAllocation above does not: the
// card's field IS the round, so the fold has already answered it.
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
