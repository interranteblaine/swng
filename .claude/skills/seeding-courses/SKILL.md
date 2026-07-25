---
name: seeding-courses
description: Use when adding a real golf course to swng from a scorecard — creating a new course or adding/fixing tees on an existing one, on beta or prod. Triggers include a photographed/linked scorecard, "enter this course", "add the white tees", men's vs women's ratings, tee set / stroke index / course rating / slope entry.
---

# Seeding courses into swng

## Overview

Seeding a course is **transcribing a scorecard into immutable tee sets** through the public course API — the same wire the web app's "Add a course" uses. The whole job is: read the card exactly, model men's/women's correctly, write it **as the requester**, and prove it landed by checksum.

Core facts of the model (`packages/domain/src/course/course.ts`):
- A course is a **lineage of immutable cards**. `POST /courses` mints a new lineage (server generates `courseId`, `cardId`, one `teeId` per tee — the request must send **no** `teeId`). `PUT /courses/{courseId}` **supersedes** the current card to add/fix a tee.
- A tee set holds **exactly one** rating, one slope, and one stroke-index row. Cards are **sealed and permanent** — there is no delete; a correction is a new supersession.

**Use the tool in this folder — don't hand-roll curl.** `seed-course.mjs` validates locally against the domain rules, prints checksums, is **dry-run by default**, and preserves existing tees on a supersede (the #1 footgun). Run `node seed-course.mjs --help`-style by reading its header comment.

## The one rule people get wrong: men's vs women's

A scorecard prints men's AND women's course ratings, and often two different handicap (stroke-index) rows. A swng tee set holds only one of each. So:

- **A tee that prints BOTH a men's and a women's rating → TWO tee sets**, named `Foo (M)` and `Foo (W)`. They share yardages but differ in rating, slope, and stroke-index row.
- **A tee that prints one gender's rating → ONE tee set** (plain name is fine).
- **The stroke-index row follows the rating's gender**: a men's-rated tee uses the men's HCP row; a women's-rated tee uses the women's HCP row.

Do NOT collapse a dual-rated tee to one rating "to keep the list clean." That silently gives one gender the wrong course handicap **and dots on the wrong holes** — un-overridable per hole. Names must be unique within a card, which is why the `(M)`/`(W)` suffix is required.

Enter only the tees the requester asked for — skip tees they'll never play.

## Create vs. supersede

| Situation | Op | Key point |
|---|---|---|
| New course | `POST /courses` | Send NO `teeId`; server mints ids. |
| Add/fix a tee on an existing course | `PUT /courses/{courseId}` | Send the course name, `supersedes: <current cardId>`, and **every existing tee with its `teeId`** plus the new one. A tee you omit is DROPPED. A stale `cardId` → `409 card-superseded` (re-GET and retry). |

The tool handles both: give a spec with `courseId` present for supersede (it re-GETs and preserves existing tees for you), absent for create.

## Attribution is a hard rule — write as the requester

`enteredBy` is derived from the auth token and **frozen** into the card. So the write MUST use the requester's own Cognito ID token — **never a throwaway account** (that stamps a "Golfer NNNN" you'd then orphan on a real course). Get it from the signed-in app:

```js
JSON.parse(localStorage.getItem('swng:auth')).idToken   // devtools console at swng.golf
```

`export SWNG_TOKEN=<that>`. Tokens expire in ~1h — grab it fresh right before `--send`. Prod has no scripted-login path, so you cannot mint a token for the user; they hand you one (or do the write themselves in the UI).

## Transcription discipline — the numbers must be real and must add up

- **Read the actual scorecard** (photo / printed card / official rating cert). Do NOT trust a webpage summarizer's table — `WebFetch`'s PDF/table summarizer fabricates numbers. If the club site prints one rating column per tee, the other gender's rating may still exist on the USGA/GHIN cert; say so rather than inventing it.
- **Checksum every tee before sending**: front-9 + back-9 yardage must equal the card's printed OUT / IN / TOTAL, and pars must sum to the printed par. This is what catches a digit typo (e.g. 574→527). The tool prints these sums; compare them to the card by eye.
- Stroke index must be a **permutation of 1..N per tee** (the tool checks this).

## Workflow

1. Read the card. Decide create vs supersede. Apply the men's/women's rule.
2. Write a spec JSON (see `seed-course.mjs` header). Run it **dry** (no `--send`): read the checksum table against the printed card, eyeball the body.
3. Get the requester's `idToken`; `export SWNG_TOKEN=...`; run with `--send`.
4. The tool reads the card back and reprints checksums + minted `teeId`s. Confirm the totals and that existing tees survived (on a supersede). Give the requester the `/courses/{courseId}` URL.

## Common mistakes

| Mistake | Reality |
|---|---|
| "One tee, store the men's rating, keep the list clean" | A dual-rated tee is TWO tee sets `(M)`/`(W)`. Collapsing it gives one gender wrong strokes + dots on wrong holes. |
| Supersede sending only the new tee | Omitted tees are DROPPED. Echo every existing tee with its `teeId` (the tool does this). |
| Writing under a throwaway/test account | `enteredBy` is frozen and visible. Write as the requester's token, or have them do it. |
| Trusting a webpage/PDF summarizer's numbers | Summarizers fabricate table values. Use the raw card; checksum against OUT/IN/TOTAL. |
| "It's fine, I'll fix it later" | Cards are sealed — a fix is a whole supersession, not an edit. Verify before `--send`. |
| Sending a `teeId` on `POST /courses` | Create mints ids; the schema is `.strict()` and rejects a `teeId`. |
