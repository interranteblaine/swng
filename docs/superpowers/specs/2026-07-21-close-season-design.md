# Close a season — the organizer's verb that makes titles real

> **SUPERSEDED (2026-07-22) by `2026-07-22-crew-seasons-are-the-record-design.md`.** The owner
> rejected crowning root and branch: a crew season is a *tracking window*, not a competition that
> anoints a champion. So this entire arc — close/reopen verbs, `CrewSeason.status`, `closedAtMs`,
> and the Stableford `title` — is DELETED. A season now carries two chosen, required, visible dates;
> **time is its only state** (Live while today's UTC date ≤ `endsAt`, Final after — derived on read,
> nothing stored), and *editing the end date* is the whole lifecycle. Read the successor spec, not
> this one, for the current model. Retained here only as the design record of the crowning path swng
> chose not to keep.

> Status: **controller-ruled design** (2026-07-21, executing the owner's standing directive
> to carry judgment; follows directly from the analytics arc, whose Stableford titles
> consume `CrewSeason.status: "closed"` — a field that is load-bearing on the counted-round
> mutation paths but that nothing can set). The analytics arc's crewSeason test 9 pins
> `titles: []` with the comment "no close-season route exists"; this arc retires that
> reason.

## 1. The model (binding)

1. **Closedness already exists; only the setter is missing.** `CrewSeason.status:
   "open" | "closed"` is a real stored field; `appendCountedRound`/`removeCountedRound`
   already 409 on a closed season; `getCrewRecords` already awards titles from closed
   seasons only. This arc adds the two verbs that flip it — nothing else about the model
   changes, and no stored shape changes.
2. **Organizer-only, verb routes.** Closing a season is a crew-governance act, exactly the
   class the organizer already holds (remove, transfer). Two routes in the
   transfer/leave idiom:
   - `POST /crews/{crewId}/seasons/{seasonId}/close`
   - `POST /crews/{crewId}/seasons/{seasonId}/reopen`
   Both auth `golfer`, organizer-required (the existing organizer guard + its existing
   error code), NOT anon-throttled. Empty request bodies; each returns the updated season
   view the season list already uses.
3. **Reopen is first-class, not an apology.** A system you can correct is more trustworthy
   than one you can't (the declared-index ruling). Reopening un-awards nothing durable —
   titles are computed on read from `status`, so they simply stop/resume appearing.
   Nothing is stored about a title, ever (the analytics arc's own law).
4. **Explicit conflicts, wire-distinct:** closing a closed season → 409
   `season-already-closed`; reopening an open one → 409 `season-not-closed` (the
   tee-set-revised/card-superseded precedent — a stale client learns the truth, never a
   silent no-op).

## 2. Web

- The season panel (organizer only) gets **Close season** — `btnQuiet` (never gold; the
  panel's existing primary actions keep the screen's one gold) — with one teaching line
  shown beside the confirm: *"Closing locks this season's counted rounds and awards its
  titles — you can reopen it later."* A closed season shows a `closed` badge (the existing
  `badge` idiom) and **Reopen** in place of Close.
- On a closed season the count-a-round affordance is not offered (the server already 409s;
  the UI simply doesn't show a door the server has closed — the standing UI law).
- Non-organizer members see the badge, no verbs.
- Errors render the honest-fallback idiom, never raw codes.

## 3. Out of scope (recorded)

- Auto-close by calendar: rejected by standing law — seasons are named things, "never a
  calendar computation" (architecture.md; the realignment deleted `seasonOf =
  getUTCFullYear`).
- Any stored title/award record: titles remain a read fold, permanently.
- Deleting a season, renaming a season: separate asks, not raised.

## 4. Testing

- Application slice: close → titles appear in `getCrewRecords`; reopen → they vanish;
  organizer-required on both verbs; both 409 arms; append-into-closed still 409s (existing
  guard, now reachable end-to-end).
- Web: organizer sees Close/Reopen + badge + teaching line; non-organizer sees badge only;
  closed season offers no count affordance.
- E2E (`crewSeason.spec.ts`): the analytics arc's test 9 `titles: []` pin is UPDATED —
  its own comment declared it provisional on exactly this arc — to: close the frozen
  deck's season over the API, assert the title(s) hand-derived from the FROZEN deck's
  roster-filtered Stableford ledger, reopen, assert `[]` again. The deck's numbers stay
  byte-identical; only the provisional assertion its comment promised to retire changes.
