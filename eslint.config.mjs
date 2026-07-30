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
      // The RE-DERIVATION fence (task-5 fix round, spec 2026-07-30 §10 review I1): the
      // no-restricted-imports rule above only catches IMPORTING a banned compute name — it never
      // noticed a rule being RETYPED inline instead, which is how two real leaks shipped (the
      // crew board's `a.average - b.average`, deleted task 4; RecordSections.tsx's
      // `(score - par) * 2`, moved into nineHoleContribution above, task 5). A regex-based test
      // file was tried first and the review planted five re-derivations that all passed it clean
      // — reversed operands (`2 * (a - b)`), a local variable (`const raw = a - b; raw * 2`), and
      // the two idioms TypeScript itself pushes a developer toward for an `optional` served field
      // (`a.average ?? 0`, `a.average!`) all defeat a regex, but not an AST: a BinaryExpression
      // touching a `.average`/`.strokes`/`.par` property is the same NODE shape regardless of
      // operand order, whitespace, or the `!`/`??` wrapped around the property read. This selector
      // subsumed the regex file entirely (deleted, apps/web/test/noGolfArithmetic.test.ts) — one
      // mechanism, not two with different coverage.
      //
      // `par` in the property list also flags RecordSections.tsx's own two legitimate
      // `line.score - line.par` reads (feeding `formatOverPar` for on-screen display — the
      // subtraction itself is not a rule, only the DOUBLING is, and that's `nineHoleContribution`'s
      // job now) — the ONLY two sites in the tree this fires on that are correct as written; both
      // carry a narrowly-scoped `eslint-disable-next-line` with this same reasoning inline, so
      // nothing else may quietly claim the same exemption.
      //
      // Known, accepted residual (stated here, not solved): a re-derivation fully hidden behind an
      // opaque local — `const { score, par } = line; const raw = score - par; raw * 2;`, where
      // NEITHER the property read nor the multiplication shares a single expression — defeats this
      // selector exactly as it would defeat any text- or AST-based fence with no dataflow
      // analysis. If this rule ever fails to catch a real leak of that shape, that is why; add
      // dataflow tooling or catch it in review, don't just widen this pattern by guesswork.
      "no-restricted-syntax": [
        "error",
        {
          selector: "BinaryExpression[operator=/^[-+*]$/] MemberExpression[property.name=/^(average|strokes|par)$/]",
          message:
            "This re-derives a golf rule inline over a served average/strokes/par field (however it's spelled — reversed operands, `!`, `?? 0` all match). Move the rule into @swng/domain and call it through @swng/client. If this is genuinely just display arithmetic over an already-served number (not a rule), it needs an eslint-disable-next-line with a comment stating why — see RecordSections.tsx's two exemptions for the pattern. Never delete or widen this rule just to go green.",
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
