import { gameStrokeAllocation, totalDots } from "@swng/client";
import { gameMembers, strokeGrant } from "@swng/domain";
import type { CourseCard, GameConfig, GolferId, Participant } from "@swng/domain";

// A thin delegation to the domain's gameStrokeAllocation (packages/domain/src/scoring/
// allocation.ts), reached through @swng/client — the one on-device compute seam (this arc's
// ESLint fence forbids the web importing it straight from @swng/domain). M6 Task 5 deleted this
// file's own hand-mirrored allocation arithmetic (byte-identical to the domain version, now a
// single source instead of two to keep in sync).
export const gameDots = (config: GameConfig, participants: readonly Participant[], card: CourseCard): ReadonlyMap<GolferId, ReadonlyMap<number, number>> =>
  gameStrokeAllocation(config, participants, card);

// A thin re-export of the domain's totalDots (packages/domain/src/scoring/allocation.ts),
// reached through @swng/client (same on-device compute seam as gameDots above) — Task 4 deleted
// this file's own reduce, which was byte-identical to the domain version.
export { totalDots };

// "Pat 5 dots · Alex 1 dot · Sam gives 1" — a game's strokes as one plain line, from the
// same allocation the card's dots render. Members with no strokes are omitted; a game
// where nobody gets any reads as scratch golf outright.
//
// Undefined for a GROSS game (spec §9): it allocates nothing by definition, so the all-zero line
// below would be a false statement about a game that never had strokes to begin with — the
// treatment line already says so in words.
export const strokesSummary = (config: GameConfig, participants: readonly Participant[], card: CourseCard): string | undefined => {
  if ("scoring" in config && config.scoring === "gross") return undefined;
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
  // "everyone plays off 0" was true under the old absolute allocation, where zero dots for
  // everyone meant every member really was a scratch player. Under the ONE rule zero dots means
  // the members are EQUAL — at any level — so two golfers who both normally shoot +20 would have
  // been told they were scratch. What is true in both cases is that nobody is receiving.
  return parts.length > 0 ? parts.join(" · ") : "No strokes — everyone in this game plays level.";
};
