import { DomainError, formatOverPar, gameKindLabel } from "@swng/domain";
import type { GameConfig, GameState, GolferId, Participant, RoundState } from "@swng/domain";

export interface GameDescription {
  readonly title: string;
  readonly line: string;
}

// The brief sketches this as `describeGame(state: GameState, participants)`. GameState alone
// turns out not to carry everything every kind needs to render: every kind needs
// round.participants to turn a GolferId into a display name (nameOf), and fourball-match's
// outcome/leader are bare "a"/"b" literals (unlike singles-match, which already resolves to a
// real GolferId inside the engine) that only mean something once matched back to the
// GameConfig's `a`/`b` pairs via round.games. RoundState already carries participants + games
// (the exact "look the frozen config up from state.games" idiom ScorecardGrid.tsx's
// activeConfig lookup already established), so this takes the whole round instead of a bare
// participants array — one extra field of context, not a new kind-switch site. Every number
// this module renders — relative-to-par, the medal-play leader(s), skins' holesDecided — is
// computed once in the matching scoring engine (game.ts's GameState) and read here as-is:
// this module is pure string formatting, never math.
export const describeGame = (game: GameState, round: RoundState): GameDescription => {
  switch (game.kind) {
    case "stroke-play":
      return { title: `${gameKindLabel("stroke-play")} (${game.scoring})`, line: describeStrokePlay(game, round) };
    case "stableford":
      return { title: gameKindLabel("stableford"), line: describeStableford(game, round) };
    case "singles-match":
      return { title: gameKindLabel("singles-match"), line: describeSingles(game, round) };
    case "fourball-match":
      return { title: gameKindLabel("fourball-match"), line: describeFourball(game, round) };
    case "skins":
      // Suffixed like stroke play's, and for the same reason: two skins pots (one gross, one net)
      // over the same card are a real setup, and two chips reading a bare "Skins" would be
      // indistinguishable.
      return { title: `${gameKindLabel("skins")} (${game.scoring})`, line: describeSkins(game, round) };
    default:
      // Exhaustive at compile time (GameState is a discriminated union); guards a runtime
      // value that bypassed it — same defensive shape as domain's own scoreGame/resultOf.
      throw new DomainError("unknown-game-kind", `no description for game kind "${(game as { kind: string }).kind}"`);
  }
};

const nameOf = (participants: readonly Participant[], golfer: GolferId): string => participants.find((p) => p.golferId === golfer)?.name ?? golfer;

// A vs-par figure in parentheses, for the inline "Ann 74 (+2)" register a chip/panel line uses.
// The SIGN itself is the model's one convention (`formatOverPar`, spec 2026-07-29 §4) — this adds
// only the brackets, so the web holds no second copy of "how a signed number reads".
export const vsPar = (relative: number): string => `(${formatOverPar(relative)})`;

type StrokePlay = Extract<GameState, { kind: "stroke-play" }>;

const describeStrokePlay = (game: StrokePlay, round: RoundState): string => {
  if (game.lines.length === 0) return "No scores yet";
  return game.lines
    .filter((line) => game.leaders.includes(line.golferId))
    .map((line) => {
      // Net is only present when the config scored net, and always populated in that case
      // (strokePlay.ts's own invariant) — the non-null assertion mirrors that contract.
      const total = game.scoring === "net" ? line.net!.total : line.gross.total;
      return `${nameOf(round.participants, line.golferId)} ${total}${game.complete ? "" : ` thru ${line.thru}`} ${vsPar(line.relativeToPar)}`;
    })
    .join(" · ");
};

type Stableford = Extract<GameState, { kind: "stableford" }>;

const describeStableford = (game: Stableford, round: RoundState): string => {
  if (game.lines.length === 0) return "No scores yet";
  return game.lines
    .filter((l) => game.leaders.includes(l.golferId))
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
  return `${nameOf(round.participants, game.leader!)} ${game.up} UP thru ${game.thru}`;
};

type FourballMatch = Extract<GameState, { kind: "fourball-match" }>;
type FourballConfig = Extract<GameConfig, { kind: "fourball-match" }>;

const sideNames = (round: RoundState, config: FourballConfig, side: "a" | "b"): string =>
  (side === "a" ? config.a : config.b).map((golfer) => nameOf(round.participants, golfer)).join(" & ");

const describeFourball = (game: FourballMatch, round: RoundState): string => {
  const config = round.games.find((g): g is FourballConfig => g.id === game.id && g.kind === "fourball-match");
  if (!config) return gameKindLabel("fourball-match"); // degraded render: config vanished from state.games — shouldn't happen, never crash over it
  if (game.outcome) {
    if ("halved" in game.outcome) return "Match halved";
    return `${sideNames(round, config, game.outcome.winner)} win ${game.outcome.closing}`;
  }
  if (game.up === 0) return `All square thru ${game.thru}`;
  return `${sideNames(round, config, game.leader!)} ${game.up} UP thru ${game.thru}`;
};

type Skins = Extract<GameState, { kind: "skins" }>;

const describeSkins = (game: Skins, round: RoundState): string => {
  const won = game.lines.filter((l) => l.skins > 0);
  const base = won.length > 0 ? won.map((l) => `${nameOf(round.participants, l.golferId)} ${l.skins}`).join(" · ") : "No skins won yet";

  if (game.complete) return game.carriedOut > 0 ? `${base} · ${game.carriedOut} carried out` : base;

  if (game.carrying > 0) return `${base} · carrying ${game.carrying} into ${game.holesDecided + 1}`;
  return base;
};
