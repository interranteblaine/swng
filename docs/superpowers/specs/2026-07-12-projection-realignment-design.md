# The snapshot realignment — target design

> **Status:** implemented (2026-07-13). Approved design (2026-07-12, converged in review with
> the owner); executed via `docs/superpowers/plans/2026-07-12-snapshot-realignment.md` (16
> tasks, 4 phases, 4 beta deploys, commits `04b4caf..9a7815f`) — see
> `.superpowers/sdd/progress.md`'s Realignment entries for the execution record. Supersedes the
> earlier correction-only version of this document; the drift record it captured is condensed
> in §8. `docs/architecture.md` §Crew and the persistence sketch are corrected as part of this
> work.

## 0. The rule

**A round is a sealed leaf. Everything points at it; it points at nothing.**

A round records only facts about itself — the frozen course card, who played, the games, the
scores, the results. It carries no field, tag, or reference to a golfer summary, a crew, or a
season. Everything derived references rounds inbound, by `roundId`.

## 1. State model — four stores, one job each

| Store | Holds | Nature |
| --- | --- | --- |
| `rounds` | event logs of rounds in flight | working state; the only event-sourced thing |
| `snapshots` | one immutable record per finished round, keyed by `roundId` | **the atom**; system of record for everything downstream |
| `core` | golfers, courses, crews (roster + seasons + counted rounds) | entities; documents recording acts people took |
| `projections` | golfer records + presence | derived, disposable, rebuildable |

The snapshot is today's `RoundArchive`, moved out of the rounds table into its own table
(pk = `roundId`, one item, tens of KB). A single-purpose table means reading it *is*
enumerating the projection inputs — no scan-through-event-logs, ever.

## 2. The finalize chain

1. A participant taps finalize → the HTTP entry folds the round's events, validates
   settle-ability, and runs `settleRound` (pure) → the snapshot.
2. **One `TransactWriteItems`** commits the `round-finalized` event append (rounds table,
   existing head-seq condition) and the snapshot put (snapshots table) together. DynamoDB
   transactions span tables. The wedge state "finalized but no archive" becomes
   unrepresentable; M9's repair-on-replay branch is deleted with its reason.
3. The snapshots table's stream invokes the projector. Every stream record is a snapshot —
   no filter, no branching.
4. The projector does one thing: **for each participant, update that golfer's record**
   (§3). It does not know crews exist. The chain ends here.

The stream is at-least-once; every projector write is an upsert keyed by `roundId` and the
index is recomputed from the full line set, so re-delivery lands the identical state.

## 3. The golfer record (the one stored projection)

One partition per golfer in the projections table:

```
GOLFER#<golferId>  ROUND#<roundId>   { finalizedAt, courseName, tee, holes, ags?, differential?, distribution }
GOLFER#<golferId>  INDEX             { value, differentialsUsed, computedAt }
GOLFER#<golferId>  LIVE#<roundId>    { courseName, joinedAt, ttl }        ← presence, §5
```

- A **line** is a ~250-byte summary of one finalized round, extracted from the snapshot by
  the existing pure `archiveGolferLine`. The lines ARE the "my rounds" list; each links to
  its snapshot by `roundId`.
- **Keys are identities; time is an attribute.** The sort key is `ROUND#<roundId>` — stable —
  because reopen-and-refinalize changes `finalizedAt`, and a time-embedded key would turn a
  correction into a duplicate item (the exact documented, unrepairable year-boundary bug in
  today's `putCrewRound`). Replace-on-write; order by the `finalizedAt` attribute in memory.
- **Index recompute:** on each finalize, upsert this round's line, Query the golfer's own
  lines (a 1,000-round career ≈ 250KB ≈ two pages), sort by `finalizedAt` in memory, run the
  pure fold (`combineNineHoleDifferentials` → `computeIndexDetail`), replace `INDEX`. Never
  incremental — best-8-of-20 doesn't patch, and full recompute is what makes replay idempotent.

## 4. Crews — fully outside the chain

A crew is entity data in `core`, one partition:

```
CREW#<id>  CREW                        { name, joinCode }
CREW#<id>  MEMBER#<golferId>           { name, role }
CREW#<id>  SEASON#<seasonId>           { name, status: open | closed }
CREW#<id>  SEASON#<seasonId>#ROUND#<roundId>   { roundId, finalizedAt, appendedBy, appendedAt }
```

- **Membership: real accounts only.** `addCrewMember` requires the target golfer to have a
  bound sub; join-by-code is already account-gated. Ghosts exist only inside rounds
  (onboarding stays: play as ghost → claim in-round → account → optionally join a crew).
  **Leave** = delete the member item; past counted rounds stay counted; `applyStandingGame`
  already tolerates absent golfers. Existing beta ghost members are left in place and labeled.
- **Season = a named thing a member creates** ("2026", "Summer Cup"), open/closed. Never a
  calendar computation — `seasonOf = getUTCFullYear` is deleted.
- **Counting a round is an append on the crew page**: a member picks one of *their own*
  finalized rounds; the server checks (caller is a member) ∧ (caller's golferId is in that
  snapshot's participants) ∧ (entry absent), then writes the one entry item above. The round
  is never read-modified, tagged, or touched. Un-count = the appender deletes the entry.
  The same round may be counted in seasons of different crews, or two seasons of one crew —
  each season is its own competition lens.
- **Standings are computed on read, stored nowhere.** Season page → Query the season's
  entries → `BatchGetItem` those snapshots → pure fold (`aggregateSeason` over
  `crewContribution`) in the request. A season is 30–50 rounds × 30–80KB snapshots — one
  BatchGet, a few MB, tens of ms, for a page a handful of people view. Nothing can go stale;
  a re-finalized round is correct at the next look with zero recompute machinery. If a season
  ever measures hot, cache the fold then — not preemptively.
- Non-member golfers appearing in counted rounds (guests, departed members) aggregate as
  recorded and are labeled in the view — standings never depend on membership *history*.

## 5. Presence — live rounds by identity

`LIVE#<roundId>` items in the golfer's own projections partition: written synchronously by
StartRound/JoinRound/AddParticipant for **every** participant golferId (ghosts included — a
mid-round claim inherits home-screen presence for free), deleted by the projector at finalize
(participants are in the snapshot in hand) and by abandon, with a ~36h TTL as the backstop so
a never-finished round can't haunt the home screen. A register, not a projection: no rebuild
path, none needed.

Home: signed-in → "Your rounds" queries `LIVE#` under the caller's golfer. The device-token
list remains **only** for anonymous ghost sessions — a ghost has no identity to query by.

## 6. Capability from identity

`POST /rounds/{roundId}/token` (golfer auth): fold the round; if the caller's golferId is a
participant, mint the same participant token StartRound/JoinRound mint; else 403. New phone,
or seated by a friend → tap the round on home → scoring. Deletes the "seated but locked out"
gap without weakening the token model.

## 7. Scrapping, viewing, listing

- **`round-abandoned`**: a terminal event mirroring `round-finalized`'s fold semantics.
  Produces **no snapshot** — the round aggregates nowhere and drops off presence. Emphatically
  not "mark holes picked-up and finalize." Participant-gated route + confirm-gated "Scrap this
  round" in the round menu. Finalize rejects on abandoned and vice versa.
- **`GET /rounds/{roundId}/archive`** (golfer auth): allowed for a participant, or a member of
  a crew that counts the round in any season (per-crew entry check — the caller belongs to a
  handful of crews, each with a few hundred tiny entries). Spectator links stay the
  anyone-else path. Web: an archived-round page; profile lines and counted-round lists link
  to it.
- **`GET /me/rounds`**: served from the lines (§3) — they already carry course, tee,
  differential, distribution, roundId.

## 8. Replay — two layers, matching the two derivation steps

- **Snapshot → projections (rebuild; routine).** Paged read of the snapshots table — every
  item read is an input; that is what backfill means — running the same per-golfer derivation
  on each record; `{ processed, cursor }` out; re-invoke until the cursor is null. Needed
  when: derivation logic changes (index-math fix; a v2 projection backfilling all history), a
  projector invocation is lost beyond stream retries, or projections are corrupted. No
  buffer-everything, no global sort (order-independent by construction), no wipe step, no
  wipe-race.
- **Events → snapshot (re-settle; rare, surgical).** A defect in `settleRound` itself →
  re-settle the *affected rounds* from their event logs, per round, by id — never a sweep.
  The corrected snapshot write flows through the same stream, so downstream projections
  re-derive automatically.

## 9. What gets deleted (the correction, condensed drift record)

The drift, three times over, was the round pointing outward — competition welded to a
`crewId` on `round-created`, discovery welded to device-held tokens, capability welded to the
join-call artifact. Each fix above is the same inversion. Deleted outright:

- `crewId` from `round-created`, `StartRoundRequest`, `RoundState`, and the snapshot (wire
  schemas tolerate-and-ignore it on old stored events; nothing writes or reads it).
- The projector's crew arm; `putCrewRound` / `putSeasonRecords` / `getSeasonRecords` /
  `wipeCrew`; the `CREWROUNDS#` / `RECORDS#` keyspaces; `seasonOf = getUTCFullYear`.
- The `ARCHIVE` item in the rounds table and the full-table-scan `ArchiveSource`.
- `rebuildProjections`' buffer / global-sort / wipe-then-replay and its documented
  lost-finalize race.
- Time-embedded sort keys (`HISTORY#<ms>#`, `CREWROUND#<ms>#`), both query-then-delete
  idioms, and the unrepairable year-boundary bug class.
- `finalizeRound`'s repair-on-replay branch (subsumed by the transaction).
- Ghost-adding to crews.

Nothing new gets a GSI, a shard, or a pointer item.

## 10. Intentional couplings to keep (do not over-correct)

Values frozen *into* the round, consistent with the rule: the embedded frozen `CourseCard`;
`courseHandicap` frozen at join; the `INDEX` item as a rebuildable read cache; `tabDeviceId`
as a sync-correctness id.

## 11. Deploy & migration notes (beta only)

- New `snapshots` table + stream is additive CDK; the projector's event source moves to it.
- One-time copy of existing beta `ARCHIVE` items into the snapshots table (a handful).
- Golfer-record keyspace change: rebuild-from-snapshots repopulates it; old `HISTORY#` items
  and the `CREWROUNDS#`/`RECORDS#` keyspaces are dropped.
- M8 crew-ledger data: no migration — beta test data; dogfood rounds get re-appended by hand.
- `swng-beta` only, `pnpm deploy:beta` only, never the `InfraCdkStack-*` names.

## 12. Implementation path — four steps, each its own reviewed task chain

1. **The atom**: snapshots table; transactional finalize; projector source move; beta archive
   copy; delete the scan `ArchiveSource` and the repair branch.
2. **The record**: golfer record on stable keys; rebuild-as-backfill with cursor; delete
   wipe/sort/buffer; `GET /me/rounds` + snapshot view + web archived-round page.
3. **The crew correction**: seasons + counted rounds + standings-on-read; de-ghost; leave;
   delete `crewId` and the crew projection layer; crew-page web (seasons, count-a-round
   picker, standings, leave).
4. **Identity presence & capability**: `LIVE#` presence + home "Your rounds"; token re-mint;
   `round-abandoned` end-to-end.

Step 1 precedes 2 (rebuild reads the snapshots table); 3 and 4 are independent after 1.
