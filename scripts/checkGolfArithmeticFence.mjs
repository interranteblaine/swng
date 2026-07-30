// The re-derivation fence's coverage, EXECUTED rather than asserted in prose.
//
// `eslint.config.mjs`'s `no-restricted-syntax` rule stops the web from re-deriving a golf rule
// inline over a served number (see its comment there for what that means and why it matters).
// Three consecutive fix rounds shipped a hole in that rule underneath a comment claiming
// otherwise — the worst of them silently stopped catching `hole.par * 2`, the exact rule the
// arc had just moved into `@swng/domain`. Every round's mutation evidence was gathered by hand
// and then thrown away, so the next round started blind.
//
// This is that evidence, kept. Each line of FIXTURE carries a `// FIRE` or `// SILENT` marker and
// is checked against the REAL rule, loaded from the REAL config. It cannot drift from the rule
// because it runs the rule — this is not a second fence with its own coverage (an earlier round
// tried that and rightly deleted it), it is a regression pin on the only one.
//
// The fixture is linted as VIRTUAL text at a path inside `apps/web/src`, so it exercises the same
// config block the real web files do without existing as a file that `eslint .` would then have to
// report on.
//
// Run by `pnpm lint`. If it fails: a FIRE line that went silent is lost coverage — do not "fix" it
// by editing the marker. A SILENT line that fired is a false positive, which is how a fence earns
// itself deleted by the next person; narrow the rule, don't delete the case.

import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Linted at this virtual path (plus an extension, see EXTENSIONS below) so the `apps/web/src/**`
// config block applies. No such file exists.
const FIXTURE_PATH = "apps/web/src/__golfArithmeticFenceFixture__";

const FIXTURE = `
// Params are untyped on purpose: this file is parsed, never typechecked, and the fence matches
// syntax rather than types.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function fixture(a, b, l, h, p, rows, holes, total, useNet, gross, key, entry, tee, x, game, standings, m, g, d, sink) {
  let t = 0;

  // --- the spellings every review round has planted, in the shapes they were planted in --------
  sink(a.average - b.average); // FIRE plain difference (the crew board's own deleted leak)
  sink(b.average - a.average); // FIRE reversed operands
  sink(2 * (l.score - l.par)); // FIRE the arithmetic nested one level in
  sink((a.average ?? 0) - (b.average ?? 0)); // FIRE ?? narrowing
  sink(a.average! - b.average!); // FIRE ! narrowing
  sink((a.average as number) - (b.average as number)); // FIRE as narrowing
  sink((h.par satisfies number) * 2); // FIRE satisfies narrowing
  sink(-l.par + l.score); // FIRE unary minus
  sink(+l.par * 2); // FIRE unary plus
  sink(h.par * 2); // FIRE the nine-hole doubling rule itself
  sink(2 * h.par); // FIRE ... reversed
  sink(l.score * 2); // FIRE ... spelled over the OTHER operand
  sink(l.score * 2 - l.par * 2); // FIRE ... fully inlined, both sides
  sink((rows[0]?.average ?? 0) - (rows[1]?.average ?? 0)); // FIRE optional chain under ??
  sink(rows[0]?.par * 2); // FIRE optional chain with no ?? at all
  sink(rows[0]?.average - rows[1]?.average); // FIRE ... on both sides
  sink((rows[0]?.par as number) * 2); // FIRE as over a chain
  sink((a.average ?? 0)! - 1); // FIRE two stacked wrappers
  sink(((a.average ?? 0) as number)! - 1); // FIRE three stacked wrappers
  sink(-(l.par!) * 2); // FIRE unary over !
  sink(l["par"] * 2); // FIRE computed member access
  sink(a["average"] - b["average"]); // FIRE ... on both sides
  sink(total - (useNet ? a.average : 0)); // FIRE a ternary's value arm
  sink(total - (useNet ? 0 : a.average)); // FIRE ... the other arm
  sink((gross ?? 0) - p.strokes); // FIRE one wrapped operand, one bare
  const raw = l.score - l.par; // FIRE the first half of a two-statement re-derivation
  sink(raw);

  // --- every arithmetic operator, binary and compound-assign ----------------------------------
  sink(p.strokes - 1); // FIRE minus
  sink(l.par / 2); // FIRE divide — the nine-hole halving
  sink(Math.round(p.strokes / 2)); // FIRE ... as resolveStrokes actually spells it
  sink(Math.floor(p.strokes / holes)); // FIRE ... as allocateStrokes spells base dots
  sink(2 / h.par); // FIRE divide, field on the right
  sink(rows[0]?.strokes / 2); // FIRE divide through a chain
  sink(p.strokes! / 2); // FIRE divide through a !
  sink(h.par % 18); // FIRE modulo — allocateStrokes' extra dots
  sink(total % h.par); // FIRE modulo, field on the right
  sink(h.par ** 2); // FIRE exponent
  sink((a.points / total) * 100); // FIRE a percentage of a served number is still arithmetic on it
  t += h.par; // FIRE the hand-rolled par sum, as an accumulator
  t -= h.par; // FIRE
  t *= h.par; // FIRE
  t /= h.par; // FIRE
  t %= h.par; // FIRE
  t **= h.par; // FIRE
  t += h.par ?? 0; // FIRE an accumulator over a wrapped operand
  t += rows[0]?.par; // FIRE ... over a chained one
  t += useNet ? a.average : 0; // FIRE ... over a ternary arm
  sink(holes.reduce((s, y) => s + y.par, 0)); // FIRE the hand-rolled par sum, as a reduce
  sink(holes.reduce((s, y) => s + (y.par ?? 0), 0)); // FIRE ... with a wrapped operand

  // --- the served fields, across the whole property axis ---------------------------------------
  sink(b.points - a.points); // FIRE stableford ranking
  sink(b.skins - a.skins); // FIRE skins ranking
  sink(a.relativeToPar - b.relativeToPar); // FIRE stroke-play ranking
  sink(b.thru - a.thru); // FIRE ... its own tiebreak
  sink(a.toPar - b.toPar); // FIRE vs-par ranking
  sink(l.gross.total - l.net.total); // FIRE gross minus net
  sink(t + h.pot); // FIRE skins carry
  sink(g.carrying + g.pot); // FIRE ... the other half
  sink(g.remaining - g.up); // FIRE the dormie margin
  sink(a.wins - b.wins); // FIRE a season tally
  sink(d.birdies + d.eagles); // FIRE distribution buckets
  sink(a.spread - b.spread); // FIRE crew-board spread
  sink(a.best18 - b.best18); // FIRE bests
  sink(a.dots - b.dots); // FIRE allocated dots
  sink(h.strokeIndex - 1); // FIRE allocation input
  sink(m.rounds - 3); // FIRE the round-count floor a fold gates on

  // --- must stay SILENT: legitimate code. A false positive here is how a fence gets deleted. ---
  sink("Par " + h.par); // SILENT string concatenation for display
  sink(p.strokes + 1); // SILENT a UI stepper
  sink(1 + p.strokes); // SILENT ... reversed
  sink(t + (p.strokes > 0 ? 1 : 0)); // SILENT a golf field in a ternary's TEST, not its value
  sink(l.skins > 0); // SILENT a membership filter (describeGame.ts does exactly this)
  sink(a.average !== undefined); // SILENT a presence check
  sink(h.par === 3); // SILENT an equality check
  sink(p.strokes); // SILENT a plain read
  sink(rows[0]?.par); // SILENT a plain chained read
  sink(l.holes === 9 ? l.par : 0); // SILENT a ternary with no arithmetic around it
  sink(holes.length - 1); // SILENT .length is not a golf number
  sink(game.holes.length - 1); // SILENT ... even when the array is named like one
  sink(standings.rounds.length / 2); // SILENT ... same
  sink(total + 1); // SILENT arithmetic on a local
  sink(h.number - 1); // SILENT a hole NUMBER is an identifier
  sink(entry.hole - h.number); // SILENT ... so is .hole
  sink(h.yardage - 1); // SILENT card metadata, computed from nowhere
  sink(tee.rating - 70); // SILENT ... same
  sink(tee.slope / 113); // SILENT ... same (and the rule this once spelled is deleted, not moved)
  sink(x.finalizedAt - x.createdAt); // SILENT timestamps
  sink(x.seq + 1); // SILENT a sequence number

  // --- must stay SILENT: the documented residuals. If one of these starts firing, the rule got
  //     wider than its comment says — reconcile the comment, don't just move the marker. --------
  sink(Number(a.average) - Number(b.average)); // SILENT a call wrapper (deliberately transparent-to-nobody)
  sink(Math.max(a.par, b.par) - 1); // SILENT ... same
  const { score, par } = l; // SILENT destructured read
  sink(score - par); // SILENT ... and the arithmetic, now with no field read in sight
  sink(a.average! > b.average! ? 1 : -1); // SILENT a comparator-spelled ranking
  sink(l[key] * 2); // SILENT computed access through a variable
  h.par++; // SILENT an increment is not one of the arithmetic operators
  h.par += 1; // SILENT ... and += with a literal carries the same + ambiguity as h.par + 1

  // --- known OVER-fires: the rule reports these, and that is the accepted side of a tradeoff.
  //     Pinned so the behaviour is recorded rather than discovered. -----------------------------
  sink("Par " + (h.par ?? 0)); // FIRE display concat where the operand is WRAPPED — see the residuals
  h.par -= 1; // FIRE mutating a served field via a non-+ compound assign

  sink(t);
}
`;

const eslint = new ESLint({ cwd: REPO_ROOT });

const firedLinesAt = async (filePath) => {
  const [result] = await eslint.lintText(FIXTURE, { filePath });
  const fatal = result.messages.filter((m) => m.fatal);
  if (fatal.length > 0) {
    console.error(
      `golf-arithmetic fence: the fixture failed to PARSE at ${filePath} — the check proved nothing.`,
    );
    for (const m of fatal) console.error(`  line ${m.line}: ${m.message}`);
    process.exit(1);
  }
  return new Set(
    result.messages.filter((m) => m.ruleId === "no-restricted-syntax").map((m) => m.line),
  );
};

// WHICH FILES THE RULE APPLIES TO IS A FOURTH AXIS, and it is the one that fails silently and
// biggest. Narrowing the config block's `files` glob from `*.{ts,tsx}` to `*.ts` — four deleted
// characters — turns the fence off for every React component in the app, which is 40 of the ~60
// web source files and ALL FOUR of the files whose leaks motivated the rule
// (RecordSections.tsx, GamePanel.tsx, SeasonPanel.tsx, ResultsView.tsx). `pnpm lint` stays green
// throughout. So the fixture is linted at BOTH extensions and both must agree: covering one and
// not the other is itself the failure.
const EXTENSIONS = ["ts", "tsx"];
const fired = Object.fromEntries(
  await Promise.all(EXTENSIONS.map(async (ext) => [ext, await firedLinesAt(`${FIXTURE_PATH}.${ext}`)])),
);

const failures = [];
let expectedFire = 0;
let expectedSilent = 0;
FIXTURE.split("\n").forEach((text, i) => {
  const marker = /\/\/ (FIRE|SILENT) (.*)$/.exec(text);
  if (!marker) return;
  const [, expected, why] = marker;
  if (expected === "FIRE") expectedFire += 1;
  else expectedSilent += 1;
  for (const ext of EXTENSIONS) {
    const didFire = fired[ext].has(i + 1);
    if (didFire === (expected === "FIRE")) continue;
    failures.push(
      `  ${expected === "FIRE" ? "LOST COVERAGE" : "FALSE POSITIVE"} (.${ext} files): ` +
        `${text.trim().split("//")[0].trim()}` +
        `\n      expected ${expected}, got ${didFire ? "FIRE" : "SILENT"} — ${why}`,
    );
  }
});

// A fixture that stops exercising the rule (a parser change, a config move) would otherwise pass
// silently with zero cases. Pin the shape of the evidence, not just its verdict.
if (expectedFire < 61 || expectedSilent < 29) {
  console.error(
    `golf-arithmetic fence: the fixture shrank (${expectedFire} FIRE / ${expectedSilent} SILENT cases).` +
      " Cases are only ever added here, never removed — if you deleted one, put it back.",
  );
  process.exit(1);
}

if (failures.length > 0) {
  console.error(
    `golf-arithmetic fence: ${failures.length} of ${expectedFire + expectedSilent} cases disagree with eslint.config.mjs's rule.\n` +
      failures.join("\n"),
  );
  process.exit(1);
}

console.log(
  `golf-arithmetic fence: ${expectedFire} re-derivation spellings caught, ${expectedSilent} legitimate shapes left alone,` +
    ` in both .ts and .tsx files.`,
);
