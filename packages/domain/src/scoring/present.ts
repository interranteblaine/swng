import type { GameConfig, GameState } from "./game.js";
import { gameMembers } from "./game.js";
import type { GameId, GolferId } from "../ids.js";
import { DomainError } from "../errors.js";
import type { Participant } from "../round/participant.js";
import type { RoundState } from "../round/state.js";
import type { HoleSelection } from "../round/holes.js";
import type { UnresolvedGameMissing } from "../round/archive.js";
import { unresolvedGames } from "../round/archive.js";

// The games' human meaning as domain truth — names, one-line rules, who a game fits, and how its
// strokes convention reads in words. One tested copy: every surface that names a game renders
// through these, so the copy can never fork per view. Pure formatters — no golf RESULT is
// computed here, which is why the web may import them directly (they are not in the
// compute-fence banlist). gameTreatment's singles-match arm reads two ALREADY-STORED roster
// numbers (Participant.strokes) and compares them — the same register as underPar below (a
// comparison of stored inputs), not a second copy of gameStrokeAllocation's per-hole placement
// rule, which is the only thing that needs a CourseCard.
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

// Which holes a round set out to play (spec 2026-08-02 §3/§6, task 8b) — the ONE label table
// every surface renders through. CreateRoundPage's create-time picker and SetupPanel's mid-round
// editor each carried their own copy of these three strings; a join screen rendering a third
// copy is exactly how "Front 9" on one screen becomes "Front nine" on another, so both are
// deleted in favor of this. The wording is the one already on screen — pinned by existing web
// tests, so it cannot move here either.
//
// Throws on an unknown arm rather than falling back (the scoreGame/resultOf "unknown-game-kind"
// idiom, this file's own precedent for a runtime value that bypasses the type system):
// SetupPanel's own retired `?? "18 holes"` would have rendered the WRONG label for a future
// fourth arm instead of surfacing the gap.
export const holeSelectionLabel = (selection: HoleSelection): string => {
  switch (selection) {
    case "all":
      return "18 holes";
    case "front":
      return "Front 9";
    case "back":
      return "Back 9";
    default:
      // The union is exhaustive at compile time; this guards runtime inputs that bypass the type
      // system (a deserialized peek response, or a stored round, from an older or foreign client).
      throw new DomainError("unknown-hole-selection", `no label for hole selection "${selection as unknown as string}"`);
  }
};

// The order the three selections render in — every picker (CreateRoundPage's create-time
// picker, SetupPanel's mid-round editor) mapped its own `["all", "front", "back"]` array beside
// the shared label above; that's the same one-copy drift risk task 8b already fixed for the
// words themselves (whole-branch review Finding 4). One array, beside the labels it orders.
//
// Written as a `satisfies Record<HoleSelection, true>` object rather than a plain string array
// (the KNOWN_GAME_KINDS_BY_KIND precedent, @swng/client's scoring.ts) so a future arm added to
// `HoleSelection` fails THIS build with a missing-key error instead of silently compiling — a
// plain `readonly HoleSelection[]` literal would still typecheck with the new arm simply absent,
// which is exactly how it could vanish from both pickers while `holeSelectionLabel` above (which
// throws on an unrecognized value) kept working. `Object.keys` preserves insertion order for
// plain string keys (the ECMAScript spec's own guarantee), so the render order this object is
// written in is preserved exactly.
const HOLE_SELECTION_ORDER_BY_SELECTION = {
  all: true,
  front: true,
  back: true,
} satisfies Record<HoleSelection, true>;

export const HOLE_SELECTION_ORDER: readonly HoleSelection[] = Object.keys(HOLE_SELECTION_ORDER_BY_SELECTION) as HoleSelection[];

// One seat's asserted number, or 0 if that golfer isn't on the roster handed in. Shared by the two
// sentences below so they can never disagree about what a seat holds.
//
// That `?? 0` is a DELIBERATE disagreement with `gameStrokeAllocation`, which throws
// `unknown-participant` on the identical input (allocation.ts's `participantFor`), and the split is
// the right way round: a formatter degrades, a computation refuses. Inventing a 0 to say a sentence
// with is recoverable; inventing a 0 to place DOTS with would put wrong strokes on a real card.
// Both are unreachable through the API anyway — `addGame` rejects a game naming a non-participant
// (unknown-golfer-in-game) — and in the two places both are rendered, the refusal happens FIRST and
// wins: `strokesSummary` (which goes through the allocation) is computed above the note in both
// GamePanel.tsx and AddGameForm.tsx, and for the two match kinds these sentences speak for it
// always computes dots, so a bad member takes the whole panel down rather than showing a degraded
// sentence beside a computed one. The two can never be seen contradicting each other on screen.
const strokesOn = (participants: readonly Participant[], id: GolferId): number => participants.find((p) => p.golferId === id)?.strokes ?? 0;

// One treatment line for every kind, gross included — the ONE copy every panel and the add-game
// preview render through. A card is absolute, a match is relative (spec 2026-07-30 §3): there are
// two behaviours, so there are two sentences, not one softened to cover both (the prior arc's own
// single net sentence was collapsed across all three medal kinds AND the two match kinds, which
// made it false for the match kinds — a singles/fourball panel showing different dots than the
// card is CORRECT, and the panel now says why instead of leaving the player to discover it alone).
//
// Medal kinds (stroke play, Stableford, skins) use each player's own roster number, so the line
// names the CARD — it is the same number either way, by construction, so there is nothing to
// compute here.
//
// Match kinds use the DIFFERENCE off the lowest of the game's own field. Four-ball's completion
// ("everyone off the lowest of the four") is a fixed structural fact, true regardless of the actual
// numbers, so its arm ignores the roster. Singles' completion genuinely varies per pairing, so it
// reads `participants` — REQUIRED (whole-branch review Minor 5): the argument used to default to
// `[]`, which silently resolved a real singles pairing to a 0-vs-0 tie and printed "level, nobody
// receives" about two players who are nothing of the sort. A caller with no roster in scope has to
// pass `[]` and say so; the degradation is still honest, it just can't happen by omission.
export const gameTreatment = (config: GameConfig, participants: readonly Participant[]): string => {
  if ("scoring" in config && config.scoring === "gross") return "Gross — raw scores, no strokes";
  switch (config.kind) {
    case "stroke-play":
    case "skins":
    case "stableford":
      return "Net — uses the strokes on the card";
    case "fourball-match":
      return "Played off the difference — everyone off the lowest of the four";
    case "singles-match": {
      const strokesOf = (id: GolferId): number => strokesOn(participants, id);
      const diff = strokesOf(config.a) - strokesOf(config.b);
      // Not "{name} gets 0" (the SeasonPanel precedent, crews/SeasonPanel.tsx): a tie is a real,
      // honest answer once strokes are a plain count, not a nonsensical sentence to suppress.
      if (diff === 0) return "Played off the difference — level, nobody receives";
      const receiverId = diff > 0 ? config.a : config.b;
      const receiverName = participants.find((p) => p.golferId === receiverId)?.name ?? receiverId;
      return `Played off the difference — ${receiverName} gets ${Math.abs(diff)}`;
    }
  }
};

// The sentence under the treatment line, for the two kinds where WHO GETS NOTHING is worth saying
// out loud: strokes are relative now, so in a match somebody receives nothing and the rule that
// decides it is worth stating. The other three kinds get nothing here on purpose — gameTreatment's
// own net line already states their field, and a note repeating it would just be the same sentence
// twice.
//
// It reads the game's own field for ONE reason: to know whether there is anything to say at all.
// "The lowest gets none" is a claim about somebody ELSE getting some, so it is FALSE when nobody
// is above the lowest — including all-zeros, which this arc made the default state of every new
// round (spec 2026-07-30 §2, whole-branch review I1). In that case the strokes line printed
// directly above it already says the true thing ("No strokes — everyone in this game plays
// level.", apps/web/src/round/dots.ts), so this returns nothing rather than contradicting it, for
// the same reason the three medal kinds return nothing: one sentence, once.
//
// Four-ball's wording is a rule, not a COUNT. "Only the three higher numbers" was false whenever
// two members tied at the bottom — at 20/20/10/10 the match arm gives strokes to TWO of the four,
// not three — and ties are ordinary, not exotic. Singles keeps its concrete wording because with
// two members and someone above the lowest there is exactly one higher and one lower, always.
//
// The comparison is the same register as gameTreatment's singles arm above — already-stored roster
// numbers, ranked — not a second copy of gameStrokeAllocation's per-hole placement rule. It agrees
// with that function by construction (its match arm allocates `strokes - lowest`, positive for
// exactly the members named here), and present.test.ts pins that agreement against the real
// allocation so the sentence can't quietly drift from the dots.
//
// Neither arm says "plays off scratch" (controller ruling, post-task-1). Receiving nothing in a
// match is not the same as being a scratch golfer: two players who both typed 20 each carry 20
// dots on the card and simply give each other none here, because the difference is zero. Getting
// none in one game says nothing about how you play — and "scratch" is handicap-era vocabulary for
// playing to par, which nothing in this model computes.
export const strokesNote = (config: GameConfig, participants: readonly Participant[]): string | undefined => {
  switch (config.kind) {
    case "stroke-play":
    case "stableford":
    case "skins":
      return undefined;
    case "singles-match":
    case "fourball-match": {
      // Never empty for a match kind: singles carries two required ids and four-ball two pairs.
      const numbers = gameMembers(config).map((id) => strokesOn(participants, id));
      const lowest = Math.min(...numbers);
      if (!numbers.some((strokes) => strokes > lowest)) return undefined;
      return config.kind === "singles-match"
        ? "Only the higher number gets strokes — the lower gets none."
        : "Only the numbers above the lowest get strokes — the lowest gets none.";
    }
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

// The vs-par figure for a raw (score, par) pair, in one call. `score - par` is legitimate DISPLAY
// arithmetic over two already-known facts (the same register as `underPar` above — a comparison
// of stored inputs, not a rule), but it belongs in ONE formatter, not retyped at each call site:
// RecordSections.tsx's history row used to do the subtraction inline (task-5 fix round, spec
// 2026-07-30 §10 review) — which meant the fence's `no-restricted-syntax` selector had to carry
// two `eslint-disable-next-line` exemptions to let it stay legal, and an exemption covers the
// WHOLE line, so the original leak (`(score - par) * 2`) could be restored on that exact line
// verbatim with lint still green. Routing the subtraction through this fence-allowed formatter
// instead removes the arithmetic from apps/web/src entirely, so no exemption is needed and the
// fence re-arms on the one line the leak actually lived on.
//
// A nine-hole round's DOUBLED contribution is fed through this SAME helper, never a second
// formatter: `formatScoreVsPar(nineHoleContribution(score), nineHoleContribution(par))` equals
// `formatScoreVsPar(2 * score, 2 * par)` equals `formatOverPar(2 * (score - par))` — i.e. exactly
// `formatOverPar(nineHoleContribution(score - par))` by distributivity — so the DOUBLING RULE
// still runs through `nineHoleContribution` alone (@swng/client), applied to each raw input
// separately as a function argument rather than to their difference, which is what keeps the
// multiplication out of any BinaryExpression the fence would otherwise need to see.
export const formatScoreVsPar = (score: number, par: number): string => formatOverPar(score - par);

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

const nameOfParticipant = (participants: readonly Participant[], golfer: GolferId): string => participants.find((p) => p.golferId === golfer)?.name ?? golfer;

// A vs-par figure in parentheses, for the inline "Ann 74 (+2)" register a chip/panel line uses.
// The SIGN itself is the model's one convention (`formatOverPar`, spec 2026-07-29 §4) — this adds
// only the brackets, so the web holds no second copy of "how a signed number reads". Named for
// what it does, not for what it wraps: the deleted `ui/vsPar.ts` was the SIGN renderer, and reusing
// that name for a paren-wrapper invites a reader to think this is it.
export const inParens = (relative: number): string => `(${formatOverPar(relative)})`;

type StrokePlay = Extract<GameState, { kind: "stroke-play" }>;

const describeStrokePlay = (game: StrokePlay, round: RoundState): string => {
  if (game.lines.length === 0) return "No scores yet";
  return game.lines
    .filter((line) => game.leaders.includes(line.golferId))
    .map((line) => {
      // Net is only present when the config scored net, and always populated in that case
      // (strokePlay.ts's own invariant) — the non-null assertion mirrors that contract.
      const total = game.scoring === "net" ? line.net!.total : line.gross.total;
      return `${nameOfParticipant(round.participants, line.golferId)} ${total}${game.complete ? "" : ` thru ${line.thru}`} ${inParens(line.relativeToPar)}`;
    })
    .join(" · ");
};

type Stableford = Extract<GameState, { kind: "stableford" }>;

const describeStableford = (game: Stableford, round: RoundState): string => {
  if (game.lines.length === 0) return "No scores yet";
  return game.lines
    .filter((l) => game.leaders.includes(l.golferId))
    .map((l) => `${nameOfParticipant(round.participants, l.golferId)} ${l.points} pts${game.complete ? "" : ` thru ${l.thru}`}`)
    .join(" · ");
};

type SinglesMatch = Extract<GameState, { kind: "singles-match" }>;

const describeSingles = (game: SinglesMatch, round: RoundState): string => {
  if (game.outcome) {
    if ("halved" in game.outcome) return "Match halved";
    return `${nameOfParticipant(round.participants, game.outcome.winner)} wins ${game.outcome.closing}`;
  }
  if (game.up === 0) return `All square thru ${game.thru}`;
  return `${nameOfParticipant(round.participants, game.leader!)} ${game.up} UP thru ${game.thru}`;
};

type FourballMatch = Extract<GameState, { kind: "fourball-match" }>;
type FourballConfig = Extract<GameConfig, { kind: "fourball-match" }>;

const sideNames = (round: RoundState, config: FourballConfig, side: "a" | "b"): string =>
  (side === "a" ? config.a : config.b).map((golfer) => nameOfParticipant(round.participants, golfer)).join(" & ");

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
  const base = won.length > 0 ? won.map((l) => `${nameOfParticipant(round.participants, l.golferId)} ${l.skins}`).join(" · ") : "No skins won yet";

  if (game.complete) return game.carriedOut > 0 ? `${base} · ${game.carriedOut} carried out` : base;

  if (game.carrying > 0) return `${base} · carrying ${game.carrying} into ${game.holesDecided + 1}`;
  return base;
};

// "Pat 5 dots · Alex 1 dot" over ALREADY-COMPUTED dots — a formatter, which is why it may live
// here. Allocation is not: it needs a CourseCard, and this module computes no golf result.
// Members with no strokes are omitted; a game where nobody receives says so in words, because
// "everyone plays off 0" would be false for a match, where zero dots means the members are EQUAL
// at whatever level, not scratch (spec 2026-07-30 §3).
export const strokesLine = (entries: readonly { readonly name: string; readonly dots: number }[]): string => {
  const parts = entries.filter((entry) => entry.dots > 0).map((entry) => `${entry.name} ${entry.dots} ${entry.dots === 1 ? "dot" : "dots"}`);
  return parts.length > 0 ? parts.join(" · ") : "No strokes — everyone in this game plays level.";
};

export interface UnresolvedGameDescription {
  readonly gameId: GameId;
  readonly title: string; // the game chip's OWN naming (describeGame's title) — never a hand-rolled label here
  readonly missing: string; // e.g. "holes 2–18 unscored for Pat"
}

const nameOfInRound = (state: RoundState, golfer: GolferId): string => state.participants.find((p) => p.golferId === golfer)?.name ?? golfer;

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
    if (existing) existing.names.push(nameOfInRound(state, entry.golferId));
    else groups.set(key, { holes: entry.holes, names: [nameOfInRound(state, entry.golferId)] });
  }

  if (groups.size === 0) return "not yet resolved"; // every hole scored, but the game hasn't concluded (defensive — resultOf already gated the caller)

  return [...groups.values()]
    .map((group) => `${group.holes.length === 1 ? "hole" : "holes"} ${formatHoleRanges(group.holes)} unscored for ${group.names.join(", ")}`)
    .join("; ");
};

// The finalize dialog's own readiness check — presentation only now (task 3 of the "domain owns
// the golf math" arc). WHICH games must resolve, and which holes are missing per player, is
// this module's own `unresolvedGames` (round/archive.ts): the identical must-resolve set
// settleRound's own throw path enforces server-side, so what's left after this call is exactly
// what finalize would 409 on right now. This function only turns that structured result into the
// dialog's strings (title via describeGame, "holes X unscored for Y" via describeMissing above).
export const describeUnresolvedGames = (state: RoundState, games: readonly GameState[]): readonly UnresolvedGameDescription[] => {
  const result: UnresolvedGameDescription[] = [];
  for (const game of unresolvedGames(state)) {
    const gameState = games.find((g) => g.id === game.gameId);
    if (!gameState) continue; // an unknown/future kind the session already filtered out of games() — nothing useful to report
    result.push({ gameId: game.gameId, title: describeGame(gameState, state).title, missing: describeMissing(state, game.missing) });
  }
  return result;
};
