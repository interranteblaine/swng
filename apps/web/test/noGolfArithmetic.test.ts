// The compute-import fence in eslint.config.mjs bans IMPORTING golf-compute names from
// @swng/domain into apps/web/src — but it only ever checked imports. It never noticed a rule being
// RE-DERIVED inline instead of imported, which is exactly how two real leaks shipped: the crew
// board's stroke-difference line (`a.average - b.average`, deleted in this arc's task 4) and
// RecordSections.tsx's nine-hole doubling (`(score - par) * 2`, moved into
// `@swng/domain/golfer/average.ts`'s `nineHoleContribution` in task 5). Neither leak ever imported
// a banned name — the arithmetic was just typed by hand — so an import-only fence is structurally
// blind to this defect class. This test reads the web's own source TEXT and fails on the literal
// shapes those two leaks actually took.
//
// It lives OUTSIDE apps/web/src (unlike every other web test) because it reads files with
// node:fs, which apps/web/src bans (browser code, no Node built-ins) — the brandTokens.test.ts
// precedent. A whole-tree walk (not fixed `?raw` imports, scoringSurface.structural.test.ts's
// approach) is required here because the point is to catch a violation ANYWHERE in the tree,
// including files that don't exist yet.
//
// Test files (`*.test.ts(x)`) are excluded, mirroring the compute-import fence's own `ignores` and
// its stated reason: a test legitimately computes its own expected values from scratch as an
// oracle (see e.g. average.test.ts's hand-computed fixtures) — the boundary this test seals is the
// PRODUCT on-device compute path, not test-side arithmetic.
//
// If this test ever fails: either a golf rule got re-derived in a component — move it into
// @swng/domain and call it through @swng/client (this task's own fix is the template) — or a
// pattern below is now false-positiving on legitimate non-golf code, in which case narrow the
// regex and say why in a comment. Never delete a pattern just to go green.
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if ([".ts", ".tsx"].includes(extname(entry.name)) && !entry.name.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

// Each pattern names a shape a real leak took, not a broad ban on the words "average" or
// "strokes" themselves — requiring the property-access dot means `strokesLabel(p.strokes)`
// (ResultsView.tsx, a phrase formatter called ON an already-served number) and
// `row.average !== undefined` (SeasonPanel.tsx, a presence check before rendering) don't match;
// only arithmetic performed ON the property does.
//
// Two patterns cover the nine-hole doubling on purpose, not one: the task-5 brief's own
// `overPar\s*\*\s*2` catches a re-derivation that names its local value `overPar` (matching
// `nineHoleContribution`'s own parameter name) — but the doubling that ACTUALLY shipped in
// RecordSections.tsx before this task was `(line.score - line.par) * 2`, which that pattern does
// NOT match (nothing there is spelled "overPar"). A fence that only catches a re-derivation if it
// happens to reuse the domain's own parameter name protects against a strawman, not the real
// defect class — so `\.par\)\s*\*\s*2` is added to catch the shape that actually shipped: a
// `.par`-subtraction immediately doubled, regardless of what the enclosing variable is called.
const BANNED: readonly RegExp[] = [
  /\.average\s*[-+]\s*/, // the deleted crew board stroke-difference line
  /\.strokes\s*[-+]\s*/, // the same shape over a roster's asserted strokes field
  /overPar\s*\*\s*2/, // a local named overPar, doubled inline
  /\.par\)\s*\*\s*2/, // the shape that actually shipped: (x - y.par) * 2
];

describe("the web computes no golf result by hand (structural)", () => {
  const files = walk(SRC);

  // A walk that silently returns few/no files would make every check below vacuously pass —
  // this pins that the walk is actually finding the tree (60 non-test files at the time this
  // test was written; floored well below that so the test doesn't chase file-count churn).
  it("the walk finds the web source tree (not vacuous)", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it.each(files.map((file) => [file.slice(SRC.length + 1), file] as const))("%s has no banned golf arithmetic", (_rel, file) => {
    const text = readFileSync(file, "utf8");
    for (const pattern of BANNED) {
      expect(text, `${file} matched banned pattern ${pattern}`).not.toMatch(pattern);
    }
  });
});
