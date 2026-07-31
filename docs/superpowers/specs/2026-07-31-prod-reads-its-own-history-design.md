# Prod reads its own history

> Status: **approved in conversation** (2026-07-31, owner). Small arc, prod-facing.
>
> This spec was rewritten once, mid-session. Its first draft proposed a permanent compatibility
> arm in the schemas — code the system would carry forever so it could still read an old field
> name. The owner rejected the proportion outright: *"how many records are there? Can't we just
> migrate however many records there are?"* Fifteen records. The answer was to migrate the data
> and ship no compatibility code at all. Both the rejected approach and the reason it was wrong
> are recorded in §7, because the reasoning error is more reusable than the fix.
>
> It also supersedes the "wipe prod round data" precondition recorded in `CLAUDE.md` on
> 2026-07-30, which was a worse version of the same mistake.

## 1. The problem

Production (`https://swng.golf`) has been serving the 2026-07-24 launch build since launch and
holds real golf: **6 golfers, 4 rounds (3 finished, 1 abandoned), 3 snapshots, 8 record lines, 11
course cards, 1 crew.** Two July arcs since then renamed how a player's stroke count is stored. In
the launch build a player on a round is `{golferId, name, tee, courseHandicap}`; at HEAD they are
`{golferId, name, tee, strokes}`, and the mid-round correction event `participant-handicap-set`
has become `participant-strokes-set`.

Deploying HEAD to prod without addressing that makes prod unable to read its own history. Nothing
is wrong with the data — the new reader does not recognise the old spelling.

**Nothing is broken on prod today.** This is a precondition for the next prod deploy, not an
incident.

## 2. Exactly what breaks — measured, not estimated

Every prod table was scanned read-only on 2026-07-31 and every item run against the schema or
type that actually reads it at HEAD.

| stored shape | count | how it is read | result |
|---|---|---|---|
| `participant-joined` events | 9 | parsed (`roundEventSchema`) | **fails** — seat has no `strokes` |
| `participant-handicap-set` events | 3 | parsed | **fails** — no arm matches the discriminator |
| snapshots | 3 | parsed (`roundArchiveSchema`) | **fails** — roster entries, same missing field |
| record lines (projections) | 8 | cast, not parsed | **silently wrong** — `strokes` reads `undefined` |

**Everything else on prod already matches HEAD** and was individually checked: 123 `score-recorded`
cells, 4 `round-created`, 4 `round-started`, 3 `game-added`, 3 `round-finalized`, 1
`round-abandoned`, 150 dedup tombstones, 4 round pointers, 11 course cards, 6 course pointers, 1
crew, 3 crew members, 2 seasons, 6 golfers, 6 sub-pointers.

Three retired shapes appear and need no handling, confirmed by reading rather than assuming:
`game-added.config` still carries `allowance: 1`; archives carry a `handicapping` array; skins
configs carry no `scoring` and pick up the existing `.default("net")`, which is what they were.
All three sit behind non-strict objects, so zod strips them. Six golfer rows carry a dead
`indexSource` map; the golfer item type no longer declares it and nothing reads it. Left in place
— removing it is a write with no benefit.

**Zero `conceded` cells exist on prod**, so the arm deleted on 2026-07-30 costs prod nothing.

### Why the correction events matter more than their count suggests

They are not incidental. **All three of prod's finished rounds had a player's number corrected
mid-round:**

| round | joined at | corrected to |
|---|---|---|
| Rolling Oaks | Pita 0 | **Pita 36** |
| Stonebridge | Blaine 37 | **Blaine 20** |
| Spy Ring | Blaine 16 | **Blaine 13** |

Dropping an unreadable event as "unknown kind" would not fail loudly — it would render every
finished round off its **pre-correction** number, on the scorecard the web folds from
`archive.events`. That is the shape of failure this whole arc exists to refuse.

## 3. Non-goals

**Prod data is never wiped.** No `scrapCourseAndRoundData.mjs` against prod, ever. That script
exists for beta, which is disposable by design.

**No compatibility code ships.** No tolerate arm, no legacy union member, no `?? courseHandicap`
anywhere in the codebase. HEAD's schemas stay exactly as they are. After this arc there is one
shape in the database and one shape in the code.

**No product change.** Nothing about how swng behaves changes. This arc moves 15 stored records
and deploys code that already exists.

## 4. The migration

**Two rules, applied to fifteen records.**

1. In a participant seat, `courseHandicap` becomes `strokes`.
2. `participant-handicap-set` becomes `participant-strokes-set`, with the same field rename inside
   it.

```js
const seat = (p) =>
  p.courseHandicap !== undefined && p.strokes === undefined
    ? (({ courseHandicap, ...rest }) => ({ ...rest, strokes: courseHandicap }))(p)
    : p;

const migrateEvent = (e) => {
  if (e.kind === "participant-joined") return { ...e, participant: seat(e.participant) };
  if (e.kind === "participant-handicap-set" && e.courseHandicap !== undefined && e.strokes === undefined) {
    const { courseHandicap, ...rest } = e;
    return { ...rest, kind: "participant-strokes-set", strokes: courseHandicap };
  }
  return e;
};

const migrateArchive = (a) => ({ ...a, participants: a.participants.map(seat), events: a.events.map(migrateEvent) });
```

Both rules are **guarded on the old shape being present**, which makes the transform idempotent:
an already-migrated record passes through untouched, so a re-run is a no-op and a partial run is
simply a shorter next run.

> **Corrected 2026-07-31, after Task 1's review.** This spec's first draft guarded rule 2 on the
> event *kind* alone. An event carrying `strokes` under the old kind would then have had that
> value overwritten with `undefined` — the exact "confidently wrong beats unreadable" failure the
> paragraph below rejects, written into the rule that rejects it. The condition above is the fix:
> an event failing the guard passes through completely untouched, kind included, so the parse gate
> refuses it loudly. Unreachable on the measured 15 records, but the rule is now what it claims to
> be.

**The translation is faithful, not a guess.** Prod has only ever run one version of this code. Its
`courseHandicap` means one thing — that player's own stroke count on the card — which is exactly
what `strokes` means now. (This is precisely the argument that did *not* hold on beta, which had
run an intermediate model where the same field was sometimes an absolute number and sometimes an
already-typed difference. Beta was wiped; prod is translated. The stage matters.)

### The exact write set — 15 items

| table | key | kind |
|---|---|---|
| rounds | `ROUND#6da61044…` `EVT#…0002`, `EVT#…0004` | participant-joined ×2 |
| rounds | `ROUND#6da61044…` `EVT#…0005` | participant-handicap-set |
| rounds | `ROUND#95814ec7…` `EVT#…0002`, `EVT#…0005`, `EVT#…0009` | participant-joined ×3 |
| rounds | `ROUND#95814ec7…` `EVT#…0035` | participant-handicap-set |
| rounds | `ROUND#8196030f…` `EVT#…0002`, `EVT#…0005`, `EVT#…0006` | participant-joined ×3 |
| rounds | `ROUND#8196030f…` `EVT#…0004` | participant-handicap-set |
| rounds | `ROUND#27a7760d…` `EVT#…0002` | participant-joined (the abandoned round) |
| snapshots | `6da61044…`, `8196030f…`, `95814ec7…` | archive ×3 |

The abandoned round is easy to forget — it has no snapshot by design, but its join event still
has to be readable for the round to load at all.

### The 8 record lines are not migrated — they are regenerated

The snapshots table has its own stream, the projector is its only consumer, that event source
carries **no filter**, and the handler skips only `REMOVE` — `INSERT` and `MODIFY` both project.
So overwriting a snapshot fires the projector exactly as a fresh finalize does, and it re-derives
that round's lines through the same `projectArchive` a real finalize uses.

`putLine` is a single unconditional whole-item `Put` keyed by `roundId` with no timestamp in the
key — the store's own comment calls it "this ONE Put IS the whole upsert." So it is idempotent,
**and** the whole-item overwrite drops the retired `ags`, `differential` and `courseHandicap` keys
without anyone having to remove them.

**`rebuildProjections` is not run.** It exists to re-drive after a poisoned stream record; this is
not that. The architecture re-derives on its own, which is the point of having built it that way.

## 5. Order of operations

**Deploy the lambda first, then migrate, then publish the web.**

Both orders have a window; this one fails *loudly*. New code reading old data throws a named
`stored-event-invalid`. Old code reading new data would find the field missing and quietly draw
the wrong strokes — and worse, the old projector would fire on the snapshot writes and stamp the
old shape straight back onto the record lines, undoing the migration as it happened.

Between the deploy and the end of the migration, prod's four rounds and its record pages return
errors. That window is the time between two commands — seconds to a couple of minutes — on a
six-account app. Do not begin if a round is known to be in progress.

Between the migration and `publish:web:prod`, the served web bundle is the launch one, whose
create/join request shapes the new lambda rejects. Same answer: run them back to back.

## 6. Safety

1. **Export first.** Every item from all four tables to a local JSON file before a single write —
   a few hundred KB. A restore path in hand, not a theory.
2. **Restore is built in**, not improvised: the migration writes the untouched `before` image of
   every record it changes, and a `--restore <file>` mode puts those images back verbatim.
3. **Point-in-time recovery** is already enabled on the rounds, core and snapshots tables — the
   second path, independent of the first.
4. **Dry run prints every before→after and writes nothing.** It is run and read before the real one.
5. **Idempotent by guard** (§4), so a re-run or an interrupted run is safe.
6. **The gate is total, not a spot check:** after migrating, every item in every table is parsed
   with HEAD's own schemas and 100% must pass.

## 7. What the first draft got wrong

The first version of this spec proposed a permanent legacy arm in `roundEventSchema` — the schema
the client parses on *every* event it ever pulls — so that 15 records could be read. That is
badly out of proportion, and the owner named it immediately.

The reasoning error was pattern-matching rather than sizing. This repo does tolerate old stored
shapes in several places (a stray `crewId`, a legacy skins `scoring`, a crew's dead
`standingGame`), so "add a tolerate arm" felt like the house answer. But **that pattern is for
data you cannot enumerate.** Prod's non-conforming data is 15 records with known keys. When you
can enumerate the data, you migrate it; the tolerate arm is what you reach for when you cannot.

A second, compounding error: "prod is never wiped" had been silently widened into "prod is never
touched," which is not the same claim and is what made a code workaround look necessary in the
first place. A migration loses nothing.

There is also a verification lesson worth keeping. The first draft named `participant-joined` and
stopped — because that is the shape the *rename* touched. Prod's actual bytes carry a second
casualty the rename never mentions: a whole retired event kind, load-bearing on all three finished
rounds. It was found by scanning the tables and printing key sets, not by reasoning from the diff.
**A compatibility gate is derived from reading the old data, never from reading the change that
broke it.**

## 8. Verification already performed (2026-07-31, read-only)

Before this spec was written, the whole migration was rehearsed in memory against prod's real
records — pulled live, transformed, and run through HEAD's schemas and domain folds. Nothing was
written.

- 12 events and 3 archives changed by the transform; **0 fail `roundEventSchema` /
  `roundArchiveSchema` afterward.**
- `reduceRound` over each round's migrated events yields: Rolling Oaks `Blaine=21, Pita=36`; Spy
  Ring `Blaine=13, Pita=18, Michael=10`; Stonebridge `Blaine=20, Ryan=0, Pita=36`; and the
  abandoned round `Blaine=31`. **Each matches that round's migrated archive roster exactly** —
  the two independent copies of the truth agree.
- `archiveGolferLine` over each migrated archive produces all 8 record lines cleanly: Blaine
  98/114/53, Pita 119/124/60, Ryan 85, Michael 42, with correct par and hole counts across a par-65
  eighteen and a par-36 nine.
- All 4 distinct participants have golfer rows, so the projector writes every line rather than
  skipping any.
- Transforming twice equals transforming once, on every record.

**`cdk diff swng-prod`** was also run: the entire infrastructure delta is 5 lambda code updates,
the `/rounds/{roundId}/handicap` route destroyed, `/rounds/{roundId}/strokes` created, and the
stage's `DependsOn` list swapping one entry. **No table, user pool, Cognito, WAF, secret or
CloudFront change.** No data-bearing resource is touched and the six accounts are not at risk.

## 9. Done means

1. `cdk diff swng-prod` shows only the delta in §8 — anything stateful stops the deploy.
2. `deploy:prod` completes; `POST /rounds/{roundId}/strokes` exists and `/handicap` does not.
3. The migration reports 15 records written, and the export file exists.
4. Every item in every prod table parses under HEAD's schemas — 100%, checked by script.
5. In a browser on `swng.golf`: each of the 3 finished rounds renders its scorecard with the
   corrected strokes (36, 20, 13 respectively), and a golfer's record page lists their rounds with
   the scores in §8.
6. The 8 record lines carry `strokes` and no longer carry `ags`/`differential`/`courseHandicap`,
   confirming the projector re-derived them from the stream with no manual rebuild.
7. The "Standing precondition" section is deleted from `CLAUDE.md` and replaced by this arc's
   record.
