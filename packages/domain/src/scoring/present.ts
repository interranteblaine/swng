import type { GameConfig } from "./game.js";
import { gameMembers } from "./game.js";
import type { GolferId } from "../ids.js";
import type { Participant } from "../round/participant.js";

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

// One seat's asserted number, or 0 if that golfer isn't on the roster handed in. Shared by the two
// sentences below so they can never disagree about what a seat holds.
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
