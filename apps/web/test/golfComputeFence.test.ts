// Two pins on the golf re-derivation fence that the fence itself cannot hold.
//
// The fence is an ESLint rule in eslint.config.mjs plus scripts/checkGolfArithmeticFence.mjs,
// which proves the rule's coverage by mutation and is run by `pnpm lint`. Both gaps closed here
// are things that check structurally cannot see:
//
//   1. Its own invocation. Deleting ` && node scripts/checkGolfArithmeticFence.mjs` from the root
//      `lint` script removes the entire coverage pin, and the check cannot object because it no
//      longer runs. This test RUNS the check rather than grepping for its name in the script: an
//      earlier version asserted the substring, which a reviewer defeated with a one-character
//      edit (`&&` → `||`, or a trailing `|| true`, or commenting the tail) that left the pinned
//      string in place while the check never ran and `pnpm lint` went green over a broken fence.
//      Running it is the only assertion that cannot be satisfied by a script that merely mentions
//      it. Doing so from `pnpm test` — a different leg of `pnpm validate` — also means removing
//      the pin takes two edits in two files instead of one deletion.
//   2. Whether the fence's property list is still complete. The list is hand-maintained on
//      purpose: deriving it mechanically from "every numeric field" would sweep in timestamps,
//      sequence numbers, hole identifiers and card metadata, each of which was excluded BECAUSE
//      including it makes the rule fire on legitimate code — that trades a quiet miss for a false
//      positive, which is the failure mode that actually gets a fence deleted. So the list stays a
//      judgment call, and this test only makes the judgment MANDATORY: every numeric field on the
//      wire must be either fenced or explicitly excluded here, by name, with a reason. A new
//      served field fails the build until someone classifies it — on the WIRE. Roughly a third of
//      the axis names are domain shapes the web renders through @swng/client (GameState lines and
//      the like) rather than `z.number` wire fields, and a new numeric field on one of those is
//      NOT caught here. Removing any axis name IS caught, by the fence check's own fixture, so
//      the unpinned direction is additions only. Worth knowing, because both historical GamePanel
//      ranking leaks lived on exactly those domain shapes.
//
// Lives outside src (the brandTokens.test.ts precedent) because it reads repo files with node:fs,
// which apps/web/src bans.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// cwd is the package root under both `pnpm -F @swng/web test` and `pnpm -r test`.
const REPO_ROOT = resolve(process.cwd(), "../..");
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const eslintConfig = read("eslint.config.mjs");

/** The fence's property axis, read out of the real config rather than restated here. */
const fencedProps = (): string[] => {
  const block = /const GOLF_ARITHMETIC_PROPS = \[([\s\S]*?)\]\.join/.exec(eslintConfig);
  if (!block) throw new Error("GOLF_ARITHMETIC_PROPS not found in eslint.config.mjs");
  return [...block[1]!.matchAll(/"([A-Za-z0-9]+)"/g)].map((m) => m[1]!);
};

/**
 * Every field declared `z.number(...)` anywhere in the wire schemas. Matches the INLINE
 * declaration only — a field declared through a named alias (`strokes: strokesInputSchema`) is
 * invisible here. That style exists in commands.ts, so this is a real limit rather than a
 * theoretical one; it is left as a limit because chasing aliases means resolving identifiers
 * across files, and the classification this test forces is a judgment call a person makes at
 * review time, not a completeness proof.
 */
const wireNumericFields = (): string[] => {
  const dir = "packages/contracts/src";
  const names = new Set<string>();
  for (const file of readdirSync(resolve(REPO_ROOT, dir))) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    for (const m of read(`${dir}/${file}`).matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*z\.number/g)) {
      names.add(m[1]!);
    }
  }
  return [...names].sort();
};

// Numeric wire fields that are deliberately NOT golf numbers. Each is here because putting it on
// the fence's property axis would make the rule fire on ordinary, correct code.
const NOT_GOLF_NUMBERS: Record<string, string> = {
  // Identifiers that happen to be numbers. `hole.number - 1` is an array index.
  hole: "a hole's identity, not a score",
  number: "a hole's identity, not a score",
  // Card metadata: printed because it is on the paper scorecard, computed from nowhere since the
  // WHS pipeline was deleted. There is no domain rule over these to move arithmetic into.
  rating: "course card metadata, feeds no calculation",
  slope: "course card metadata, feeds no calculation",
  yardage: "course card metadata, feeds no calculation",
  // Wall-clock and ordering plumbing.
  createdAt: "timestamp",
  createdAtMs: "timestamp",
  updatedAtMs: "timestamp",
  finalizedAt: "timestamp",
  joinedAt: "timestamp",
  expiresAtMs: "timestamp",
  wallMs: "timestamp",
  seq: "event-log sequence number",
  nextSeq: "event-log sequence number",
  counter: "HLC counter",
  // A crew's size is a roster fact, not a golf result.
  memberCount: "roster size",
};

describe("the golf re-derivation fence is wired into the gate", () => {
  // RUN it, don't grep for it. A script that mentions the check and never runs it (`||` instead
  // of `&&`, a trailing `|| true`, a `#` before the tail) satisfies any substring assertion while
  // the fence is provably off. Executing it is the assertion that cannot be faked — and it fails
  // for either reason that matters: the check gone, or the check failing.
  it("the fence coverage check passes when run", () => {
    expect(() =>
      execFileSync("node", ["scripts/checkGolfArithmeticFence.mjs"], { cwd: REPO_ROOT, stdio: "pipe" }),
    ).not.toThrow();
  });

  it("`pnpm lint` runs the fence coverage check", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.lint).toContain("node scripts/checkGolfArithmeticFence.mjs");
  });

  it("`pnpm validate` runs lint", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.validate).toContain("pnpm lint");
  });
});

describe("every numeric field on the wire is classified", () => {
  // The point of this test: it fails when a NEW served number appears, forcing whoever added it to
  // decide whether the web may do arithmetic on it. It does not decide for them.
  it("is either fenced or explicitly excluded, by name", () => {
    const fenced = new Set(fencedProps());
    const unclassified = wireNumericFields().filter(
      (name) => !fenced.has(name) && !(name in NOT_GOLF_NUMBERS),
    );
    expect(
      unclassified,
      `New numeric field(s) on the wire: ${unclassified.join(", ")}.\n` +
        "If the web doing arithmetic on one would be a golf rule leaking out of @swng/domain, add\n" +
        "it to GOLF_ARITHMETIC_PROPS in eslint.config.mjs. If it is a timestamp, an identifier, a\n" +
        "count of non-golf things, or metadata nothing computes from, add it to NOT_GOLF_NUMBERS\n" +
        "here with the reason. Do not skip this by deleting the field from either list.",
    ).toEqual([]);
  });

  it("has no stale exclusions", () => {
    // An exclusion for a field that no longer exists is dead weight that makes the list look more
    // considered than it is.
    const onWire = new Set(wireNumericFields());
    const stale = Object.keys(NOT_GOLF_NUMBERS).filter((name) => !onWire.has(name));
    expect(stale, `NOT_GOLF_NUMBERS names fields no longer on the wire: ${stale.join(", ")}`).toEqual(
      [],
    );
  });

  it("never excludes a field the fence also claims", () => {
    // The two lists must be disjoint, or the exclusion list is quietly lying about what is fenced.
    const fenced = new Set(fencedProps());
    const both = Object.keys(NOT_GOLF_NUMBERS).filter((name) => fenced.has(name));
    expect(both, `classified as both fenced and not-golf: ${both.join(", ")}`).toEqual([]);
  });
});
