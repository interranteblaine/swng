import { cellKey, DomainError, findTeeSet } from "@swng/domain";
import type { GameConfig, GameState, GolferId, Participant, RoundState } from "@swng/domain";

export interface GameDescription {
  readonly title: string;
  readonly line: string;
}

// The brief sketches this as `describeGame(state: GameState, participants)`. GameState alone
// turns out not to carry everything two of the five kinds need to render their brief-mandated
// target strings: stroke-play's "(E)"/"(+N)" needs each hole's par (only on CourseCard, via
// each player's own tee), and fourball-match's outcome/leader are bare "a"/"b" literals (unlike
// singles-match, which already resolves to a real GolferId inside the engine) that only mean
// something once matched back to the GameConfig's `a`/`b` pairs. RoundState already carries
// card + participants + games (the exact "look the frozen config up from state.games" idiom
// ScorecardGrid.tsx's activeConfig lookup already established), so this takes the whole round
// instead of a bare participants array — one extra field of context, not a new kind-switch site.
export const describeGame = (game: GameState, round: RoundState): GameDescription => {
  switch (game.kind) {
    case "stroke-play":
      return { title: `Stroke play (${game.scoring})`, line: describeStrokePlay(game, round) };
    case "stableford":
      return { title: "Stableford", line: describeStableford(game, round) };
    case "singles-match":
      return { title: "Singles match", line: describeSingles(game, round) };
    case "fourball-match":
      return { title: "Fourball match", line: describeFourball(game, round) };
    case "skins":
      return { title: "Skins", line: describeSkins(game, round) };
    default:
      // Exhaustive at compile time (GameState is a discriminated union); guards a runtime
      // value that bypassed it — same defensive shape as domain's own scoreGame/resultOf.
      throw new DomainError("unknown-game-kind", `no description for game kind "${(game as { kind: string }).kind}"`);
  }
};

const nameOf = (participants: readonly Participant[], golfer: GolferId): string => participants.find((p) => p.golferId === golfer)?.name ?? golfer;

// "(E)" for even par, "(+N)"/"(-N)" otherwise — golf's own vs-par notation, used nowhere else
// in the codebase yet (checked) so this is the one place it's defined.
const vsPar = (relative: number): string => (relative === 0 ? "(E)" : relative > 0 ? `(+${relative})` : `(${relative})`);

type StrokePlay = Extract<GameState, { kind: "stroke-play" }>;

const describeStrokePlay = (game: StrokePlay, round: RoundState): string => {
  const entries = game.lines.map((line) => {
    const participant = round.participants.find((p) => p.golferId === line.golferId);
    // Net is only present when the config scored net, and always populated in that case
    // (strokePlay.ts's own invariant) — the non-null assertion mirrors that contract.
    const totals = game.scoring === "net" ? line.net! : line.gross;
    // Par "thru" the holes actually counted so far: teeSet holes are in card order and the
    // scoring UI only ever fills them forward (ScorecardGrid's own "current hole" heuristic
    // makes the same forward-sequential assumption), so the first `thru` holes is the best
    // available par baseline without exposing which specific holes GameState summed.
    const par = participant ? findTeeSet(round.card, participant.tee).holes.slice(0, line.thru).reduce((sum, h) => sum + h.par, 0) : 0;
    return { golferId: line.golferId, thru: line.thru, total: totals.total, relative: totals.total - par };
  });
  if (entries.length === 0) return "No scores yet";
  const lowest = Math.min(...entries.map((e) => e.total));
  return entries
    .filter((e) => e.total === lowest)
    .map((e) => `${nameOf(round.participants, e.golferId)} ${e.total}${game.complete ? "" : ` thru ${e.thru}`} ${vsPar(e.relative)}`)
    .join(" · ");
};

type Stableford = Extract<GameState, { kind: "stableford" }>;

const describeStableford = (game: Stableford, round: RoundState): string => {
  if (game.lines.length === 0) return "No scores yet";
  const highest = Math.max(...game.lines.map((l) => l.points));
  return game.lines
    .filter((l) => l.points === highest)
    .map((l) => `${nameOf(round.participants, l.golferId)} ${l.points} pts${game.complete ? "" : ` thru ${l.thru}`}`)
    .join(" · ");
};

type SinglesMatch = Extract<GameState, { kind: "singles-match" }>;

const describeSingles = (game: SinglesMatch, round: RoundState): string => {
  if (game.outcome) {
    if ("halved" in game.outcome) return "Match halved";
    return `${nameOf(round.participants, game.outcome.winner)} wins ${game.outcome.closing}`;
  }
  if (game.up === 0) return `All square thru ${game.thru}`;
  return `${nameOf(round.participants, game.leader!)} ${game.up} UP thru ${game.thru}${game.dormie ? " · dormie" : ""}`;
};

type FourballMatch = Extract<GameState, { kind: "fourball-match" }>;
type FourballConfig = Extract<GameConfig, { kind: "fourball-match" }>;

const sideNames = (round: RoundState, config: FourballConfig, side: "a" | "b"): string =>
  (side === "a" ? config.a : config.b).map((golfer) => nameOf(round.participants, golfer)).join(" & ");

const describeFourball = (game: FourballMatch, round: RoundState): string => {
  const config = round.games.find((g): g is FourballConfig => g.id === game.id && g.kind === "fourball-match");
  if (!config) return "Fourball match"; // degraded render: config vanished from state.games — shouldn't happen, never crash over it
  if (game.outcome) {
    if ("halved" in game.outcome) return "Match halved";
    return `${sideNames(round, config, game.outcome.winner)} win ${game.outcome.closing}`;
  }
  if (game.up === 0) return `All square thru ${game.thru}`;
  return `${sideNames(round, config, game.leader!)} ${game.up} UP thru ${game.thru}${game.dormie ? " · dormie" : ""}`;
};

type Skins = Extract<GameState, { kind: "skins" }>;
type SkinsConfig = Extract<GameConfig, { kind: "skins" }>;

// Skins' own GameState doesn't carry a `thru` (unlike every other kind) — this replays the
// exact same "every player recorded, in card order, stop at the first gap" walk scoreSkins.ts
// uses internally, purely to name which hole a live carry is riding into. Presentation-only:
// it never touches skins-won math, so it can't disagree with the engine's own settlement.
const skinsHolesDecided = (round: RoundState, config: SkinsConfig): number => {
  const first = round.participants.find((p) => p.golferId === config.players[0]);
  const holes = first ? findTeeSet(round.card, first.tee).holes : [];
  let count = 0;
  for (const hole of holes) {
    if (!config.players.every((golfer) => cellKey(golfer, hole.number) in round.cells)) break;
    count += 1;
  }
  return count;
};

const describeSkins = (game: Skins, round: RoundState): string => {
  const won = game.lines.filter((l) => l.skins > 0);
  const base = won.length > 0 ? won.map((l) => `${nameOf(round.participants, l.golferId)} ${l.skins}`).join(" · ") : "No skins won yet";

  if (game.complete) return game.carriedOut > 0 ? `${base} · ${game.carriedOut} carried out` : base;

  if (game.carrying > 0) {
    const config = round.games.find((g): g is SkinsConfig => g.id === game.id && g.kind === "skins");
    if (config) return `${base} · carrying ${game.carrying} into ${skinsHolesDecided(round, config) + 1}`;
  }
  return base;
};
