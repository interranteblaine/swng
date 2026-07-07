# swng — Build Roadmap (product-first)

> How we get from the design to a product golfers actually use. Pairs with
> [`product-design.md`](./product-design.md) (the why — the north star this is judged against),
> [`backend-design.md`](./backend-design.md) (the target architecture), and
> [`engineering-conventions.md`](./engineering-conventions.md) (how code reads).
>
> This roadmap was rewritten after an adversarial review: the prior "infra-agnostic core first"
> sequence validated the *engine* before the *golfer* and scheduled first course-contact last — a
> POC plan in good-architecture clothes. This one inverts it.

---

## The principle: get on grass fast, then let real use pull the engine in

Every milestone below is **done when a golfer does something on a course** — not when a test passes or
the app runs locally. We put a thin, deployed, instrumented slice in a real foursome's hands within
weeks, measure what actually happens, and let real on-course usage pull the deep engine (the target
design) into existence in the order golfers demand — rather than building the engine first and hoping
they show up.

The target design (identity spine, store-facts-derive, scoring engine, offline model, seq/journal) is
**not discarded** — it was validated as product-grade. It gets built *into* the slice incrementally, as
each milestone earns it. AWS-grade infrastructure comes only once real usage justifies the scale;
because the target keeps infra behind ports, that's a swap, not a rewrite.

**On reuse (and the disposable-POC rule):** the POC already implements the core loop (create → code →
join → hole entry → live sync → totals). We run the first slice on it as a *deployed learning vehicle*
to reach real golfers now — we do **not** patch it into the target. Effort goes into the risky,
product-deciding surfaces (entry UX, offline, instrumentation), built to target standards; the POC
plumbing is scaffolding to be replaced when M-Backend lands.

```
M1 First round on a course ─▶ M2 The bet ─▶ M3 Identity that sticks ─▶ M4 Trust for money ─▶ M5 Backend to scale
   (deployed, instrumented,      (net + skins/     (rejoin, guest→        (card-lock,          (target arch,
    real foursome, real grass)    match + money)     register, history)    dispute, anti-abuse)  swap behind ports)
                                              Events / tournaments = deferred (outer ring)
```

---

## Milestones — each done when a golfer does something real

### M1 — "A real foursome finishes a round on a real course, and would do it again."

The whole product's beating heart, deployed and measured. Nothing here waits on the target backend.

**Build:**
- **Redesign on-course entry** as a first-class artifact — the current stepper is flagged inadequate
  "with four." Options to prototype and test on grass: grid-tap vs. big-number pad vs. stepper;
  one-phone-for-the-group vs. four-phone; glance-legibility in sunlight; one-handed reach. This is the
  surface the product says decides everything; it gets the most design attention, first.
- **Offline-tolerant entry** — a durable local write queue so scores persist with no signal and sync on
  reconnect. On-course reality, not a later milestone.
- **Instrumentation from line one** — activation funnel (round started → 4 holes entered → round
  finished on-course), sync-health, offline-flush success, and "did a joiner ever start their own
  round." Without this we cannot tell if we're fooling ourselves.
- Runs on the **existing backend** (the loop already works); we don't invest in that plumbing.

**Done when:** a real foursome plays a full round entering scores *on the course*, the card stays live
on four phones through a dead-signal stretch, and they say they'd use it over a pencil — and we have the
numbers to believe them.

### M2 — "A group settles their bet automatically."

The stated hook — "settling it automatically is a genuine reason to open the app over a pencil." This is
where the deep scoring engine earns its way in, pulled by real golfers wanting to play games.

**Build:** the scoring engine (net, Stableford, match, skins) with the review's fixes baked in from the
start — **hole-scoped formats** (`FormatConfig.holes: [from,to]`, so "back nine for skins" is
representable), **Nassau** as composed front/back/total matches, match-relative handicap allocation,
countback tiebreaks — plus the **money layer**: stake, per-hole/round value, net-owed-per-pair, and a
settle-up view. Progressive: declare or change a game mid-round, standings re-derive from the same
strokes.

**Done when:** a group plays a skins/Nassau round (including one declared on the 10th tee) and the app
tells them who owes whom, correctly, without anyone doing math.

### M3 — "Your golf follows you, and a guest becomes a member."

The retention + growth loop — the reason to sign in and come back.

**Build:** durable, user-bound identity so rejoin/rejoining "just works" (the identity spine); the
**guest→register nudge** as a designed moment (when/what/why), and the **share-the-scorecard** artifact
(the finished card is free distribution + an invite); history ("your golf accumulates"); and
**handicap-index-from-rounds** (score differentials, best-N) so the index *improves as you post* — an
engine, not an input field. Durable data starts here, so every persisted item carries **`schemaVersion`
with a read-time upcast path** — the last chance before we can never clean-cutover again.

**Done when:** a guest finishes a round, is nudged to save it, signs up, sees their history and a
forming handicap — and shares a card that pulls a new player into a round.

### M4 — "Money rounds are trustworthy."

Trust is a stated feature; competitive/money play needs integrity, not just correctness.

**Build:** a **finalize/lock** transition that freezes scores on completion; a lightweight
**dispute/adjust-with-trace** flow; the durable score-change audit for competitive rounds; and closing
the **join-abuse vector** — longer/expiring access codes, rate-limited join attempts, and a default
where a fresh joiner can't edit others' scores until vouched (decouple "joined by code" from "may edit
the group's card").

**Done when:** a paid-out round's scores can't be silently changed, a contested score has a resolution
path, and a stranger spraying access codes can't vandalize a live card.

### M5 — "The backend carries real load on real infrastructure."

Only now, pulled by real usage, does the target AWS architecture get built — because M1–M4 kept infra
behind ports, this is implementing interfaces, not rewriting logic.

**Build:** the target backend from `backend-design.md` — `Store` adapters (DynamoDB), Cognito identity
provider, API Gateway broadcast, the Streams sequencer (seq/journal/gap→refetch hardened by real
flaky-signal data from M1), the single `lambda` composition root, CDK infra, and the eslint
layer-boundary rules against the real package layout. The slice's simple backend is swapped out behind
the unchanged product surface.

**Done when:** the same product golfers already love runs on infrastructure that holds up, with the
observability to prove it.

---

## Explicitly deferred: Events / tournaments (the outer ring)

The review is right that the Event model is a thin seam and there's no live event leaderboard or
event-level delivery channel. That is **deliberately out of scope until a real league or club pulls for
it.** Events are the arc's outer ring; building tournament infrastructure before the round is validated
is the exact mistake this roadmap corrects. When it's earned, it gets its own plan: an event read-model
and an event-level live channel (not per-round fan-out), designed then — not stubbed now.

---

## What we react to

React to the *inversion*: golfer-outcome milestones, first course-contact in weeks, the deep engine
pulled in by real use, events deferred. If M1's slice scope is wrong, or the priority order after it
should differ (e.g. trust before the bet), redirect here. The next detailed, task-by-task plan is for
**M1** — the deployed on-course slice and its entry-UX redesign — since that's where the real product
risk lives and where we learn the most, fastest.
