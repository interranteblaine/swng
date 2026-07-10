import { cellKey, resultOf } from "@swng/domain";
import type { GameId, GameState, GolferId, RoundState } from "@swng/domain";
import { describeGame } from "../games/describeGame";
import { gamePlayers } from "./dots";

export interface UnresolvedGame {
  readonly gameId: GameId;
  readonly title: string; // the game chip's OWN naming (describeGame's title) — never a hand-rolled label here
  readonly missing: string; // e.g. "holes 2–18 unscored for Pat"
}

// Same convention as ScorecardGrid.tsx/HoleDigest.tsx's own canonicalHoles — the first tee
// set's hole numbering, shared by every tee at a course (only yardage/rating/slope vary).
const canonicalHoles = (state: RoundState) => state.card.teeSets[0]?.holes ?? [];

const missingHolesFor = (state: RoundState, golfer: GolferId): readonly number[] =>
  canonicalHoles(state)
    .filter((hole) => !(cellKey(golfer, hole.number) in state.cells))
    .map((hole) => hole.number);

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
// repetitive clause per golfer.
const describeMissing = (state: RoundState, players: readonly GolferId[]): string => {
  const groups = new Map<string, { readonly holes: readonly number[]; readonly names: string[] }>();
  for (const golfer of players) {
    const holes = missingHolesFor(state, golfer);
    if (holes.length === 0) continue;
    const key = holes.join(",");
    const existing = groups.get(key);
    if (existing) existing.names.push(nameOf(state, golfer));
    else groups.set(key, { holes, names: [nameOf(state, golfer)] });
  }

  if (groups.size === 0) return "not yet resolved"; // every hole scored, but the game hasn't concluded (defensive — resultOf already gated the caller)

  return [...groups.values()]
    .map((group) => `${group.holes.length === 1 ? "hole" : "holes"} ${formatHoleRanges(group.holes)} unscored for ${group.names.join(", ")}`)
    .join("; ");
};

// The finalize dialog's own readiness check, computed from the LOCAL fold (brief: "game config
// × cells × terminatedGameIds") — a terminated game never appears here (settleRound's own
// must-resolve set already excludes it; this mirrors that exclusion client-side) and a resolved
// game (resultOf(gameState) !== undefined) doesn't either, so what's left is exactly what
// finalize would 409 on right now.
export const unresolvedGames = (state: RoundState, games: readonly GameState[]): readonly UnresolvedGame[] => {
  const result: UnresolvedGame[] = [];
  for (const config of state.games) {
    if (state.terminatedGameIds.has(config.id)) continue;
    const gameState = games.find((g) => g.id === config.id);
    if (!gameState) continue; // an unknown/future kind the session already filtered out of games() — nothing useful to report
    if (resultOf(gameState) !== undefined) continue;
    result.push({ gameId: config.id, title: describeGame(gameState, state).title, missing: describeMissing(state, gamePlayers(config)) });
  }
  return result;
};
