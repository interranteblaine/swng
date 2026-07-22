# "Played together" renders a round the canonical way — course · date

> Status: **owner-approved design** (2026-07-22). Origin: an owner field report while reviewing
> the shipped crew surface — the crew page's "Played together" list renders each shared round as a
> bare `new Date(finalizedAt).toLocaleDateString()` ("7/12/2026"): uninformative (no course, no
> context) and off-idiom (a raw locale date; near midnight it can show the neighboring calendar
> day). Every other round list in the app renders the canonical `roundLabel` — "Casa Verde GC ·
> Sat, Jul 12". This makes "Played together" match. NOT part of the "Crew Seasons Are The Record"
> arc — that arc did not touch this section; this is a follow-up correction to a pre-existing gap
> introduced by the 2026-07-21 crew-scoreboard arc (`fde6378`).

## 1. The problem (binding)

`apps/web/src/crews/SeasonPanel.tsx` renders the "Played together" list (`standings.rounds`, the
DERIVED set of rounds ≥2 current members share) as, per row:

```tsx
<Link to={`/rounds/${round.roundId}`} …>{new Date(round.finalizedAt).toLocaleDateString()}</Link>
```

Two faults: (a) the row is only a date — it tells you nothing about *which* round; (b)
`toLocaleDateString` is the raw-locale render the app deliberately does not use for rounds (a
Friday-evening-Pacific round whose instant is 02:00 UTC Saturday reads "7/12/2026" instead of the
"Fri" the group recognizes — the exact artifact `roundLabel`'s module doc calls out).

## 2. The canonical representation (binding)

A round is designated everywhere by `apps/web/src/roundLabel.ts`'s `roundLabel(designation,
opts?)`: **"Casa Verde GC · Sat, Jul 12"** — course name + date, with the tee time appended ("·
7:58a") ONLY to disambiguate two rounds that share course AND day. It takes
`RoundDesignation { courseName: string; createdAt?: number }` and renders in the environment's
local zone by default (the product default — the viewer sees the day the group played). The home
Recent-rounds list is the reference implementation (`HomePage.tsx:217`):

```tsx
const label = roundLabel({ courseName: round.courseName, createdAt: round.createdAt }, { withTime: collidesOnDay(round) });
```

where `collidesOnDay` is computed across exactly the rounds being listed via the shared
`roundDayKey`. "Played together" will render identically: **whole-row link to `/rounds/:id`, label
= `roundLabel` with the same in-list collision rule, local zone.**

## 3. The data is already there — enrich the wire, no new lookup (binding)

`roundLabel` needs `{ courseName, createdAt? }` per round. The server's `getSeasonStandings.ts`
already reads, for each shared round, the exact `StoredLine`
(`= GolferRoundLine & { finalizedAtMs, createdAtMs? }`) it uses to get `finalizedAt` — and that
line already carries **`courseName`** (REQUIRED on `GolferRoundLine`) and **`createdAtMs`**
(optional). So the label needs no course-store lookup and no extra fetch — the two facts sit on the
line next to the `finalizedAt` already being read.

- **Wire** (`packages/contracts/src/crews.ts`): `SharedRoundView` grows from
  `{ roundId, finalizedAt }` to `{ roundId, finalizedAt, courseName, createdAt? }` —
  `courseName: z.string()` REQUIRED, `createdAt: z.number().int().optional()` (matching the
  golfer-record history line's own `createdAt?` optionality and the no-migration rule: a line
  written before `createdAtMs` existed simply renders as the bare course name, `roundLabel`'s own
  designed fallback). `finalizedAt` stays (it is the newest-first sort key and is always present).
- **Server** (`packages/application/src/crews/getSeasonStandings.ts`): the loop that records
  `finalizedByRound.set(roundId, line.finalizedAtMs)` from the first holder of each round also
  records that holder's `courseName` and `createdAtMs`; the `rounds` array carries all four fields.
  Any holder is authoritative — a round finalizes once, and its frozen course card / created-at are
  the same on every participant's line. Sort unchanged (newest-first by `finalizedAt`).
- **Web** (`apps/web/src/crews/SeasonPanel.tsx`): each `standings.rounds` row becomes a whole-row
  link to `/rounds/:round.roundId` whose text is
  `roundLabel({ courseName: round.courseName, createdAt: round.createdAt }, { withTime: collidesOnDay(round) })`,
  local zone. `toLocaleDateString` and the `finalizedAt`-as-display use are deleted from this file.

## 4. One canonical collision helper — extract, don't copy (binding)

The in-list collision rule (append the tee time iff a round's course+day key appears more than once
in the list) lives today as a LOCAL helper in `HomePage.tsx` (`dayKeyCounts` map + `collidesOnDay`,
lines 118–127). Rather than copy those ~8 lines into `SeasonPanel`, extract ONE shared helper into
`roundLabel.ts` and use it in both places:

```ts
// A predicate over a list: true for a designation that shares course+day with ANOTHER in the same
// list (so its roundLabel should render withTime to disambiguate). Local-zone by default, same as
// roundLabel/roundDayKey — pass timeZone to override. Designations with no createdAt never collide.
export const dayCollisionChecker = (
  rounds: readonly RoundDesignation[],
  opts?: { timeZone?: string },
): ((round: RoundDesignation) => boolean) => {
  const counts = new Map<string, number>();
  for (const round of rounds) {
    const key = roundDayKey(round, opts);
    if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (round) => {
    const key = roundDayKey(round, opts);
    return key !== undefined && (counts.get(key) ?? 0) > 1;
  };
};
```

`HomePage` replaces its inline map + `collidesOnDay` with `const collidesOnDay =
dayCollisionChecker(liveRounds ?? [])` (behavior byte-identical — the extracted logic is the same
code); `SeasonPanel` uses `const collidesOnDay = dayCollisionChecker(standings.rounds)`. This keeps
the canonical mechanism a single tested copy, on-culture with the repo's one-copy discipline. It is
presentation logic (dates, not golf results), so it is not governed by the ESLint compute fence.

## 5. Deploy & data (binding)

`courseName` is a new REQUIRED wire field on `SharedRoundView`, so a new bundle reading an old
lambda's response would fail to parse — **deploy LAMBDA-FIRST**, then `publish:web:beta`. No
migration and no wipe: everything is computed on read from `GolferRoundLine`s already stored
(`courseName` has been required on the line since before this arc; `createdAtMs` is tolerated-absent
by `createdAt?`). Old shared-round rows with no `createdAtMs` render as the bare course name.

## 6. Testing (binding)

- `apps/web/src/roundLabel.test.ts` — unit-test `dayCollisionChecker`: a two-round same-course-same-day
  list flags both; a different-course or different-day pair flags neither; a round with no
  `createdAt` never collides; local-zone default matches an explicit local `timeZone`.
- `apps/web/src/routes/HomePage.test.tsx` — its existing collision beats (the two-Walker-rounds
  withTime case + the different-day no-time case) must stay green through the extraction (proof the
  refactor is behavior-preserving).
- `apps/web/src/crews/SeasonPanel.test.tsx` — a populated "Played together" list renders each row's
  `roundLabel` (course · date), whole-row link to `/rounds/:id`; a same-course-same-day pair renders
  both withTime; a row with no `createdAt` renders the bare course name.
- `packages/contracts/src/crews.test.ts` — `sharedRoundViewSchema` round-trips the new
  `courseName`/`createdAt`; rejects a missing `courseName`; accepts an absent `createdAt`.
- `packages/application/src/crews/*Slice.test.ts` (or the existing `getSeasonStandings` coverage) —
  the standings response's `rounds[]` carries `courseName`/`createdAt` sourced from the member line.
- `apps/web/e2e/crewSeason.spec.ts` — the existing "Played together" beat (test 8, where Bo joins
  and the shared round materializes) is tightened to assert the row shows the shared round's COURSE
  NAME (`roundLabel` text), not merely that a row exists. Frozen-deck numbers unchanged (this adds
  no game/standings math).

## 7. Out of scope

- The `roundLabel` helper itself, `roundDayKey`, and the collision semantics — unchanged; this
  reuses them.
- Any other "Played together" content (scores, player lists) — a shared crew round has no single
  golfer's score, so the row is course · date only, matching the section's derived-fact nature. Not
  reusing the score-first `HistoryList` component (which is per-golfer).
- The crew standings/ledger folds, the season model, routes — untouched. This is a rendering +
  additive-wire change only.
