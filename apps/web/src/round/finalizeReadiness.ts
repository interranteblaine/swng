import { unresolvedGames as domainUnresolvedGames } from "@swng/client";
import { describeGame } from "@swng/domain";
import type { GameId, GameState, GolferId, RoundState, UnresolvedGameMissing } from "@swng/domain";

export interface UnresolvedGame {
  readonly gameId: GameId;
  readonly title: string; // the game chip's OWN naming (describeGame's title) — never a hand-rolled label here
  readonly missing: string; // e.g. "holes 2–18 unscored for Pat"
}

const nameOf = (state: RoundState, golfer: GolferId): string => state.participants.find((p) => p.golferId === golfer)?.name ?? golfer;

// [2,3,4,7,8] -> "2–4, 7–8"; a lone hole never gets a dash ("18", not "18–18").
const formatHoleRanges = (holes: readonly number[]): string => {
  const ranges: string[] = [];
  let start: number | undefined;
  let prev: number | undefined;
  for (const hole of holes) {
    if (start !== undefined && prev !== undefined && hole === prev + 1) {
      prev = hole;
      continue;
    }
    if (start !== undefined && prev !== undefined) ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = hole;
    prev = hole;
  }
  if (start !== undefined && prev !== undefined) ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
  return ranges.join(", ");
};

// One clause per DISTINCT missing-hole set among the game's own players — a crew that all
// stopped at the same hole (the common case) reads as one clause naming everyone, not one
// repetitive clause per golfer. Fed from the domain's own structured `missing[]` (already
// filtered to golfers with at least one open hole) rather than re-deriving it locally.
const describeMissing = (state: RoundState, missing: readonly UnresolvedGameMissing[]): string => {
  const groups = new Map<string, { readonly holes: readonly number[]; readonly names: string[] }>();
  for (const entry of missing) {
    const key = entry.holes.join(",");
    const existing = groups.get(key);
    if (existing) existing.names.push(nameOf(state, entry.golferId));
    else groups.set(key, { holes: entry.holes, names: [nameOf(state, entry.golferId)] });
  }

  if (groups.size === 0) return "not yet resolved"; // every hole scored, but the game hasn't concluded (defensive — resultOf already gated the caller)

  return [...groups.values()]
    .map((group) => `${group.holes.length === 1 ? "hole" : "holes"} ${formatHoleRanges(group.holes)} unscored for ${group.names.join(", ")}`)
    .join("; ");
};

// The finalize dialog's own readiness check — presentation only now (task 3 of the "domain owns
// the golf math" arc). WHICH games must resolve, and which holes are missing per player, is
// @swng/domain's `unresolvedGames` (round/archive.ts): the identical must-resolve set
// settleRound's own throw path enforces server-side, so what's left after this call is exactly
// what finalize would 409 on right now. This function only turns that structured result into the
// dialog's strings (title via describeGame, "holes X unscored for Y" via describeMissing above).
export const unresolvedGames = (state: RoundState, games: readonly GameState[]): readonly UnresolvedGame[] => {
  const result: UnresolvedGame[] = [];
  for (const game of domainUnresolvedGames(state)) {
    const gameState = games.find((g) => g.id === game.gameId);
    if (!gameState) continue; // an unknown/future kind the session already filtered out of games() — nothing useful to report
    result.push({ gameId: game.gameId, title: describeGame(gameState, state).title, missing: describeMissing(state, game.missing) });
  }
  return result;
};
