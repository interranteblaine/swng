import type { CourseCard } from "../course/card.js";
import { findTeeSet, isRated } from "../course/card.js";
import { DomainError } from "../errors.js";
import { adjustedGrossScore, scoreDifferential } from "../handicap/whs.js";
import type { GolferId } from "../ids.js";
import type { HoleResult } from "../round/holeResult.js";
import type { Participant, RosterEntry } from "../round/participant.js";
import type { ScoreCell } from "../round/state.js";
import { cellAt } from "../round/state.js";
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

// A differential can only be posted once every tee-set hole has decided (a stroke count, a
// pickup, or a concession — adjustedGrossScore's own rule). Mid-round, or for a golfer who
// never finished, that's not an error — it's the ordinary "incomplete" case a v1 crew hits
// whenever someone walks in after a few holes or picks up on the last one.
//
// Lives here (not round/archive.ts) so it has exactly one implementation with two callers:
// settleRound below, and — per M6 Task 5 — the web's own handicapping display, which
// currently carries a drift-tested mirror of this exact function.
// Takes a RosterEntry, not a Participant: the net-double-bogey cap needs the strokes the fold
// DERIVED (spec 2026-07-29 §2b), which a bare assertion can't answer. Deleted whole in this arc's
// WHS-deletion task along with RoundArchive.handicapping.
export const handicappingFor = (
  participant: RosterEntry,
  card: CourseCard,
  cells: Readonly<Record<string, ScoreCell>>,
):
  | { readonly golferId: GolferId; readonly kind: "complete"; readonly ags: number; readonly differential: number }
  | { readonly golferId: GolferId; readonly kind: "unrated"; readonly ags: number }
  | { readonly golferId: GolferId; readonly kind: "incomplete" } => {
  const teeSet = findTeeSet(card, participant.tee);
  const holes = new Map<number, HoleResult>();
  for (const hole of teeSet.holes) {
    const cell = cellAt(cells, participant.golferId, hole.number);
    if (cell) holes.set(hole.number, cell.result);
  }
  try {
    const ags = adjustedGrossScore(teeSet, participant.strokes, holes);
    // Unrated: the round is fully scored (AGS holds) but has no differential to post
    // (spec §4). It stays out of the WHS index by carrying no differential, never by a
    // downstream filter change.
    if (!isRated(teeSet)) return { golferId: participant.golferId, kind: "unrated", ags };
    // Raw per-tee-set differential only — combining two 9-hole differentials into one
    // 18-hole-equivalent is the index projection's job (published 2020 WHS rule), not
    // settlement's; the archive stays index-independent, per this tee set alone.
    const differential = scoreDifferential(teeSet, ags);
    return { golferId: participant.golferId, kind: "complete", ags, differential };
  } catch (error) {
    // holes-undecided is the one expected failure of a partial card; anything else (e.g.
    // an unknown tee-set name, which would mean a corrupt round) is a real bug and must
    // surface rather than be swallowed into a silent "incomplete".
    if (error instanceof DomainError && error.code === "holes-undecided") {
      return { golferId: participant.golferId, kind: "incomplete" };
    }
    throw error;
  }
};
