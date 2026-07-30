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
// The check has two halves, because a fence has two ways to fail:
//
//   1. WHICH FILES IT COVERS. Every real, non-test source file under `apps/web/src` must resolve a
//      config that actually contains the rule. This half is enumerated FROM THE TREE, so a new file
//      or directory is covered by construction rather than by a list someone has to remember to
//      extend. It exists because the `files`/`ignores` globs turned out to be a whole axis of
//      silent failure: `**/*.{ts,tsx}` → `*.{ts,tsx}` (three characters) drops 53 of 59 files, and
//      widening `ignores` with `**/[A-Z]*.tsx` drops every React component — both with `pnpm lint`
//      green, and both survive any check that only lints a fixture at one made-up path.
//   2. WHAT IT CATCHES. The fixture below is linted as virtual TEXT at real file paths sampled from
//      that same enumeration, and every marked line is checked against a FIRE/SILENT expectation.
//      Using real paths (not an invented one) is what ties this half to the first: if a glob edit
//      excludes real components, the sampled paths lose the rule and this half fails too.
//
// Run by `pnpm lint`. If it fails: a FIRE line that went silent is lost coverage — do not "fix" it
// by editing the marker. A SILENT line that fired is a false positive, which is how a fence earns
// itself deleted by the next person; narrow the rule, don't delete the case.

import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_SRC = "apps/web/src";

// Every real source file the fence is supposed to govern, read off disk. Test files are exempt by
// the config's own `ignores` (a test is an oracle that legitimately computes expected values), so
// they are excluded here for the same reason.
const webSourceFiles = (() => {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(rel);
    }
  };
  walk(WEB_SRC);
  return found.sort();
})();

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

// ---------------------------------------------------------------------------------------------
// HALF ONE — is the rule switched ON for every file it is supposed to govern?
// ---------------------------------------------------------------------------------------------
// Asked of the config directly, per real file, so no glob edit can leave a file uncovered while
// this check stays green. `calculateConfigForFile` answers exactly the question that matters:
// "if ESLint linted THIS path, would the re-derivation rule be in effect?"
const uncovered = [];
for (const file of webSourceFiles) {
  const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, file));
  const entry = config.rules?.["no-restricted-syntax"];
  const severity = Array.isArray(entry) ? entry[0] : entry;
  const selectorCount = Array.isArray(entry) ? entry.length - 1 : 0;
  if (severity !== "error" && severity !== 2) uncovered.push(`${file} — rule not in effect`);
  else if (selectorCount === 0) uncovered.push(`${file} — rule present but has no selectors`);
}

if (webSourceFiles.length < 40) {
  console.error(
    `golf-arithmetic fence: only found ${webSourceFiles.length} source files under ${WEB_SRC}.` +
      " The tree walk is broken, so the coverage half proved nothing.",
  );
  process.exit(1);
}

if (uncovered.length > 0) {
  console.error(
    `golf-arithmetic fence: ${uncovered.length} of ${webSourceFiles.length} files under ${WEB_SRC}` +
      " are NOT covered by the re-derivation rule. Check the config block's `files`/`ignores`" +
      " globs — a narrowed glob turns the fence off silently and `eslint .` stays green.\n" +
      uncovered.map((u) => `  ${u}`).join("\n"),
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// HALF TWO — does it catch the right things, at real paths?
// ---------------------------------------------------------------------------------------------
// The fixture text is linted AT REAL FILE PATHS (lintText never reads the file, so nothing is
// touched). The sample is drawn from the enumeration above rather than hand-listed: one file per
// (top-level directory × extension), which covers a newly added directory by construction. The
// three paths the round-5 review named as minimums — a nested PascalCase component, a nested
// camelCase module, and a top-level component — all fall out of that rule automatically.
const SAMPLE_PATHS = (() => {
  const bySlot = new Map();
  for (const file of webSourceFiles) {
    const rel = file.slice(WEB_SRC.length + 1);
    const dir = rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : "(root)";
    const slot = `${dir}:${path.extname(file)}`;
    // Prefer a PascalCase name where a directory has one — components are what the glob edits
    // that motivated this half actually excluded.
    const current = bySlot.get(slot);
    const isPascal = /\/[A-Z]/.test(`/${path.basename(file)}`);
    if (!current || (isPascal && !/\/[A-Z]/.test(`/${path.basename(current)}`))) bySlot.set(slot, file);
  }
  return [...bySlot.values()].sort();
})();

const fired = new Map();
for (const p of SAMPLE_PATHS) fired.set(p, await firedLinesAt(p));

const failures = [];
let expectedFire = 0;
let expectedSilent = 0;
const markedCases = [];
FIXTURE.split("\n").forEach((text, i) => {
  const marker = /\/\/ (FIRE|SILENT) (.*)$/.exec(text);
  if (!marker) return;
  const [, expected, why] = marker;
  if (expected === "FIRE") expectedFire += 1;
  else expectedSilent += 1;
  markedCases.push(`${expected}|${text.trim()}`);
  for (const p of SAMPLE_PATHS) {
    const didFire = fired.get(p).has(i + 1);
    if (didFire === (expected === "FIRE")) continue;
    failures.push(
      `  ${expected === "FIRE" ? "LOST COVERAGE" : "FALSE POSITIVE"} (at ${p}): ` +
        `${text.trim().split("//")[0].trim()}` +
        `\n      expected ${expected}, got ${didFire ? "FIRE" : "SILENT"} — ${why}`,
    );
  }
});

// The fixture's CONTENT is pinned, not merely its size. A floor ("at least N cases") is defeated
// by the cheapest possible cheat: flip an inconvenient FIRE marker to SILENT and add a filler FIRE
// line to keep the total. Hashing every marked case makes any edit — a flipped marker, a deleted
// case, a quietly reworded one — fail until someone updates this constant, which is a diff a
// reviewer sees and has to agree with. Cases here are add-only; if you are changing one, that is
// the thing to argue for in the commit message.
const FIXTURE_DIGEST = "87db6aa66f8ddbffc6edcff646fa3cda7be0881ec1347e8038a06cf21a981d57";
const digest = createHash("sha256").update(markedCases.join("\n")).digest("hex");
if (digest !== FIXTURE_DIGEST) {
  console.error(
    "golf-arithmetic fence: the fixture's cases changed.\n" +
      `  expected digest ${FIXTURE_DIGEST}\n` +
      `  actual digest   ${digest}   (${expectedFire} FIRE / ${expectedSilent} SILENT)\n` +
      "  If you deliberately added a case, update FIXTURE_DIGEST and say why in the commit." +
      " If you did not, something edited the evidence — check what.",
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
  `golf-arithmetic fence: ${expectedFire} re-derivation spellings caught, ${expectedSilent} legitimate` +
    ` shapes left alone, at ${SAMPLE_PATHS.length} real paths; rule in effect on all` +
    ` ${webSourceFiles.length} files under ${WEB_SRC}.`,
);
