---
name: beta-and-prod-data
description: Use when a swng change touches stored data on a deployed stage — wiping beta, migrating records, rebuilding projections, or deciding whether old stored shapes should be tolerated, migrated or scrapped. Triggers include "wipe beta", "migrate the rounds", "rebuild projections", a schema rename on a stored event, or any script under scripts/ that writes to DynamoDB.
---

# swng stage data

## The one law

**Beta round data is disposable. Prod data is never wiped.**

Prod holds real golf played by real people. Every act against it is read-only until proven
otherwise, is exported first, and touches only the records it names. There is no "clean slate"
option in prod — that is what makes the migrate-vs-tolerate decision (see
`engineering-conventions.md` §4) a real decision rather than a preference.

## Choosing

- **Tolerate** — the affected records are unbounded or unknown. Costs a permanent branch on a
  read path, often one the *client* parses on every event forever. Right for a stray legacy
  attribute nobody can enumerate.
- **Migrate** — the records are countable. Count them first, then migrate them, and ship **zero**
  lines of compatibility code. 15 records do not justify a forever-branch.
- **Scrap (beta only)** — the stored shape is genuinely ambiguous under the new model and there is
  nothing honest to translate.

The gate is derived from **reading the old data**, never from reading the change that broke it.
Rehearse the transform against live records before writing either the spec or the script — that
rehearsal is what finds the field or event kind the spec forgot.

## The instruments

All live in `scripts/`. **Read each script's header comment before running it** — the headers are
the authority on flags and are kept current; this list is only a map.

| Script | What it does |
|---|---|
| `scrapCourseAndRoundData.mjs` | Beta wipe. **Refuses to run without an explicit course choice** — exactly one of `--keep-courses` / `--wipe-courses`, exiting 1 and touching nothing otherwise. Composes with `--dry-run`. |
| `migrateRoundPlayedAt.mjs` / `roundPlayedAtMigration.mjs` | The played-date migration: I/O half and pure half. `--write` is refused unless you name a side of the deploy. |
| `migrateProdStrokes.mjs` / `prodStrokesMigration.mjs` | The strokes rename migration, same split. |
| `checkProdParses.mjs` | Total gate: parses every item in the in-scope tables, non-zero exit on any failure. |
| `publishWeb.mjs` | Builds and publishes the SPA (`pnpm publish:web:beta` / `:prod`). |
| `dropCrewData.mjs`, `dropOldProjectionItems.mjs`, `dropIndexProjectionItems.mjs`, `dropGhostProjectionLines.mjs`, `migrateSnapshots.mjs` | One-time instruments from past arcs, kept for provenance. |

Two conventions these scripts share, and any new one must:

1. **Split pure from I/O.** The transform is a separate, tested module, so the thing that mutates
   a stage and the thing that verifies it cannot drift.
2. **Make the ordering an assertion, not a memory.** A migration that must run before a deploy
   requires a `--before-deploy` flag. An operator who has to remember will eventually not, and an
   idempotent migration run in the wrong order reports something indistinguishable from success.

Every one of them should be idempotent (guard each rule on the old shape being present), so an
interrupted run is just a shorter next run.

## Projections

Projections are derived and rebuildable by construction. The snapshots-table stream is the
projector's only source, and `putLine` is a whole-item upsert keyed by `roundId` — so
**overwriting a snapshot re-derives its lines** through the same `projectArchive` a real finalize
uses, and retired keys vanish on their own. Migrating the projection rows directly is usually the
wrong move.

`rebuildProjections` is a **paged, cursor-resumable backfill** (`{cursor?, maxSnapshots?}` in,
`{processed, cursor?}` out). It is the **re-drive after a poisoned record**, not a routine repair
step — do not run it reflexively at close-out. Note it parses eagerly, so it is disabled by
exactly the data it would be used to fix: if an arc makes a read path parse what it used to cast,
migrate or wipe **before** deploying.

## Before any write to a deployed stage

1. Dry run, and read the counts.
2. Export the affected tables (prod: always — and `prod-backup-*.json` is gitignored, because the
   export is a verbatim dump of real people's names and Cognito subs; never commit one, and move
   it out of the repo when you are done).
3. Parse each transformed record **before** writing it.
4. Re-count every table afterward against the pre-run inventory, and verify the tables you meant
   to leave alone are byte-unchanged.
