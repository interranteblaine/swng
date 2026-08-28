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

// The domain-compute banlist. Compute is banned; the PRESENTATION vocabulary in
// scoring/present.ts is deliberately NOT on this list — a consumer that may not say a golf fact
// in words is a consumer that will write its own second wording of it (spec §1.1). Shared by
// every non-domain consumer so a new one inherits the rule instead of inventing a weaker or a
// blanket-stricter one.
const DOMAIN_COMPUTE_BANLIST = {
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
    // which holes a round set out to play (spec 2026-08-02 §3c) — the grid, the
    // results headline, and dots.ts's per-game allocation all resolve the round's
    // OWN hole list through this, never their own front/back slicing.
    "intendedHoles",
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
    // `playedAtMs` used to sit here and was INERT: @swng/domain exports no such name
    // (it is a FIELD on RoundState/GolferRoundLine, and `import { playedAtMs }` is not
    // a thing anyone can write), so the entry banned nothing and read as protection
    // (fix wave, Minor 2). The live played-date ban is `playedAtMsOf`, in its own
    // `paths` entry above with its own message — that one is verified biting.
    "inWindow",
    // golden-deck runners (barrel-exported, run domain compute — nonsensical in
    // product, but fenced so the ban covers EVERY barrel-exported golf computation)
    "playGoldenRound",
    "playGoldenRoundLog",
    // The fold moves down (MCP arc Phase 1, 2026-08-24): foldAndScore + KNOWN_GAME_KINDS now
    // live in @swng/domain, re-exported through @swng/client exactly as they were before the
    // move — banned here for the same reason every other name on this list is banned.
    "foldAndScore",
    "KNOWN_GAME_KINDS",
  ],
  message:
    "Golf compute runs on-device via @swng/client (the one sanctioned client-side path) — import it from @swng/client, not @swng/domain. See docs/architecture.md 'Where golf logic lives'.",
};

const AWS = {
  group: ["@aws-sdk/*", "aws-sdk"],
  message: "AWS SDKs are importable only inside adapters.",
};

const NODE = {
  group: ["node:*"],
  message: "This package also runs in the browser — no Node built-ins.",
};

// ---------------------------------------------------------------------------------------------
// The re-derivation fence (see the `no-restricted-syntax` rule far below for what it defends and
// why). Its selectors are GENERATED from three independent axes — which properties, which
// operators, which value-transparent wrappers — rather than hand-enumerated, because four
// consecutive attempts at a hand-enumerated branch list each shipped a hole on an axis the author
// wasn't thinking about that round: round 1's regexes missed the `??`/`!` narrowing idioms, round
// 2's Literal exclusion lost `h.par * 2` (the very rule the fence exists to protect), round 3
// restored that but left `/` and `%` out of the operator set entirely — while its own comment
// asserted a complete survey — and every round so far unwrapped `?.` only under `??`. Enumerating
// one axis while holding the others fixed is the defect; the cross product is the fix. Adding a
// property, an operator, or a wrapper below now covers every combination of the other two.
// ---------------------------------------------------------------------------------------------

// AXIS 1 — the served fields a golf rule gets re-derived over. Read off the wire schemas and the
// domain shapes the web actually renders (contracts/{golfers,crews,round,courses}.ts,
// scoring/game.ts, golfer/{record,metrics,analytics,courseRecord}.ts, crew/{scoreboard,ledger,
// analytics}.ts), not from memory. The rule for what belongs: a number that IS a golf result (a
// score, a margin, a tally, an average) or that a scoring/allocation rule reads as input.
//
// Fix round 4 found this axis was the widest hole of the three and the least examined — it had
// never been revisited since the two leaks that motivated the fence. `score` alone made
// `line.score * 2` invisible: that is the nine-hole doubling rule, the ONE rule this whole task
// moved into the domain, spelled over the other operand. `thru` made the stroke-play sort's own
// tiebreak invisible. Both are exactly the class of leak the fence exists for.
//
// DELIBERATELY ABSENT, and why (each is a false-positive risk that would earn the rule a deletion,
// which is worse than the miss):
// - `hole` and `number` (on `Hole`) are IDENTIFIERS that happen to be numbers. `hole.number - 1`
//   as an array index and `entry.hole + 1` for display are ordinary plumbing, not golf.
// - `yardage`, `rating`, `slope` are card metadata: printed because they are on the paper
//   scorecard, computed from nowhere since the WHS pipeline was deleted. There is no rule over
//   them left in the domain, so this rule's own "move it to @swng/domain" advice would be a lie.
// - timestamps (`finalizedAt`, `createdAtMs`, `expiresAtMs`, `wallMs`, …) and sequence numbers
//   (`seq`, `nextSeq`, `counter`) are plumbing; arithmetic over them is not golf.
const GOLF_ARITHMETIC_PROPS = [
  // scores and the numbers derived straight from them
  "score", "par", "strokes", "gross", "net", "total", "toPar", "relativeToPar", "underPar",
  // averages and spreads — scoringAverage split into scoringAverage18/scoringAverage9 the same
  // way best split into best18/best9 below (round-plays-a-nine spec 2026-08-02, Finding 1: a
  // course can now hold both a 9- and an 18-hole round, so its scoring average is two numbers).
  "average", "scoringAverage18", "scoringAverage9", "avgOverPar", "sumOverPar", "spread",
  // per-game results
  "points", "skins", "pot", "carrying", "carriedOut", "up", "thru", "remaining",
  // match/season tallies
  "wins", "losses", "halves", "aWins", "bWins",
  // scoring distribution buckets
  "eagles", "birdies", "pars", "bogeys", "doublePlus", "parOrBetter",
  // bests
  "best18", "best9",
  // allocation input and output
  "strokeIndex", "dots",
  // counts a golf fold gates on (the ≥3-round floors, the 9-vs-18 doubling, partial-total flags).
  // These collide by NAME with arrays of the same word (`tee.holes`, `standings.rounds`) — that
  // costs nothing, because arithmetic over an array reads `.length`, and `length` is not a name
  // on this list.
  "rounds", "holes", "holeCount", "holesDecided", "pickups", "plays", "strokesPlays",
].join("|");

// A READ of one of those fields — dotted (`line.par`) or computed (`line["par"]`). Both spell the
// same access; only the first was covered before fix round 4.
const GOLF_PROP =
  `:matches(MemberExpression[property.name=/^(${GOLF_ARITHMETIC_PROPS})$/],` +
  `MemberExpression[computed=true][property.value=/^(${GOLF_ARITHMETIC_PROPS})$/])`;

// AXIS 2 — arithmetic. All six JS arithmetic operators, in both their binary and compound-assign
// forms. `/` and `%` are not decoration: division is the operator of every averaging rule the
// `average` field exists for (`averageOf`'s mean, `metrics`' per-18 normalisation,
// `courseRecord`'s avgOverPar) and of the nine-hole halving in `resolveStrokes`, and `/` with `%`
// together are literally how `allocateStrokes` spells the base-dots rule
// (`Math.floor(strokes / holes)`, `strokes % holes`). Leaving them out left the fence blind to the
// shape it is most likely to meet. esquery's regex literals cannot contain `/` — even escaped, it
// terminates the literal — so `/` and `/=` are spelled as their own `:matches` arms.
const ARITH_BINARY = `:matches([operator=/^(\\*\\*|[-+*%])$/],[operator="/"])`;
const ARITH_ASSIGN = `:matches([operator=/^(\\*\\*=|[-+*%]=)$/],[operator="/="])`;

// AXIS 3 — value-transparent wrappers: nodes that sit between the arithmetic and the field read
// without changing which number is being operated on. A wrapper is not a hiding place, so the
// fence must see through them, and through several of them stacked. Each entry is the wrapper's
// own node selector plus a `childGuard` constraining which of its children counts as the value it
// wraps ("" = any child).
const GOLF_VALUE_WRAPPERS = [
  {
    // The idioms TypeScript itself pushes you toward for an OPTIONAL served field — `rows[0]?.par`,
    // `a.average!`, `a.average as number`, `a.average satisfies number`, `a.average ?? 0` — plus
    // unary `+`/`-`. Every one of these is a developer working AROUND the type, not changing the
    // number, so the fence looks straight through them.
    node:
      `:matches(ChainExpression,TSNonNullExpression,TSAsExpression,TSSatisfiesExpression,` +
      `UnaryExpression[operator=/^[-+]$/],LogicalExpression[operator="??"])`,
    childGuard: "",
  },
  {
    // A ternary is transparent too, but ONLY through its two value arms. The guard is
    // load-bearing: `total + (p.strokes > 0 ? 1 : 0)` reads a golf field in the ternary's TEST,
    // which is a membership question rather than arithmetic — the guard covers
    // `total - (useNet ? a.average : 0)` while leaving that legitimate shape alone.
    node: "ConditionalExpression",
    childGuard: ":matches(.consequent,.alternate)",
  },
];

// How many wrappers may be stacked between the arithmetic and the field read. Three covers every
// stacking anyone actually writes (`(a.average ?? 0)!`, `(rows[0]?.par as number)`); it is a
// CHOSEN BOUND, not a closure, and it is a number here rather than three hand-written branches
// precisely so raising it is a one-character change instead of another enumeration round.
const GOLF_MAX_WRAPPER_DEPTH = 3;

// Every path from an arithmetic node down to a golf field read: the cross product of axis 3 with
// itself at each depth from 0 to GOLF_MAX_WRAPPER_DEPTH. A path is `> w1 > guard(w1) w2 > ... >
// guard(wN) PROP` — each wrapper's guard constrains the node BELOW it, which is how the ternary's
// arm restriction composes with everything else instead of needing its own hand-written branches.
const GOLF_OPERAND_PATHS = (() => {
  const paths = [`> ${GOLF_PROP}`];
  let sequences = [[]];
  for (let depth = 0; depth < GOLF_MAX_WRAPPER_DEPTH; depth += 1) {
    sequences = sequences.flatMap((seq) => GOLF_VALUE_WRAPPERS.map((w) => [...seq, w]));
    for (const seq of sequences) {
      const steps = seq.map((w, i) => (i === 0 ? w.node : `${seq[i - 1].childGuard}${w.node}`));
      paths.push(`> ${steps.join(" > ")} > ${seq[seq.length - 1].childGuard}${GOLF_PROP}`);
    }
  }
  return paths;
})();

// `+` is the ONE operator whose meaning is ambiguous at the AST level: it overloads numeric
// addition and string concatenation, and no type information is available here to tell them
// apart. Excluding a Literal operand from `+` alone is what keeps `"Par " + hole.par` (display
// concatenation) and `p.strokes + 1` (a UI stepper) out; every other operator matches a
// Literal-adjacent field unconditionally, which is why `hole.par * 2` and `line.par / 2` are
// caught. The cost is stated with the residuals below. The exclusion is scoped to the DIRECT
// operand path only — a wrapped operand (`(h.par ?? 0) + 1`) is an optional-field narrowing
// idiom, the signature of a rule rather than of a stepper, and stays covered.
const NOT_PLUS_LITERAL = `:not([operator="+"][left.type="Literal"]):not([operator="+"][right.type="Literal"])`;
const NOT_PLUS_EQUALS_LITERAL = `:not([operator="+="][right.type="Literal"])`;

// The message says what the rule catches AND names its limits, because three fix rounds proved
// that a fence describing itself as more complete than it is gets trusted past where it works.
const NO_GOLF_ARITHMETIC_MESSAGE =
  "This does arithmetic on a served golf number, which means a golf rule is being re-derived in the web. Move the rule into @swng/domain and call it through @swng/client. The fence catches all six arithmetic operators (+ - * / % **) and their compound-assign forms, either operand order, computed access (line[\"par\"]), up to three stacked value wrappers (?., !, as, satisfies, ?? 0, unary +/-), and a ternary's value arms. It does NOT catch: a value passed through an intermediate variable, a call wrapper (Number(x.par) - ...), a comparator-spelled ranking (a.points > b.points), or `+` between a golf number and a literal — those are listed as known residuals beside the rule in eslint.config.mjs and are misses, not permissions. If this really is display arithmetic over an already-served number rather than a rule, it needs an eslint-disable-next-line stating why; apps/web/src currently carries ZERO exemptions from THIS rule, so a new one should be rare and argued. Never delete or widen this rule just to go green.";

// The generated branch list. One entry per (arithmetic node kind × operand path); the direct-
// operand paths additionally carry the `+`-with-Literal exclusion explained above.
const GOLF_ARITHMETIC_SELECTORS = [
  ...GOLF_OPERAND_PATHS.map(
    (path, i) =>
      `BinaryExpression${ARITH_BINARY}${i === 0 ? NOT_PLUS_LITERAL : ""} ${path}`,
  ),
  ...GOLF_OPERAND_PATHS.map(
    (path, i) =>
      `AssignmentExpression${ARITH_ASSIGN}${i === 0 ? NOT_PLUS_EQUALS_LITERAL : ""} ${path}`,
  ),
].map((selector) => ({ selector, message: NO_GOLF_ARITHMETIC_MESSAGE }));

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
    //
    // The swng-speaks-mcp arc (task 10) scopes this SAME fence to `packages/lambda/src/mcp/**` —
    // the MCP tool table renders golf facts (describeGame et al.) exactly as the web does, but
    // must not compute any (spec §5.2). It gets the identical banlist, not a bespoke one: a
    // hand-rolled MCP fence would drift from the web's the moment either changes.
    files: ["apps/web/src/**/*.{ts,tsx}", "packages/lambda/src/mcp/**/*.ts"],
    ignores: [
      "apps/web/src/**/*.test.ts",
      "apps/web/src/**/*.test.tsx",
      "packages/lambda/src/mcp/**/*.test.ts",
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              // A dedicated entry (Minor 4, task-7 review): the shared message below tells a
              // developer to "import it from @swng/client, not @swng/domain," which is FALSE for
              // playedAtMsOf specifically — task 7 deleted that re-export as dead (zero web
              // callers; every read surface already holds a folded RoundState by the time it
              // asks and reads its own `playedAtMs` field instead — reduceRound already calls
              // this exact function to produce it, so that's a second READ of the one answer,
              // not a second rule). The banlist entry stays regardless — it independently bans a
              // future direct-from-@swng/domain leak in apps/web/src — but its OWN message now
              // says the thing that's actually true.
              name: "@swng/domain",
              allowTypeImports: true,
              importNames: ["playedAtMsOf"],
              message: "playedAtMsOf has no @swng/client re-export — read state.playedAtMs off the folded RoundState you already have instead.",
            },
            DOMAIN_COMPUTE_BANLIST,
          ],
        },
      ],
      // The RE-DERIVATION fence. The `no-restricted-imports` rule above only catches IMPORTING a
      // banned compute name — it never noticed a rule being RETYPED inline instead, which is how
      // two real leaks shipped: the crew board's `a.average - b.average` (deleted task 4) and
      // RecordSections.tsx's `(score - par) * 2` (moved into `nineHoleContribution`, task 5). This
      // rule closes that: golf arithmetic over a SERVED field is a rule being re-derived in the
      // web, and the boundary says rules live in @swng/domain.
      //
      // A regex-based test file was tried first and lost — reversed operands, an intermediate
      // local, and the `?? 0`/`!` narrowing idioms TypeScript pushes you toward for an optional
      // field all defeat text matching. It is deleted; this is the one mechanism, so a green
      // `pnpm lint` means one thing rather than two things with different coverage.
      //
      // WHAT THE SELECTORS ARE MADE OF, and why they are generated rather than listed: see the
      // three axes near the top of this file (`GOLF_ARITHMETIC_PROPS`, `ARITH_BINARY`/
      // `ARITH_ASSIGN`, `GOLF_VALUE_WRAPPERS`). Every branch here is one cell of their cross
      // product. Four hand-enumerated attempts each left a hole on whichever axis the author
      // wasn't thinking about — the fourth found that `/` and `%` had never been in the operator
      // set at all, which is the class this fence most needs to see (`averageOf`'s mean,
      // `resolveStrokes`' nine-hole halving, and `allocateStrokes`' `Math.floor(strokes / holes)`
      // base-dots rule are ALL division); that `rows[0]?.par * 2` was invisible because `?.` had
      // only ever been unwrapped underneath `??`; and that the property axis had never been
      // revisited at all, so `line.score * 2` — the nine-hole doubling rule, over the other
      // operand — passed clean. Enumeration was the defect, not any particular missing entry.
      //
      // There is a FOURTH axis, and it is the one that fails silently and biggest: WHICH FILES the
      // rule applies to — the `files` and `ignores` globs at the top of this block. Small edits to
      // them switch the fence off wholesale while `pnpm lint` stays green: deleting `**/` (three
      // characters) drops 53 of 60 web source files, narrowing `*.{ts,tsx}` to `*.ts` drops all 40
      // React components, and one `[A-Z]*.tsx` added to `ignores` does the same. Every one of them
      // takes out the four files whose leaks motivated this rule. So the check below does not lint
      // a fixture at some invented path and call that coverage — it enumerates the real tree and
      // asserts this rule is in effect for EVERY non-test file under `apps/web/src`, then lints its
      // fixture at real paths sampled from that same enumeration. A new file or directory is
      // covered by construction; a glob edit fails the gate.
      //
      // COVERAGE IS PROVEN BY MUTATION, NOT BY THIS COMMENT — and the proof is committed, not
      // performed once and thrown away. `scripts/checkGolfArithmeticFence.mjs` lints a fixture of
      // 90 spellings against THIS rule and fails if any FIRE line goes silent or any SILENT line
      // fires; `pnpm lint` runs it, and `apps/web/test/golfComputeFence.test.ts` fails if `pnpm
      // lint` stops running it. Round 2's regression (a Literal exclusion that stopped catching
      // `hole.par * 2`) fails that check today, by execution, as does every glob edit above. If you
      // change a selector, let the check tell you what you did; do not trust prose, including this
      // paragraph.
      //
      // Known, accepted residuals. These are the shapes this rule CANNOT see. Static AST matching
      // without dataflow analysis has a real boundary, and stating it honestly is the point — an
      // overclaiming comment teaches the next reader to trust coverage that isn't there, which is
      // exactly how fix round 2's regression shipped:
      // - AN INTERMEDIATE LOCAL. `const { score, par } = line; const raw = score - par; raw * 2;`
      //   — neither the field read nor the multiplication shares an expression with the other. No
      //   selector can follow a value through a variable. This is the big one, and it is why this
      //   rule is a tripwire for accidents, not a defence against someone determined to route
      //   around it.
      // - A CALL WRAPPER. `Number(a.average) - Number(b.average)`, or a difference between two
      //   sanctioned domain calls. DELIBERATELY not covered: `CallExpression` is the SANCTIONED
      //   escape (call @swng/client), so treating it as transparent would flag the very pattern
      //   this fence wants people to reach for.
      // - A COMPARATOR-SPELLED RANKING. `sort((a, b) => a.points > b.points ? -1 : 1)`. DELIBERATELY
      //   not covered, on evidence: adding `<`/`>`/`<=`/`>=` was tried against the real tree and
      //   fires on `describeGame.ts`'s `lines.filter((l) => l.skins > 0)` — a membership filter,
      //   not a ranking rule — with no clean way to separate the two. A false positive on real
      //   code is how a fence gets deleted by the next person, so the miss is the better trade.
      // - `+` WITH A LITERAL. `p.strokes + 1` is a stepper and `"Par " + hole.par` is display
      //   concatenation; `+` overloads both meanings and the AST carries no types, so the Literal
      //   exclusion on `+` (direct operands only — see `NOT_PLUS_LITERAL`) also hides a genuine
      //   rule that ADDS a served field to a literal. Every other operator is unconditional.
      //   The same tradeoff runs the other way for a WRAPPED operand: `"Par " + (hole.par ?? 0)`
      //   DOES fire, because the exclusion is direct-operand-only. That is an over-fire on
      //   display code, accepted deliberately — a `?? 0` participating in `+` is also exactly what
      //   a hand-rolled accumulator looks like (`t += h.par ?? 0`), this app renders through
      //   template literals rather than `+` so the shape does not occur here, and the message
      //   tells you how to exempt it with an argument. Both halves are pinned in the fixture.
      //   `hole.par += 1` is silent for the same `+` reason `hole.par + 1` is, while
      //   `hole.par -= 1` fires: the asymmetry is the ambiguity of `+`, not an oversight.
      // - TEST FILES ARE NOT FENCED AT ALL. This block's `ignores` exempts `*.test.ts(x)` — a
      //   test legitimately computes its own expected values as an oracle. It is inherited from
      //   the import-ban rule above and applies here too, so a re-derivation inside a `.test.tsx`
      //   is invisible. Deliberate, but worth knowing before trusting a green run.
      // - FOUR OR MORE STACKED WRAPPERS. `GOLF_MAX_WRAPPER_DEPTH` is 3, which covers every
      //   stacking anyone writes; a fourth turn passes. It is a chosen bound, not a closure.
      // - COMPUTED ACCESS THROUGH A VARIABLE. `line[key] * 2` — the field name isn't in the source,
      //   so no selector can know which field it is. `line["par"]` (the literal form) IS caught.
      // - AN INCREMENT. `hole.par++` is an `UpdateExpression`, not one of the arithmetic operators.
      //   Left out on purpose: incrementing a served field is a mutation bug, not a rule being
      //   re-derived, and it is not a shape any of this fence's real leaks took.
      // - A GOLF FIELD UNDER A NAME NOT ON THE PROPERTY AXIS. The axis is hand-maintained ON
      //   PURPOSE and should stay that way: deriving it mechanically from "every numeric field on
      //   the wire" would sweep in `createdAt`, `seq`, `counter`, `rating`, `slope`, `yardage`,
      //   `hole`, `number` and `memberCount` — each excluded above precisely BECAUSE including it
      //   makes this rule fire on legitimate code. That would swap a hand-maintained inclusion
      //   list for a hand-maintained exclusion list and turn a quiet miss into a false positive,
      //   which is the failure mode that actually gets a fence deleted. What IS pinned:
      //   `apps/web/test/golfComputeFence.test.ts` fails the build if any `z.number` field in
      //   `packages/contracts/src` is neither on this axis nor on an explicit, named exclusion
      //   list — so a new served number cannot appear without someone classifying it, and the
      //   judgment stays with a person and gets recorded. Worth knowing: `total` is the most
      //   generic name on the axis, and the one place a future non-golf `.total` (a paging or
      //   result count) could collide. Not a problem today — the only `.total` the web reads is a
      //   game line's — but it is the entry to revisit first if this rule ever fires somewhere
      //   surprising.
      "no-restricted-syntax": ["error", ...GOLF_ARITHMETIC_SELECTORS],
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
