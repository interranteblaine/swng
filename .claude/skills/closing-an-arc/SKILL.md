---
name: closing-an-arc
description: Use when a swng development arc is code-complete and needs to ship to beta or prod — the close-out gate. Triggers include "close out the arc", "deploy this", "ship it to beta", "run the gate", finishing the last SDD task of a plan, or deciding deploy order between the lambdas and the web bundle.
---

# Closing a swng arc

## Overview

An arc is code-complete when every task has landed, each was independently reviewed, and a
whole-branch review returned READY TO DEPLOY. **Close-out is controller-run** — you run it
yourself, in order, and you do not declare a step passed you did not watch pass.

The gate exists because green pipelines faithfully verify wrong assumptions. Three things it
catches that nothing else does: a deploy ordered the wrong way, a stale bundle, and a product
that is correct in tests and wrong on a phone.

## The order

Do not reorder these. Each step's output is the next step's precondition.

1. **`pnpm validate`** — exit 0. Plus `pnpm test:contract` if any adapter changed.
2. **Decide the data question** (below) — wipe, migrate, or neither. If wipe or migrate, it
   happens **before** the deploy unless you can state why not.
3. **`pnpm cdk:diff`** — read every line. It must show *exactly* the delta you predicted and
   nothing else. A table, pool, secret, WAF or distribution change you did not intend is a stop.
4. **Deploy, in the order you derived** (below): `pnpm deploy:beta` / `pnpm deploy:prod`.
5. **Verify the deploy landed** — route count on the real API, the new route present, the retired
   route gone. Not the CloudFormation status alone.
6. **`pnpm publish:web:beta`** / `publish:web:prod`, then **verify the served bundle by content**,
   not by filename: `curl` the origin and grep for a marker only the new code contains.
7. **`pnpm e2e:beta` ×2** — twice, because a single green run does not distinguish a passing
   system from a flaky one.
8. **`pnpm e2e:field`** — the full Playwright suite. Reconcile any locator break before deciding
   it is a product bug; equally, do not "fix" a test that is correctly reporting a real defect.
9. **The adversarial USE pass** (below).
10. **Docs sweep** — see "What to write down".

## Deploy order is derived, never precedent

There is no default. Work it out from the wire delta, both directions:

- **Lambda-first** when the new web bundle sends a field the old lambda would reject or silently
  strip, or when the new lambda's response is additive (old bundles strip unknown keys — request
  schemas are non-strict unless marked `.strict()`).
- **Web-first** when the new lambda *requires* a field only the new bundle sends.
- **Both windows are red** when the wire both adds a required field and drops one. Say so, pick
  the shorter outage, and publish back-to-back.

The failure that matters is the *silent* one. A stripped field means the golfer picks "Front 9"
and gets eighteen with no error — always worse than a 400. State the reasoning in the arc's
record; "precedent" is not a reason.

## The data question

Three answers, and you must give one explicitly:

- **Neither** — the change is additive or compute-on-read. Most arcs.
- **Migrate** — the records are countable. Count them, migrate them, ship no compatibility code.
- **Wipe** — beta only, when stored data is genuinely ambiguous under the new model and there is
  nothing honest to translate.

**Prod is never wiped.** See the `beta-and-prod-data` skill for the instruments and their flags.

Order matters and it is not symmetric: if the arc made a read path *parse* what it used to cast,
or made a field required, a deploy-then-wipe window can 500 every existing round **and brick
`rebuildProjections`**, which is the instrument you would use to repair it.

## The adversarial USE pass

Drive the **deployed** surface as a first-time user at phone width. Not a smoke test — an attempt
to break the thing you just built.

- Replay the owner's original field report end to end, with real accounts through real sign-in.
- **Read screenshots as design artifacts**, not as proof the page rendered. Pixels are the point.
- Pick fixtures that can *falsify*: a scrambled stroke index so "the hardest ten" cannot be
  confused with "the first ten"; two arms of a rule side by side in one round so a collapse would
  be visible.
- Check the console. Zero app errors; know your pre-existing transients by name.
- Verify at least one claim **on the wire** (the stored log, the network panel), not just on screen.
- Delete throwaway Cognito users afterward. In prod, **create nothing sealed or unremovable.**

This pass has caught shipped defects that every test suite passed. Budget for it finding something.

## What to write down

- **`docs/arc-log.md`** — one entry, newest first: title, date, commit range, spec/plan links, and
  a short paragraph on what changed and *why it exists*. Not a close-out log. No bundle hashes,
  deploy timings, e2e counts or walk narration — those belong to the run, not the record.
- **A rule that outlived the arc** goes in `architecture.md`, `engineering-conventions.md` or
  `product.md` — the doc that owns it — not in the arc entry and never in `CLAUDE.md`.
- **An arc that deleted a model** gets `⚠ SUPERSEDED` on the entries it replaced, so nobody builds
  against a dead spec.
- **A papercut you found and did not fix** goes in `docs/papercuts.md`, stated in plain terms with
  a severity and a recommendation — never as cryptic shorthand.
- Then **check the docs against the code**, not against this arc's words. Docs describing deleted
  behaviour are found by reading them, not by grepping for the terms you happened to delete.
