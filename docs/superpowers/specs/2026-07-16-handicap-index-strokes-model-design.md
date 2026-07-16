# The handicap model — one index you own, the strokes it becomes

- **Date:** 2026-07-16
- **Status:** Owner-driven design session (this document is the record). Written in plain
  language on purpose: it is the source of truth for how a golfer's handicap works in swng,
  end to end, and it must be understandable without the conversation that produced it.
- **Why this exists:** the unrated-courses arc (spec `2026-07-15-unrated-courses-handicap-
  model-design.md`) shipped a working handicap model that is **illegible**. Reviewing it, the
  system's own designer could not tell, from the screens, which number was "their handicap"
  or how it turned into strokes on a course. The math was fine; the *picture* was hidden. This
  document fixes the picture, and **supersedes the earlier spec's §2, §6, §7, and §8** (the
  handicap-model, suggested-index, precedence, and suggested-course-handicap sections). The
  unrated *plumbing* from that arc stays; the *model and its surfaces* are corrected here.

## 1. The one-sentence model

**A golfer owns exactly one number — their index (their ability). Every round, swng turns that
index into the strokes they get on that specific course.** Everything below is that sentence,
made precise.

## 2. The two numbers swng computes

Both are computed by swng from the rounds the golfer actually plays. They differ in *which
rounds* they use and *how*:

- **swng index** — computed from **all** the golfer's rounds, rated and unrated, scored by
  **result versus par** (adjusted gross score − par). It counts every round the golfer plays,
  at the cost of ignoring how hard each course is. *Complete, but difficulty-blind.*
  (This is the number the earlier spec called "suggested" — a name that told the golfer
  nothing. It is renamed **swng index** everywhere: it is swng's own number for you.)
- **WHS index** — computed from the golfer's **rated** rounds only, using the official World
  Handicap System formula, which adjusts for each course's difficulty (slope and rating). It
  is the accurate, official-rules number — but it is blind to unrated golf, because the rules
  cannot score a round played on an unrated course. *Accurate, but partial.*

They answer different questions: *"a fair number across all the golf I actually play"* (swng
index) versus *"my official handicap under the rules"* (WHS index).

## 3. Your index — one number, always visible, never hidden

The golfer sees and owns **one** number, labeled **"Your index."** It is never a value the
system picks off-screen.

- **By default it is your swng index** — the all-rounds number. So a golfer never has to do
  anything to have a working handicap: swng computes it and it updates as they play. (This is
  "you can always just use ours.")
- **Your WHS index sits beside it as a labeled reference**, with a one-tap **"Use this."**
  A golfer who wants the strict official number adopts it in one tap.
- **You can override** by typing your own number — your established GHIN/club index when you
  are brand-new to swng and have no rounds yet, or any time you know better. It then reads
  plainly as *your* number.
- **There is no hidden precedence.** "Your index" is always the value shown on the screen, and
  it always says where it came from — *computed from your rounds*, *WHS (you adopted it)*, or
  *your own*. The earlier build resolved a silent `declared ?? whs` behind a blank field; that
  is the exact illegibility this removes.

Your index is **identity-level and stable**: you set it (or leave it on the computed default)
on your **profile**. It is not a per-round thing.

Worked example — Blaine has played 8 rated rounds and a few unrated 9-holers:
- swng index (all rounds): **12.4** → this is his "Your index" by default.
- WHS index (rated only): **11.2** → shown as a reference, one tap to adopt.
- Override: empty (he hasn't typed his own).

## 4. Strokes — what your index becomes for one round

To actually play and compete, swng needs one number per player per round: **how many strokes
you get** on that course. That number is your index **converted for that specific course** —
it is called the *course handicap*, but the golfer should just see it as **strokes**.

- **Rated tee:** exact conversion — `round(index × slope/113 + (rating − par))`.
  Blaine's 12.4 on Casa Verde (slope 130, rating 71, par 72) → **13 strokes**.
- **Unrated tee:** there is no slope or rating, so swng **cannot** convert exactly. It falls
  back to the golfer's index itself, adjusted for the number of holes (a neutral course gives
  strokes ≈ index): 18 holes → `round(index)`; **9 holes → `round(index / 2)`**. Blaine's
  12.4 on his 9-holer → **~6 strokes**, offered honestly as an estimate.

Rules for the strokes number:
- **It is shown with its derivation, at the round (create/join): "13 — from your index (12.4)
  on this course."** The wire from profile-index to round-strokes is on the screen, not
  implied.
- **It is editable at the tee** — a golfer or group can agree on a different number ("I'll
  take 5 here," a course that plays brutal). That adjustment lives on *that round* only.
- **It never goes in the profile.** "5 strokes today" is a per-round, per-course fact entered
  at the round; the profile holds only the index. Stuffing a stroke count into the profile
  would be a category error.
- **It is frozen into the round** when you create/join — a fact of that day's play. Changing
  your profile index later never rewrites the strokes you already played off (the round is a
  sealed leaf).

## 5. Rated versus unrated — what changes, what doesn't

- **Where strokes fall never changes.** Every card, rated or not, carries a **stroke index**
  (holes ranked hardest to easiest). Your strokes drop on the hardest holes by that ranking.
  This is why dots, skins, and matches work identically on an unrated course — allocation
  never depended on slope/rating.
- **What changes is only the precision of the stroke *count*** (§4): exact on a rated tee, an
  index-based estimate on an unrated one.
- **Posting differs, honestly:** a rated round posts to your **WHS index**; an unrated round
  **does not** (true to the rules — no rating to post against) — but it still records an
  adjusted gross score and **feeds your swng index** and every stat. Unrated golf counts
  everywhere it honestly can; it simply cannot move the official number.

## 6. Why this connects to analytics — the point of it all

The handicap is not a standalone feature; it is the **normalizer that makes cross-player
analytics possible.** Every analytic worth building — "average score on this hole," "how
golfers *in my handicap band* play this hole," "how I did on this course over time" — needs
two things: the **raw per-hole facts** of each round, and a **way to compare players of
different abilities.** The index is that comparison key.

So the real payoff of the unrated arc is not the handicap screen — it is that **every round a
golfer plays, including the unrated muni, is now a normalized, comparable data point:** it
records per-hole scores, the course, and each player's index/strokes, and it counts toward
that index. Before, unrated golf was invisible — you couldn't even enter the course, and
faking a rating poisoned the handicap.

Concretely, once the aggregate projections exist: *"Hole 4 at your muni (unrated) — golfers
around your 11 index average 4.9; you average 5.4."* That is only possible because (a) the
unrated course is enterable, (b) the round stored per-hole scores and each player's index, and
(c) the index buckets players into comparable bands. Those three are exactly what the arc laid
down. Each future analytic is **its own projection** over the sealed snapshots (per this
codebase's projection discipline — see papercut 17), never hand-rolled in the web.

## 7. UX legibility rules (the through-line must be on the screen)

- **Profile:** exactly one labeled **"Your index"** (the active number), with its two sources
  shown as adoptable references — **swng index** ("from all your rounds") and **WHS index**
  ("rated rounds, official rules") — plus your **override**. Each says which is active. No
  blank "declared" box, no number the system uses that isn't on the screen.
- **Round (create/join):** the strokes box reads **"Strokes you get here — N, from your index
  (X) on this course,"** editable, in plain language. No "course handicap index" jargon to
  decode; the derivation is visible; the unrated case says out loud that it's an estimate.

## 8. API legibility rules (the contract must read like the model)

- **Rename "suggested" → "swng index"** across domain, contracts, and web. It was ambiguous to
  the designer; it will be ambiguous to any API consumer.
- **Expose the index with named sources and an explicit active value** — `swngIndex`,
  `whsIndex`, `declared` (override), and the resolved active number — rather than a value a
  client re-derives through a hidden `declared ?? whs` precedence.
- **The round's strokes field is clearly derived-but-settable** — its name and shape convey
  "course handicap for this round, defaulted from the index, overridable," not a bare number a
  caller must understand out of band.

## 9. What in the shipped arc changes to match this, and what stays

**Changes (legibility corrections):**
- Rename `suggested`/`suggestedIndex` → `swngIndex` (domain `golferMetrics`, contracts, web).
- "Your index" defaults to the **swng index** and is an explicit, on-screen active value; the
  client-side hidden `effectiveIndex = declared ?? whs` precedence is replaced by a visible
  selection (default swng index, adopt WHS, or override).
- Round create/join: the strokes box is a **data point with its derivation shown + editable**
  (not a silent pre-fill), the label drops the jargon, and the unrated estimate uses the
  **hole-count-correct** `round(index / 2)` for 9 holes (fixing the shipped `round(index)`).
- Profile: one "Your index" with its two named sources, replacing the blank declared box.

**Stays (already correct, do not touch):**
- Unrated courses enter, submit, and play; games/dots work from stroke index + course
  handicap.
- An unrated round posts an adjusted gross score and no differential, and cannot move the WHS
  index.
- `par` and `courseHandicap` are recorded on every round line (the facts analytics need).
- The sealed round/snapshot is untouched beyond the additive unrated case.

## 10. Out of scope (recorded, not designed here)

- The other analytics themselves (per-hole, per-course, handicap-band aggregates) — each is a
  future projection; the foundation is what this establishes (papercut 17).
- Whether a heavily-rated golfer's default should ever auto-prefer WHS over the swng index —
  not now; the one-tap "Use WHS" and the override cover it, and a hidden preference would
  reintroduce the illegibility this document exists to remove.
- SI-less cards (papercut 16's adjacent half) — unchanged.
