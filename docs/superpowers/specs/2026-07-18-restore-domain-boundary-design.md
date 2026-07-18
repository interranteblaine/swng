# Restore the domain boundary: golf logic lives in the domain, the frontend renders

- **Date:** 2026-07-18
- **Status:** Owner-approved design session (this document is the record).
- **What this is:** not a feature and not "papercut 17." It is a **correction to a broken
  architecture boundary.** Papercut 17 (the profile hand-computing your trend and distribution) is
  one symptom of it; this spec addresses the root cause and every instance of it we found.

## 1. The root cause

The architecture has one rule that governs this: **golf logic lives in the domain, behind the API;
the frontend displays results, it does not compute them.** That rule was never *enforced* — the
lint layering check only constrains import *direction* (the web may import the domain), never
whether a view re-derives a golf result inline. So across many milestones, golf logic leaked into
`apps/web`: the profile computes your scoring stats, the scorecard computes net scores, the round
screen computes who is winning and whether you may finalize, two pages each hand-roll the
unrated-course handicap. The web now holds a **shadow copy of golf logic the domain does not own.**

Two concrete harms, not abstractions:
1. **The API is not the contract.** The moment a second client hits it — the MCP server, a Swift or
   Android app — these results are not there; they exist only inside the web's JavaScript. The
   feature is absent for that client, or gets reimplemented and drifts.
2. **The core is not tested through its boundary.** Logic in a React file is exercised (if at all)
   as a component, not as the domain. The package that is supposed to be the authoritative, tested
   core cannot vouch for numbers it does not contain.

## 2. The invariant (the whole design)

**Golf logic lives in `@swng/domain`. It runs in exactly two places, and the frontend is neither:**

- **The server, behind the API** — for everything a client *reads*: analytics, standings, finalized
  results. Any client (web, MCP, mobile) consumes the result; none recompute it.
- **The client's live-round fold, via the *same shared domain library*** — because a round must
  score with no signal, on a golf course. This is the one place the client runs domain code, and it
  runs the identical `@swng/domain`/`@swng/client` fold, converging to the authoritative server
  settle. It is not inline arithmetic in a view.

**`apps/web` does presentation only:** layout, string formatting, display sort order, which control
to show, pixel/SVG coordinates. It computes no golf result.

**The boundary is enforced by construction, not by discipline:** `apps/web` may import only (a) the
contracts types (API response shapes), (b) `@swng/client` (the live round and its scored state), and
(c) the domain's small *presentation* formatters (`formatHandicapIndex`, `formatCourseHandicap`,
`strokeGrant`). It may **not** import the domain's *compute* functions (`scoreGame`, `reduceRound`,
`settleRound`, `golferMetrics`, `allocateStrokes`, `courseHandicapFor`, …). An ESLint
`no-restricted-imports` rule makes a new leak fail on the commit that introduces it.

## 3. The leak inventory and where each piece goes

The audit of `apps/web/src` found ten golf computations in the frontend. Each moves into
`@swng/domain`; the frontend renders the result.

**A — Post-hoc analytics → the domain, served via the API (`GET /me/record`):**
| leak | destination |
|---|---|
| `ProfilePage.tsx:74` career scoring distribution (the `reduce`) | `golferMetrics.distribution` |
| `ProfilePage.tsx:14` index-trend window (last-20 differentials) | `golferMetrics.trend` |

These are read-only, need no clock stamp, and are computed once server-side in `getMyRecord` — the
same read-projection the indices already are. The web renders `record.metrics.distribution` /
`record.metrics.trend`.

**B — Live-game results → the scored game the domain already produces:**
| leak | destination |
|---|---|
| `describeGame.ts:55-56` par-thru sum + relative-to-par | fields on `scoreGame`'s scored line |
| `describeGame.ts:59-62` stroke-play leader | a leader on `scoreGame`'s scored game |
| `describeGame.ts:69-70` stableford leader | same |
| `describeGame.ts:112-121` skins holes-decided / carry | a field on `scoreGame`'s skins state |

`scoreGame` (domain) already produces the scored game; it just does not surface *relative-to-par*,
*the leader*, or *skins carry*. It will. Then `describeGame` becomes **pure formatting** of
domain-provided numbers — presentation, which may stay in the web. The client's live fold and any
future API read share the one implementation.

**C — Other domain functions → the domain:**
| leak | destination |
|---|---|
| `finalizeReadiness.ts:16-77` unresolved-games / missing-holes rule | a domain function shared with `settleRound`'s must-resolve set |
| `ScorecardGrid.tsx:74` per-cell net (`gross − dots`) | a domain `netStrokes` (or per-cell nets on the scored game) |
| `dots.ts:31` `totalDots` (dots total) | a domain export beside `gameStrokeAllocation` |
| `CreateRoundPage.tsx:137` + `JoinRoundPage.tsx:137` unrated course-handicap estimate (duplicated) | one domain `unratedCourseHandicap(index, holeCount)` in the handicap module |

**Legitimately staying in the web** (named, so the boundary is unambiguous): SVG/pixel coordinates,
chart bar widths, display sorts (e.g. season standings sorted for the table — the *result* comes
from the API), form-entry helpers, `roundLabel` date formatting, and the offline live-round fold
(`useRoundSession`/`useWatchRound`/`ArchivedRoundPage` running `@swng/client`'s scoring — the shared
library, not inline arithmetic).

## 4. Closing the door so it stays shut

Enforcement is structural, in three parts:
1. **The math moves out.** Every item in §3 lands in `@swng/domain`; the web imports the result.
2. **The offline-live sites go through `@swng/client`.** `useWatchRound` and `ArchivedRoundPage`
   currently import `reduceRound`/`scoreGame` from `@swng/domain` directly; they route through
   `@swng/client` (which owns the fold) instead, so the web never touches domain *compute* at all.
   (Their locally re-declared `KNOWN_GAME_KINDS` constant is deleted in favor of a `@swng/client`
   export — one source for "which kinds we score.")
3. **The linter forbids the import.** An ESLint `no-restricted-imports` (or the flat-config
   equivalent) on `apps/web/**` allows `@swng/contracts`, `@swng/client`, and the named domain
   *formatters* only, and rejects any other `@swng/domain` value import. A future inline leak fails
   `pnpm lint` on its own commit. The rule is the boundary; prose is the explanation.
4. **Write the boundary down.** `docs/architecture.md` gains a short, plain "Where golf logic lives"
   section (this §2), and `docs/engineering-conventions.md` — the repo's stated enforced source of
   truth — references it and the lint rule. None of this is documented today.

## 5. Deploy & data

- **Bucket A (analytics)** changes `getMyRecord` and the `metrics` wire → **`deploy:beta`,
  LAMBDA-FIRST** then `publishWeb` (the required new `metrics` fields break an old bundle only
  web-first; the old bundle strips them). **No data migration, no wipe** — distribution and trend
  are computed on read from existing lines.
- **Buckets B & C** move math into `@swng/domain` consumed by `@swng/client` and the web; the new
  scored-game fields are additive on a value the round already folds — **no wire change, no
  `deploy:beta`**, `publishWeb` only. (If any live-game result is also chosen to be served over the
  API for non-web clients, that is an *additive follow-on* the moved math enables — not part of
  restoring the boundary, and not built here.)

## 6. Sequencing (each step green and independently reviewable)

Executed subagent-driven, one bucket at a time, `pnpm validate` green at every commit:
1. **Analytics** — `golferMetrics` grows `distribution` + `trend`; contracts + `getMyRecord` serve
   them; `ProfilePage` renders them and deletes its `reduce`/`trendPoints`. (Absorbs papercut 17.)
2. **Live-game results** — `scoreGame`'s scored output carries relative-to-par, the leader, and
   skins carry; `describeGame` becomes pure formatting.
3. **Finalize-readiness** — a domain function shared with `settleRound`; the web's `finalizeReadiness`
   becomes a thin caller (formatting the returned hole ranges is view).
4. **Net + totalDots + unrated estimate** — three small domain functions; the web calls them.
5. **Seal the boundary** — route `useWatchRound`/`ArchivedRoundPage` through `@swng/client`; add the
   ESLint import ban; delete the duplicated constant.
6. **Document** — `architecture.md` + `engineering-conventions.md`.

Then the controller-run close-out gate: `deploy:beta` (bucket 1) + `publishWeb` + `e2e:beta` ×2 +
`e2e:field` + a browser walk on a golfer with history (trend/distribution visible) and a live round
(standings, net, readiness), and the docs sweep.

## 7. Testing intent

Every moved computation is now tested **as domain** — a unit test in `@swng/domain` over fixtures,
which is the point (the core vouches for the numbers). The web tests shrink to "renders the value it
was given." The ESLint rule gets a fixture test (an `apps/web` file importing a banned domain
function fails lint). The existing gates (`e2e:beta`, `e2e:field`, the field oracle decks) already
pin end-to-end agreement and must stay green — a moved computation that changes a number is a bug.

## 8. Out of scope

- New API endpoints to serve live-game standings to non-web clients (enabled by this, built when a
  non-web client needs them).
- The offline live-round fold itself — it correctly runs the shared library on-device; it is not a
  leak and does not move.
- Any change to the golf math's *results* — this is a relocation, not a recomputation; the numbers
  are identical before and after (the gates enforce it).
