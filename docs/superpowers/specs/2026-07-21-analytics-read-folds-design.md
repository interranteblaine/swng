# Analytics — read folds over sealed rounds

> Status: **approved surface, spec for review** (owner design session, 2026-07-21).
> Mockup (owner-reacted, three revision rounds): claude.ai artifact `7a167ca5`.
> A competing design (a dedicated analytics fact table + projector + manifest/revision
> protocol + geographic scopes + opt-in leaderboards) was considered and REJECTED: it
> re-introduces the stored-derived-value machinery this repo deleted twice (the `INDEX`
> snapshot, the crew projection layer), guards a re-finalization flow that doesn't exist,
> and invents product surface (geography, stranger leaderboards) with no product.md basis.

## 1. The model (binding)

1. **The snapshot is the only truth.** Every analytic, everywhere, is a pure
   `@swng/domain` fold over facts that originate in `RoundArchive` snapshots. No derived
   number is ever stored.
2. **Every scope stores only a list of its rounds** — the golfer's row-per-round-played
   (the projections table), the crew's counted-round list. These lists must exist
   regardless; nothing else can answer "which rounds are yours."
3. **Exactly one performance cache exists:** the golfer's row carries a small extract of
   *their own* facts from the snapshot (it already does — `GolferRoundLine`), because the
   golfer fold is career-sized and the hottest read in the app. It is written by the ONE
   projector (`projectArchive`) and rebuildable from snapshots (`rebuildProjections`) —
   a cache, never a second truth.
4. **The crew folds snapshots directly** (bounded, season-sized reads; its facts — game
   results between members — are round-level and live whole in the snapshot). Unchanged.
5. **The crew is the only leaderboard** (owner ruling, 2026-07-21). No population course
   stats, no geography, no cross-stranger surfaces of any kind.
6. Golf logic stays behind the domain-boundary fence: folds and sentence-formatters live
   in `@swng/domain`; the server runs them; `apps/web` renders served results and
   computes nothing.

## 2. The one storage change: `holeResults` on the golfer's row

`GolferRoundLine` gains one additive field, written by `archiveGolferLine` in the same
walk that already builds `distribution` (one producer, one put — the two can never drift
independently; `distribution` stays for its existing consumers):

```ts
readonly holeResults: readonly {
  readonly hole: number;   // card hole number, ascending
  readonly par: number;    // the FROZEN card's par for that hole, at play time
  readonly result:
    | { readonly kind: "strokes"; readonly strokes: number }
    | { readonly kind: "picked-up" }
    | { readonly kind: "conceded" };
}[];
```

- Decided cells only, via `cellAt` — unscored and cleared holes are omitted.
- **Backfill = one `rebuildProjections` run** (snapshots are total; the field is fully
  derivable). Until/unless a line has it, readers EXCLUDE that round from hole-based
  stats and keep sample counts honest — never a throw, never a zero.
- The wire history line (`toWireLine`) does NOT carry `holeResults` — the wire serves
  computed results, not bulk facts.
- **Frozen-card semantics:** `par` comes from the card as played; a later card
  supersession never rewrites any historical number. Cross-round aggregation joins by
  course lineage (`courseId`) + hole number. A club renumbering its holes blends
  different grass under one number — a rare edge, accepted rather than building
  hole-identity machinery (recorded, not scheduled).

**Shared definition used everywhere below — "fully holed out":** every hole of the tee
set has a `strokes` result. `gross` = sum of strokes; `toPar` = gross − line `par`.
Records and averages are computed from fully holed-out cards only — a pickup round can't
hold a record.

## 3. Profile — `golferMetrics` grows (existing routes)

Served on `GET /me/record` and `GET /golfers/{golferId}` through the existing shared
`recordOf` fold. Additive `GolferMetrics` members:

- **`bests`**: `{ best18?, best9? }`, each `{ roundId, gross, toPar }` — lowest gross
  among fully holed-out 18s (resp. 9s); tie goes to the earlier round (first to set a
  record holds it). The web renders course + date by joining `roundId` against the
  history in the same response (rendering, not golf compute).
- **`milestones`**: `readonly { kind, roundId }[]`, achieved-only, each the EARLIEST
  qualifying round in canonical line order:
  - `first-birdie` / `first-eagle` — first round (9s count) containing a hole result 1
    (resp. ≥2) under its frozen par.
  - `broke-100` / `broke-90` / `broke-80` / `broke-70` — first fully holed-out **18**
    with gross under the threshold.
  - The web may render a "Best round" line inside the Milestones block from `bests`.
  - Milestones are computed on read: a corrected card self-heals them.

**Owner ruling recorded (2026-07-21): par-type scoring is CUT.** Raw par-3/4/5 averages
carry no insight and aren't comparable across types; the vs-par-per-18 reframe is
dominated by the card's own composition (~10 par 4s always "win"). Both forms rejected.
This supersedes product.md §5's "par-3/4/5 averages" line for this build. Do not
resurrect without a new owner ruling.

## 4. Course page — "Your record here" (one new route)

`GET /me/courses/{courseId}/record` (auth `golfer`; NOT anon-throttled). Reads the
caller's own rows filtered to `courseId` — no new read pattern, nobody else's numbers.
Domain fold `courseRecord(lines, courseId)` returns structure; sentence copy lives in
domain present-layer formatters (the `handicap/present.ts` / `scoring/present.ts`
precedent); the web renders.

- **Your record here** (shows from the 1st round): rounds played · best round
  (`{ roundId, gross, toPar }`) · scoring average (mean gross over fully holed-out
  rounds; homogeneous hole count by lineage construction — a course is 9 or 18).
- **The holes, by name** (whole block gated at **≥5 rounds** at the course; below it a
  "keep playing" line — the index-over-time gating precedent):
  - *The hole that gets you* — highest average-over-par among holes with ≥3 decided
    plays; ties → more doubles-or-worse, then lower hole number. Served with the how:
    avg over par, doubles count, rounds counted.
  - *Your scoring hole* — highest par-or-better rate (≥3 decided plays); ties → lower
    hole number.
  - *Never birdied* — the list of holes with zero birdies-or-better across all decided
    plays; SHOWN only when 1–3 holes remain (i.e. "you've birdied every hole but 7"),
    otherwise noise. The domain owns the ≤3 threshold, not the web.

## 5. Crew — new folds beside the existing standings (compute on read, nothing stored)

Same reads as today: the season's counted snapshots. Extends the standings response;
all-time gets `GET /crews/{crewId}/records` folding ALL seasons' counted rounds
(deduped by roundId). Current-roster scoping applies to every number, exactly as the
existing ledger (leave → rows vanish; rejoin → restored).

- **Partner records (four-ball):** per counted round's four-ball results, each side's
  pair — both current roster members, else excluded — accumulates W–L–H. Sorted wins-desc.
- **Lowest net average:** per member, mean of (gross − courseHandicap) over fully
  holed-out counted rounds they played; computed per hole count, displayed for the hole
  count with more qualifying rounds (tie → 18); **min 3 qualifying rounds**; missing
  data is never ranked as zero — unqualified members are omitted.
- **Most improved:** swng index as of the season's first counted round vs. as of its
  last — each member's own `indexHistory` point AT-OR-BEFORE each of those two rounds'
  finalized times (this read fetches members' rows, a new but bounded cross-read: one
  query per roster member). Eligible
  only with an index at BOTH ends; biggest drop wins; omitted if nobody qualifies.
  Rendered "14.2 → 11.8".
- **All-time:** lifetime head-to-head and skins via the existing `aggregateSeason` over
  the union of counted rounds; **season titles** = each closed season's Stableford
  points leader under the current-roster filter, rendered "Bo '24 · Al '25".
- Cost note, recorded not scheduled: if all-time folds over hundreds of counted rounds
  ever get slow, add a per-round crew summary row THEN (rebuildable, mechanical) —
  never a stored aggregate.

## 6. Wire & deploy

- All response changes are additive optional fields plus one new route; request wire
  unchanged. Old bundles strip unknown response keys (non-strict response schemas —
  house style). **Deploy lambda-first**, then `publishWeb`, then ONE
  `rebuildProjections` run to backfill `holeResults`. No wipe, no migration.
- Route count changes: +`GET /me/courses/{courseId}/record`, +`GET /crews/{crewId}/records`.

## 7. Out of scope (recorded)

- Population course stats, geographic analytics, named or anonymous stranger
  leaderboards, and analytics visibility preferences (owner-aligned 2026-07-21: the crew
  is the only leaderboard).
- Per-hole tags (putts/fairways/GIR — product.md §4/§5): a SCORING feature (new event
  kind + ScorePad surface) needing its own owner-ruled design; when it lands it rides
  this same pipeline as additive line fields.
- Milestone *firing* (push/feed) and the Season-in-Golf recap: the Feed pillar's push
  side; the computed values here are its future inputs.
- Warehouse/S3 export: only ever as an additional consumer of snapshots for internal
  analysis, never an authority; nothing built now.

## 8. Testing

- Domain: hand-pinned fixtures for every fold (bests ties, milestone earliest-round
  rules, holed-out edge cases incl. picked-up/conceded/cleared cells, course-record
  gates and tie-breaks, partner-pair extraction, net-average hole-count split,
  most-improved eligibility). A golden test pins `holeResults` against a known archive's
  cells; a tolerance test proves folds skip rows without `holeResults` with honest counts.
- Rebuild parity: existing mechanism; assert a rebuilt row carries `holeResults` equal to
  a freshly projected one.
- E2E: `identityRecord.spec.ts` gains bests/milestones assertions on its hand-pinned
  rounds; a course-record beat on the course page; `crewSeason.spec.ts`'s FROZEN deck
  assertions stay byte-identical, with partner records / superlatives / all-time asserted
  additively — expected values hand-derived from the frozen deck BEFORE the first live
  run (the deck discipline).
- Structural: the web compute fence must still pass — every new number arrives on the
  wire.
