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
| `archive.participants[]` (snapshots table) | `courseHandicap` | **parsed** | `stored-archive-invalid` — the finished scorecard refuses to render |
| `GolferRoundLine` (projections table) | `courseHandicap`, plus retired `ags`/`differential` | **cast** | no throw — `strokes` reads `undefined` behind a type that promises a number, so stats render wrong rather than erroring |

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
  .transform(({ courseHandicap, ...p }) => ({ ...p, strokes: p.strokes ?? courseHandicap ?? 0 }))
  .refine((p) => Number.isInteger(p.strokes));
```

Applied at all three sites in §2. The projection line gets the same normalisation where it is
read, which also removes one of the casts the 2026-07-30 arc left standing.

**Why this translation is faithful here, and would not have been on beta.** The 2026-07-29 spec
argued a stored `courseHandicap` had "nothing honest to translate into." That was true **of
beta**, which had run the intermediate relative-to-par model: some stored values were absolute
course handicaps and some were already hand-typed differences, and a reader could not tell which.
**Prod never received that arc.** Every `courseHandicap` on prod was written by the 2026-07-24
code, where it means one thing — that player's own stroke count on the card, which is exactly
what `strokes` means today. The mapping is exact, not a guess.

The retired `ags` and `differential` keys on prod's projection lines need no handling: zod strips
unknown keys, and nothing reads them.

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
