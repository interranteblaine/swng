import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// The layer direction (domain → application → adapters → entry points) is enforced here as
// allow-lists: each layer block bans every import that would point the dependency arrow
// outward. Naming rules are NOT lint-enforced — whether a name tells the truth is a review
// judgment, not a string property. `pathGlob` is the package's full path from the repo root
// (e.g. "packages/domain", "apps/web") so this one helper covers both packages/* and apps/*;
// `extensions` defaults to source-only ".ts" and widens to include ".tsx" for the one
// consumer (apps/web) that has React components.
const layer = (pathGlob, patterns, extensions = ["ts"]) => ({
  files: [`${pathGlob}/src/**/*.${extensions.length === 1 ? extensions[0] : `{${extensions.join(",")}}`}`],
  rules: {
    "no-restricted-imports": ["error", { patterns }],
  },
});

const AWS = {
  group: ["@aws-sdk/*", "aws-sdk"],
  message: "AWS SDKs are importable only inside adapters.",
};

const NODE = {
  group: ["node:*"],
  message: "This package also runs in the browser — no Node built-ins.",
};

// The re-derivation fence's own property list (task-5 fix round, spec 2026-07-30 §10 review) — ONE
// place, interpolated into every selector branch below so the four can't drift apart. `average`/
// `strokes`/`par` are the golfer-record fields task 5 named; `points`/`relativeToPar`/`skins` are
// the GameState line fields I2's fix round added (GamePanel.tsx's stroke-play/stableford/skins
// ranking, moved to @swng/domain) — added here so a re-derivation of THAT move is caught too; I1's
// fence didn't cover I2's own move until this fix round.
const GOLF_ARITHMETIC_PROPS = "average|strokes|par|points|relativeToPar|skins";

// Shared message for every branch of the re-derivation fence below — one copy, not four drifting
// copies naming slightly different things.
const NO_GOLF_ARITHMETIC_MESSAGE =
  "This re-derives a golf rule inline over a served average/strokes/par/points/relativeToPar/skins field (however it's spelled — reversed operands, `!`, `?? 0`, or a `+=`/`-=` accumulator all match). Move the rule into @swng/domain and call it through @swng/client. If this is genuinely just display arithmetic over an already-served number (not a rule), it needs an eslint-disable-next-line with a comment stating why — there are currently ZERO such exemptions anywhere in apps/web/src (RecordSections.tsx's own two were closed by routing through scoring/present.ts's formatScoreVsPar), so a new one should be rare and heavily justified. Never delete or widen this rule just to go green.";

export default [
  { ignores: ["**/dist", "**/node_modules", "**/cdk.out"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  layer("packages/domain", [
    { group: ["@swng/*"], message: "domain imports nothing." },
    NODE,
    AWS,
  ]),
  layer("packages/contracts", [
    { group: ["@swng/*", "!@swng/domain"], message: "contracts may import only @swng/domain." },
    NODE,
    AWS,
  ]),
  layer("packages/application", [
    {
      group: ["@swng/adapters-*", "@swng/lambda", "@swng/client"],
      message: "application depends on the ports it defines, never on adapters, entries, or the client.",
    },
    AWS,
  ]),
  layer("packages/client", [
    {
      group: ["@swng/*", "!@swng/domain", "!@swng/contracts"],
      message: "client depends on domain + contracts only.",
    },
    NODE,
    AWS,
  ]),
  layer("packages/adapters-*", [
    {
      group: ["@swng/*", "!@swng/domain", "!@swng/contracts", "!@swng/application"],
      message: "adapters implement application's ports; they import only domain, contracts, and application.",
    },
  ]),
  layer("packages/lambda", [
    { group: ["@swng/client"], message: "server entries never import the client SDK." },
    AWS,
  ]),
  layer(
    "apps/web",
    [
      {
        group: ["@swng/*", "!@swng/domain", "!@swng/contracts", "!@swng/client", "!@swng/brand"],
        message: "the web app depends on domain, contracts, the client SDK, and the brand tokens only — never application, adapters, or lambda directly.",
      },
      NODE,
      AWS,
    ],
    ["ts", "tsx"],
  ),
  {
    // The golf-compute fence (the "one on-device seam" arc): golf logic is one tested copy in
    // @swng/domain, and the web runs it on-device ONLY through @swng/client (foldAndScore + the
    // compute re-exports). This BANS the web importing those compute VALUES straight from
    // @swng/domain — a future hand-rolled golf computation in the web then fails `pnpm lint`. It
    // uses @typescript-eslint's own no-restricted-imports (not the base rule the layer() above
    // uses) purely for `allowTypeImports`: `import type { ... } from "@swng/domain"` stays legal
    // (types carry no logic), and so do the presentation formatters / id constructors / pure
    // structural accessors (cellKey/findTeeSet/gameMembers) / DomainError — none compute a golf
    // RESULT. This is a SEPARATE rule name from the layer() block's base `no-restricted-imports`,
    // so the two coexist without overriding each other: the base rule keeps enforcing package
    // LAYERING (patterns), this one enforces the domain-compute banlist (paths/importNames), and
    // they ban disjoint things so nothing double-reports. Test files are exempt (see `ignores`) —
    // a test is an oracle that legitimately computes expected values straight from @swng/domain
    // (scoreGame/settleRound/reduceRound/the golden decks), which @swng/client does not re-export;
    // the boundary being sealed is the PRODUCT on-device compute path, matching the
    // domain-boundary-restore arc's own Task 5 grep (2026-07-18, commit 0798828), which excludes
    // `.test.` — NOT the "strokes are typed" arc's task 5 (2026-07-30), a different task of the
    // same ordinal number that landed the `no-restricted-syntax` re-derivation rule below.
    files: ["apps/web/src/**/*.{ts,tsx}"],
    ignores: ["apps/web/src/**/*.test.ts", "apps/web/src/**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@swng/domain",
              allowTypeImports: true,
              importNames: [
                // the fold + the five scoring engines + settlement/result readers
                "scoreGame",
                "reduceRound",
                "settleRound",
                "resultOf",
                "unresolvedGames",
                "scoreStrokePlay",
                "scoreStableford",
                "scoreSkins",
                "scoreSinglesMatch",
                "scoreFourballMatch",
                "matchLadder",
                // stroke allocation + net arithmetic
                "gameStrokeAllocation",
                "roundStrokeAllocation",
                "totalDots",
                "dotsForHoles",
                "grossForHoles",
                "parForHoles",
                "allocateStrokes",
                "dotsByHole",
                "strokesReceivedOnHole",
                "netDoubleBogey",
                "netStrokes",
                "roundHalfUp",
                // leaderboard ORDER (task-5 fix round, spec 2026-07-30 §10 review I2): a ranking
                // rule is golf logic — GamePanel.tsx's three inline `.sort()` calls moved here, the
                // same class `aggregateSeason` already moved server-side for crew standings ("the
                // web never re-ranks"). sortedStrokePlayLines carries the owner ruling (spec
                // 2026-07-19 §2b, vs-par ascending then thru descending) — see its own comment.
                "sortedStrokePlayLines",
                "sortedStablefordLines",
                "sortedSkinsLines",
                // resolveStrokes/anchorOf are gone from this list with scoring/strokeBasis.ts
                // itself (spec 2026-07-30 §9): strokes are asserted on the roster now, so there is
                // no resolution rule left for the web to re-derive. The allowance table
                // (defaultAllowance/playingHandicap) that stood here before them is equally gone.
                // what you shoot relative to par (spec 2026-07-29 §2c/§5) — the whole WHS
                // banlist block that stood here (adjustedGrossScore, scoreDifferential,
                // computeIndex(Detail), swngIndex, courseHandicapFor(RatingSlopePar),
                // unratedCourseHandicap, combineNineHoleDifferentials) is gone with handicap/whs.ts
                // itself. The six names below (through `overPar`) are DELIBERATELY not re-exported
                // through @swng/client: the average is server-computed and served, so an on-device
                // copy would be fence-legal and boundary-wrong. formatOverPar is absent on purpose
                // — a presentation formatter, like underPar (the handicap/present.ts precedent).
                // (`nineHoleContribution`, immediately below these six, is the ONE exception in
                // this whole file — it IS re-exported; see its own comment, not this one.)
                "averageOf",
                "averageOfValues",
                "spreadOfValues",
                "averageHistory",
                "scoredOverPar",
                "overPar",
                // nineHoleContribution (task 5 — RecordSections.tsx's history row re-derived `* 2`
                // inline for a nine's "counts +32" line) IS re-exported through @swng/client,
                // unlike its neighbors above: it's a small pure fact (a nine counts doubled), not
                // the average fold itself, and the web still needs it to render over already-served
                // score/par fields. Still banned straight from @swng/domain — the client re-export
                // is the one sanctioned path. (Two more leaks of the SAME class — GamePanel.tsx's
                // ranking sorts — surfaced in task 5's own fix round; see sortedStrokePlayLines et
                // al. above and parForHoles/dotsForHoles near totalDots.)
                "nineHoleContribution",
                // golfer metrics + per-round archive line
                "golferMetrics",
                "archiveGolferLine",
                // analytics read folds — bests/milestones
                "bestsOf",
                "milestonesOf",
                // course record — the per-course fold (its present.ts phrase formatters are
                // fence-ALLOWED, the handicap/present.ts precedent, so they're deliberately absent here)
                "courseRecord",
                // crew season aggregation
                "crewContribution",
                "aggregateSeason",
                // crew analytics — partner records / season titles
                "partnerRecords",
                "stablefordTitle",
                // crew scoreboard (crew-scoreboard spec §3a/§3b) — the per-member window fold +
                // the shared-rounds derivation; the web renders SERVED scoreboard rows only
                "crewScoreboard",
                "sharedRoundIds",
                "seasonWindowOf",
                "playedAtMs",
                "inWindow",
                // golden-deck runners (barrel-exported, run domain compute — nonsensical in
                // product, but fenced so the ban covers EVERY barrel-exported golf computation)
                "playGoldenRound",
                "playGoldenRoundLog",
              ],
              message:
                "Golf compute runs on-device via @swng/client (the one sanctioned client-side path) — import it from @swng/client, not @swng/domain. See docs/architecture.md 'Where golf logic lives'.",
            },
          ],
        },
      ],
      // The RE-DERIVATION fence (task-5 fix round 1, spec 2026-07-30 §10 review I1; NARROWED in
      // fix round 2, review I1-again/I2): the no-restricted-imports rule above only catches
      // IMPORTING a banned compute name — it never noticed a rule being RETYPED inline instead,
      // which is how two real leaks shipped (the crew board's `a.average - b.average`, deleted
      // task 4; RecordSections.tsx's `(score - par) * 2`, moved into nineHoleContribution, task
      // 5). A regex-based test file was tried first and fix round 1's review planted five
      // re-derivations that all passed it clean — reversed operands (`2 * (a - b)`), a local
      // variable (`const raw = a - b; raw * 2`), and the two idioms TypeScript itself pushes a
      // developer toward for an `optional` served field (`a.average ?? 0`, `a.average!`) all
      // defeat a regex. That regex file is deleted (apps/web/test/noGolfArithmetic.test.ts) — one
      // mechanism, not two with different coverage.
      //
      // Fix round 2 NARROWED the single broad "any descendant" selector fix round 1 shipped, after
      // the review proved it also fires on three plausible pieces of LEGITIMATE code: string
      // concatenation for display (`"Par " + h.par`), a UI stepper (`p.strokes + 1`), and a golf
      // property read nested inside a ternary's TEST rather than an operand of the arithmetic at
      // all (`c + (p.strokes > 0 ? 1 : 0)`). Four selector branches below replace it, each
      // EMPIRICALLY verified (a scratch fixture carrying all five mutations + all three false
      // positives + the `+=` case, run through `pnpm exec eslint`, before this design was kept):
      //
      // (A) direct-operand arithmetic, EXCLUDING a Literal on either side — `x.par - y`/`y - x.par`
      //     etc. The Literal exclusion is what kills the string-concat and stepper false positives
      //     (`"Par " + h.par` has a string Literal operand; `p.strokes + 1` has a numeric Literal
      //     operand) WITHOUT losing any planted mutation — none of the five has a Literal as a
      //     direct operand of its matched BinaryExpression.
      // (B) one level of `?? <anything>` unwrapping — catches `(a.average ?? 0) - (b.average ?? 0)`,
      //     which (A) alone cannot: neither top-level operand of that subtraction is ITSELF a
      //     MemberExpression, both are LogicalExpressions, so a naive "direct operand only"
      //     narrowing would have silently dropped this exact planted mutation (confirmed by
      //     execution, not assumed).
      // (C) one level of `!` (TSNonNullExpression) unwrapping — the same reasoning for
      //     `a.average! - b.average!`.
      // (D) `+=`/`-=`/`*=` accumulators, direct-operand + Literal-excluded like (A) — an
      //     AssignmentExpression is a DIFFERENT node type from BinaryExpression, so
      //     `let t = 0; for (...) t += h.par;` (the exact hand-rolled-sum shape M5 folded into
      //     `parForHoles`/`dotsForHoles`) was previously INVISIBLE to this fence no matter how (A)
      //     was written; this is new coverage, not a narrowing of existing coverage.
      //
      // `GOLF_ARITHMETIC_PROPS` above adds `points`/`relativeToPar`/`skins` (I2's GameState fields)
      // to the original `average`/`strokes`/`par` — otherwise `[...lines].sort((a,b) =>
      // b.points - a.points)` could be retyped straight back into GamePanel.tsx tomorrow with this
      // whole fence green, since I1's selector never covered I2's own move.
      //
      // Known, accepted residuals (stated here, not solved — narrower branches trade some
      // theoretical reach for killing real false positives, and this is the honest boundary of
      // what static, non-dataflow AST matching can do):
      // - A fully destructured local — `const { score, par } = line; const raw = score - par; raw
      //   * 2;` — where NEITHER the property read nor the multiplication shares one expression
      //   with the other. Unchanged from fix round 1: no branch below, or any AST selector without
      //   dataflow analysis, can see through an intermediate variable.
      // - A ternary/conditional VALUE (not test) that itself is a direct operand of the arithmetic
      //   — e.g. `total + (useNet ? a.average! : 0)` — is invisible to (A)/(B)/(C) the same way
      //   `+=` was to fix round 1: a `ConditionalExpression` isn't unwrapped by any branch here,
      //   only `??` and `!`. Add a branch if this shape is ever the real leak; don't widen (A)
      //   back to "any descendant" to pre-empt it, since that is exactly what reintroduces the
      //   string-concat/stepper false positives this narrowing exists to kill.
      // - Double-wrapped forms (`(a.average ?? 0)!`, `a.average ?? b.average ?? 0`, etc.) are not
      //   tested and may not match; the two named idioms (single `??`, single `!`) are what the
      //   review actually observed TypeScript push developers toward for one optional field.
      "no-restricted-syntax": [
        "error",
        {
          selector: `BinaryExpression[operator=/^[-+*]$/]:not([left.type="Literal"]):not([right.type="Literal"]) > MemberExpression[property.name=/^(${GOLF_ARITHMETIC_PROPS})$/]`,
          message: NO_GOLF_ARITHMETIC_MESSAGE,
        },
        {
          selector: `BinaryExpression[operator=/^[-+*]$/] > LogicalExpression[operator="??"] > MemberExpression[property.name=/^(${GOLF_ARITHMETIC_PROPS})$/]`,
          message: NO_GOLF_ARITHMETIC_MESSAGE,
        },
        // Self-caught during verification, not in the review: `rows[0]?.average ?? 0` (optional
        // chaining, arguably MORE idiomatic TypeScript than the plain `.average` form the review's
        // own mutation 4 used) wraps the MemberExpression in a ChainExpression node, which sits
        // BETWEEN the LogicalExpression and the MemberExpression — so the branch immediately above
        // (a direct `>` child) does not reach it. Proven by a scratch probe
        // (`(rows[0]?.average ?? 0) - (rows[1]?.average ?? 0)` passed clean before this branch
        // existed); this branch drills through the extra ChainExpression wrapper.
        {
          selector: `BinaryExpression[operator=/^[-+*]$/] > LogicalExpression[operator="??"] > ChainExpression > MemberExpression[property.name=/^(${GOLF_ARITHMETIC_PROPS})$/]`,
          message: NO_GOLF_ARITHMETIC_MESSAGE,
        },
        {
          selector: `BinaryExpression[operator=/^[-+*]$/] > TSNonNullExpression > MemberExpression[property.name=/^(${GOLF_ARITHMETIC_PROPS})$/]`,
          message: NO_GOLF_ARITHMETIC_MESSAGE,
        },
        {
          selector: `AssignmentExpression[operator=/^(\\+=|-=|\\*=)$/]:not([left.type="Literal"]):not([right.type="Literal"]) > MemberExpression[property.name=/^(${GOLF_ARITHMETIC_PROPS})$/]`,
          message: NO_GOLF_ARITHMETIC_MESSAGE,
        },
      ],
    },
  },
  {
    // eslint-plugin-react-hooks@7's own `configs.recommended-latest`/`configs.recommended`
    // ship a legacy `plugins: ["react-hooks"]` array — flat config rejects that outright
    // (ESLint: "plugins" must be an object) — so it can't be spread in directly. Wiring the
    // plugin object plus just the two classic "essentials" rules (not the newer, stricter
    // React Compiler rule bundle v7 also ships, e.g. purity/immutability/gating — untried
    // against this codebase and not what "essentials" means here) is what actually drops in
    // trivially.
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // "error", not "warn": root lint has no --max-warnings, so a "warn" here can never fail
      // CI — a missing/stale dependency would lint clean forever. Zero warnings exist today
      // (verified before promoting), so this is a no-op for the current tree.
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    // Plain Node scripts (run via `node <path>`, never bundled) — the only places in the repo
    // that are plain JS instead of TS, so they need the Node globals TS's own lib/types supply
    // implicitly elsewhere: apps/web/scripts/webEnv.mjs + root scripts/*.mjs (M9 Task 6), and
    // the .claude/skills/**/*.mjs tooling scripts (e.g. seeding-courses/seed-course.mjs), which
    // `eslint .` also traverses. `fetch` is a Node 20+ global the skill scripts use.
    files: ["apps/web/scripts/**/*.mjs", "scripts/**/*.mjs", ".claude/skills/**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly", fetch: "readonly" },
    },
  },
];
