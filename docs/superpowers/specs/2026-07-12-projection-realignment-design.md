# The round is a sealed fact; everything else points at it — architecture correction

> **Status:** product/architecture correction (target model + the drift it corrects). Surfaced
> 2026-07-12 by questioning what a "crew" is; sharpened into a single dependency rule. This is
> the principle three implementation threads will serve — captured now, scheduled separately.

## The one rule

**A round is a sealed leaf. Everything points *at* it; it points at nothing.**

- A **round** records only **facts about that round** — the course card frozen in at creation,
  who played (golferIds + the name/handicap frozen at join), the games, the scores, when it
  finalized. It has **no** field, tag, or reference to a golfer's summary, a crew, or a season.
  It does not know who counts it. It is identified by a `roundId` and is otherwise self-contained.
- **Finalize seals it** into an immutable snapshot (`RoundArchive`). Nothing edits it after.
- **Every derived thing references rounds inbound, by `roundId`** — a golfer's history, the list
  of rounds a golfer has played, a crew-season's standings. The reference is always
  *outside → round*, never *round → outside*.

```
   golfer summary (index/history) ──┐
   my-rounds list  (auto-derived)  ─┤                     ┌───────────────────────────┐
   crew-season     (curated list)  ─┼──  inbound, by id  ─► ROUND — sealed facts only  │
                                     │                     │ frozen card · players ·   │
                                     │                     │ games · scores · final    │
                                     │                     │ (references NOTHING out)  │
                                     └─────────────────────►                          │
                                                           └───────────────────────────┘
```

**The anti-drift test:** if a round (or its `round-created` event) points outward at a golfer
summary, a crew, or a season, that is the drift. It has happened three times (below); each fix
is the same inversion — move the reference to the thing that owns it, pointing back at the round
by id.

## The snapshot is the atom

The finalized snapshot is the unit everything aggregates from. It is already persisted
(`settleRound` → `RoundArchive` → `putArchive`) and everything is **rebuildable** by replaying
snapshots (`rebuildProjections`). The snapshot must become **first-class**: listable and
individually viewable — at both the user level and the crew level. Today it is only reachable as
summary *lines* (`GET /me/record`) or through a share/watch link; there is no "my rounds → open
this one" and no "the crew's counted rounds → open this one." That absence is the core modelling
gap, and per the product it was fundamental, not optional.

One atom, aggregated up **two independent axes**:

- **Player** → *every* snapshot a golfer played feeds their global index/history. (Correct today
  — `projectArchive.ts:49-64`, ungated, keyed by golferId. This is the model done right; make
  everything else match it.)
- **Crew-season** → the snapshots *selected* for it feed the crew's standings/head-to-head **and**
  each member's standing within that crew-season.

The player's *global* summary is all their snapshots; a crew-season is a *subset lens*. There is
no path where a crew-season feeds a golfer's global summary — those are separate scopes over the
same atom.

## The two lists (both inbound references, one auto, one curated)

- **User → their rounds** — a projection that *reads* snapshots by participant golferId. You
  played it, so it's listed. Auto-derived. The round is never told it's in your list. → `list my
  finalized rounds`, `open one snapshot`.
- **Crew-season → its rounds** — a list of `roundId`s the **crew-season owns**. On the crew page,
  a member **appends a `roundId`** ("count my Saturday round"). That write touches the
  *crew-season's list only* — the round is never opened, modified, or tagged. Explicitly curated,
  not auto-derived (your solo range round doesn't count unless you append it). → `list the crew's
  counted rounds`, `open one snapshot`.

Both lists hold the reference **outside** the round. Neither writes anything onto the round.

## Season

A season is a **grouping a crew defines** — a named competition/period ("2026", "Summer Cup"),
the container a standing aggregates over. A crew may have one perpetual season or several. A
snapshot enters a crew-season only by the append above. Season is **not** a calendar year
auto-derived in the projector (today: `getUTCFullYear`, `projectArchive.ts:10`), and it is
**never** an attribute of a round. It lives entirely on the crew side.

## Crew

- **A crew is a list of real accounts.** Ghosts are **not** crew members. Ghosts exist only as
  unclaimed participants *inside a round* — onboarding is: play as a ghost → get a code → claim
  in-round → become an account → then, optionally, be added to a crew. This removes the
  ghost/seating/token complexity that was leaking into crews.
- **Join** — a real account by code or invite (today: `joinCrewByCode` / `addCrewMember`; drop
  the add-a-ghost path).
- **Leave** — a member drops off the roster. **Does not exist today** (no such use case — a real
  gap). What already counted stays in the historical record (rebuildable); the member simply
  stops being eligible to append to open seasons.
- **See all your crew-seasons** — a projection across the crews you belong to.

## Scrapping a round

There is **no scrap/abandon today** — a round goes created → live → finalized (with
`round-reopened` to un-finalize) and has no discard path, so an abandoned round lives forever or
gets finalized as garbage. Scrapping must be a first-class terminal — a **`round-abandoned`**
event that ends the round with **no snapshot**, so it aggregates nowhere and drops off the
current-rounds list. It is emphatically **not** "mark every hole picked-up and finalize" — that
seals a real snapshot that would then count.

## The three drifts this corrects (each: a round pointing outward)

1. **Competition welded to the round's `crewId`.** `round-created` carries `crewId`
   (`{roundId, card, crewId?}`); `projectArchive.ts:72` gates the crew ledger on it and
   aggregates that one round's participants; head-to-head rides the same gate (`H2H#crew#a#b`).
   → Consequence: two members who play separate rounds never share a standing; your all-time
   record vs. Dave can't exist unless every shared round carried the same tag. → **Fix:** drop
   `crewId` from the round; a crew-season owns a curated list of `roundId`s; the standing is the
   aggregate of those snapshots.
2. **Live-round discovery welded to the device.** Home's "Your rounds" (`HomePage.tsx:13`) reads
   `credentialStore` — rounds this *device* holds a token for. → You can't see your live round on
   a new phone; a *seated* player (`startRound.ts:96-100`) has no credential at all. And it's the
   wrong list: home should show your **current (live) rounds** by identity; finalized rounds are
   history. → **Fix:** a `golfer → current rounds` projection keyed by identity.
3. **Scoring capability welded to the join-call artifact.** A participant token is minted only at
   `startRound.ts:114` / `joinRound.ts:71` and kept on the device; there is no "give me a token
   because I'm signed in and already a participant." → Fresh device or seated player → can't
   score. → **Fix:** an identity-gated token re-mint (as-self via Cognito sub), deriving the
   capability from participation rather than the device artifact.

## Intentional couplings to keep (do NOT over-correct)

These are *values frozen into the round*, not outbound references — consistent with the rule:

- **The round embeds a frozen `CourseCard`** (a copy, not a live link) so a later course edit
  can't rewrite settled history.
- **`courseHandicap` frozen at join** — you play at the handicap you started with.
- **The index snapshot (`putIndex`)** — a rebuildable read cache, never a source of truth.
- **`tabDeviceId` in `sessionStorage`** — a sync-correctness id, not a domain coupling.

## What doesn't exist today (net-new, not just re-keying)

- A first-class **snapshot view** (open one finalized round) and **`list my rounds`** — user level.
- **Crew-season as a curated list of `roundId`s** + the **append-round-on-the-crew-page** action,
  and **`list the crew's counted rounds`**.
- **Leave a crew.**
- **Scrap/abandon a round** (`round-abandoned`, no snapshot).

## Open decisions (resolve when each thread is planned)

- Season model: how a crew names/opens/closes a season; whether an appended round can be pulled
  back; who may append (the player only, any member).
- Leave-crew semantics: confirm past counts stay, future eligibility stops.
- `crewId` removal: confirm nothing non-drift depends on it, then a rebuild backfills corrected
  projections from existing snapshots.
- Current-rounds projection: exactly what "current" means (created, not finalized, not abandoned).

## Scope & docs

Three independent threads — **competition (crew-season as inbound curated list)**, **live-round
discovery**, **identity-derived scoring capability** — plus the layer corrections (de-ghost
crews, de-season/de-crew the round, add abandon). Each is its own spec → plan → build.
**`docs/architecture.md` §143–144, 198 currently encode the crew-owns-round weld and the
calendar-year season; they are corrected as part of this realignment.**
