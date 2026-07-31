# Prod reads its own history

> Status: **approved in conversation** (2026-07-31, owner). Small arc, prod-facing.
> Supersedes the "wipe prod round data" precondition recorded in `CLAUDE.md` on 2026-07-30,
> which was an error.

## 1. The problem, in one paragraph

Prod has been running the 2026-07-24 launch code since launch and holds real golf: **6 golfers,
3 finalized rounds, 304 items in the rounds table, 8 projection rows.** In that code a player on
a round is stored as `{ golferId, name, tee, courseHandicap }`. The typed-strokes arc
(2026-07-30, on beta) renamed that number: a player is now
`{ golferId, name, tee, strokes }`. Deploying the new code to prod without a translation makes
prod unable to read its own history.

**Nothing is wrong with the data.** The new reader does not recognise the old field name.

## 2. What actually breaks, per read path

Verified by reading prod directly (read-only scans, 2026-07-31):

| stored shape | field on prod today | parsed or cast? | symptom on deploy |
|---|---|---|---|
| `participant-joined.participant` (rounds table) | `courseHandicap` | **parsed** since 2026-07-30 Task 6 | `stored-event-invalid` — the round refuses to load |
| `participant-handicap-set` **event** (rounds table, ×3) | whole event kind is retired | **parsed** | `stored-event-invalid` — no arm matches the discriminator at all |
| `archive.participants[]` (snapshots table) | `courseHandicap` | **parsed** | `stored-archive-invalid` — the finished scorecard refuses to render |
| `archive.events[]` (snapshots table) | contains both shapes above | **parsed** | same two failures, inside the archive |
| `GolferRoundLine` (projections table) | `courseHandicap`, plus retired `ags`/`differential` | **cast** | no throw — `strokes` reads `undefined` behind a type that promises a number, so stats render wrong rather than erroring |

**The retired event kind was missed on the first pass and is the sharper of the two problems.**
It is not merely a shape prod happens to carry — it is load-bearing on **all three** of prod's
finished rounds. Every one of them had a player's number corrected mid-round:

| round | joined at | corrected to |
|---|---|---|
| Rolling Oaks (Blaine, Pita) | Pita 0 | **Pita 36** |
| Rolling Oaks (Blaine, Ryan, Pita) | Blaine 37 | **Blaine 20** |
| Master tees (Blaine, Pita, Michael) | Blaine 16 | **Blaine 13** |

So dropping the event rather than translating it would not fail loudly — it would render each of
those rounds off the **pre-correction** number, silently, on the archived scorecard the web folds
from `archive.events`. Wrong dots on every finished round prod has. Translating it is mandatory,
and "strip the unknown kind" is the wrong instinct here for exactly the reason the whole arc
exists: silent reinterpretation is worse than refusal.

Two other retired shapes appear on prod and need **no** handling, confirmed by reading them:
`game-added.config` still carries `allowance: 1`, and every archive carries a `handicapping`
array. Both sit on non-strict `z.object`s, so zod strips them. Prod's skins configs carry no
`scoring` key and pick up the existing `.default("net")` — which is what they were. Every one of
prod's 123 `score-recorded` cells is a `strokes` cell: **zero** `conceded`, so the deleted arm
costs prod nothing.

Two compounding consequences of the first two:

- Opening any of prod's 3 finished rounds shows an error instead of a scorecard.
- `rebuildProjections` stalls: `snapshotStore.page()` parses a page eagerly in one `.map`, so one
  unparseable snapshot takes down the good items ahead of it and the cursor never advances. **The
  repair instrument is disabled by the data it would repair** — which is why this is a
  before-deploy gate, not an after-deploy fix.

## 3. Non-goals — stated because the first attempt got this wrong

**Prod data is never wiped, and never rewritten in place.** No `scrapCourseAndRoundData.mjs`, no
backfill that mutates stored items. The stored bytes at the end of this arc are byte-identical to
the stored bytes at the start. Any plan whose step is "delete the rounds" is rejected on sight.

## 4. The remedy: a legacy read arm

The stored schemas accept **either** shape and normalise at parse time:

```ts
// A participant written before the typed-strokes arc carries `courseHandicap` — the same number
// under its old name. Normalised on the way in; nothing stored is rewritten.
const storedParticipant = z
  .object({ golferId, name, tee, strokes: z.number().int().optional(), courseHandicap: z.number().int().optional() })
  .transform(({ courseHandicap, ...p }) => ({ ...p, strokes: p.strokes ?? courseHandicap }))
  .refine((p) => Number.isInteger(p.strokes));
```

There is deliberately **no `?? 0` fallback.** A participant carrying neither field is refused, not
seated at zero: zero is a legal, meaningful strokes value, so defaulting to it would convert an
unreadable seat into a confidently wrong one — the exact failure the 2026-07-30 arc's parse
boundary was built to stop. Refusal is the correct outcome for a shape we cannot read.

The retired **event kind** is translated the same way and for the same reason
(`participant-handicap-set {golferId, courseHandicap}` → `participant-strokes-set {golferId,
strokes}`), so a corrected round folds to the number it was actually played off.

**One rule, one definition, every door.** The `courseHandicap → strokes` mapping is written once
and referenced by each site that reads a stored value: the participant seat, the retired event
kind, the settled roster entry, and the projection line. The prior arc's own lesson applies
directly — it found that a settled round is read back through four separate doors and fixed all
four together, because a snapshot the projector refuses must not be one the standings quietly
fold. The same discipline binds here: the client parses pulled events with `roundEventSchema`, the
server parses stored ones with the same schema, and `roundArchiveSchema.events` parses them a
third time. A normalisation applied to two of those three is a drift bug waiting to be found in
the field.

**A known mechanical hazard, flagged rather than discovered late:** `roundEventSchema` is a
`z.discriminatedUnion`, and a member carrying a `.transform` may not stay discriminable. If it
does not, normalise ahead of the union rather than inside it — but then `roundArchiveSchema.events`
must reference the normalising schema too, not the raw union, or the archive door is left open.

**The projection line is normalised, not newly parsed.** The adapter's `listLines` cast stays a
cast. The spec's first draft said this change would close it; that over-reached. Prod's stored
lines carry `courseHandicap`, `ags` and `differential` alongside every field the current type
requires, so the mapping is a one-field fix with a known blast radius — whereas authoring a first
stored-line schema over a shape that has drifted across five milestones would put a whole
golfer's record behind a new required-field check, converting a narrow read bug into a new class
of outage. Closing that cast remains recommended, in its own arc, on its own evidence. The
recommendation already written into `createDynamoProjectionStore.ts` stays exactly where it is.

The retired `ags` and `differential` keys on prod's projection lines need no handling: zod strips
unknown keys, and nothing reads them.

**Why this translation is faithful here, and would not have been on beta.** The 2026-07-29 spec
argued a stored `courseHandicap` had "nothing honest to translate into." That was true **of
beta**, which had run the intermediate relative-to-par model: some stored values were absolute
course handicaps and some were already hand-typed differences, and a reader could not tell which.
**Prod never received that arc.** Every `courseHandicap` on prod was written by the 2026-07-24
code, where it means one thing — that player's own stroke count on the card, which is exactly
what `strokes` means today. The mapping is exact, not a guess.

## 5. How long the arm stays

**Indefinitely.** It costs one optional field and a transform. It is not a migration window to be
closed later; it is the read path knowing its own history. Delete it only if prod's pre-arc rounds
are ever themselves deleted, which is not planned.

## 6. Gate

1. `pnpm validate` 0, `pnpm test:contract` green — with contract tests proving BOTH shapes parse
   and produce the same `strokes`, and that a shape carrying neither is still refused.
2. **A read-only verification against real prod data, before any deploy**: fetch prod's 3
   snapshots and its round-table events and parse them with the new schemas, reporting per-record
   pass/fail. No writes, no deletes. This is the step that proves the arm works on the actual
   bytes rather than on a fixture.
3. `deploy:prod` (lambda), then `publish:web:prod`.
4. Post-deploy, in a browser on `swng.golf`: open each of the 3 finished rounds and confirm the
   scorecard renders with the right strokes.
5. Run `rebuildProjections` and confirm it **completes** rather than stalling at page 1.

No wipe. No rebuild is *required* for correctness — step 5 is a check that the instrument works.
