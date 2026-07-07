# swng — Product Design Brief

You are designing the product for **swng**, a golf app. Using well-understood knowledge of how golf is
actually played, competed, and organized, design a **complete, coherent product**. Golf is a well-understood domain. Design the product from that
understanding, present the full design, making decisions, and I will react to it afterward.

## The situation

There is a working proof-of-concept: a phone-first web app that scores a single round of golf — create a
round, others join with a short code, everyone's strokes sync live across phones, running totals. It
works, but it is *just a digital scorecard*. There is also a set of design docs in `docs/` from a prior
session (`product-design.md`, `product-v1.md`, `backend-design.md`, `implementation-plan.md`,
`PUNCHLIST.md`). **Treat all of them as contaminated and for-reference-only.** They converged on "the
proof-of-concept, tidied up," and one even invented a fake "betting" pillar I never asked for.
Do not start from them and do not let them shape the product.

## Your job

Design what swng should **be** as a product — a golf app real golfers would love — grounded in how the
game is actually played, competed, and organized (rounds, groups, trips, leagues, clubs, competitions,
handicaps, the common games and formats, a golfer's playing life over a season). Be complete.
Produce a single, coherent product design I can react to.

## Avoid these failure modes (a prior attempt fell into all of them)

1. **Converging on the codebase.** The existing app, the punchlist, and the old docs are gravity wells;
   anything you produce will collapse into "the current scorecard, slightly better" unless you
   deliberately design from GOLF, not from what exists. This was the central failure — guard against it
   hardest.
2. **Describing the mechanism instead of the product.** "A phone app for keeping the scorecard" is a
   category, like calling Uber "an app for hailing a car." Design a real product with a point of view:
   what golfers can now do, why they'd love it, what it is that a scorecard is not.
3. **Timid or incoherent additions.** Don't bolt features onto a scorecard to seem ambitious (the prior
   agent bolted on "betting"). Design a coherent whole that reflects how golf actually works, not a pile
   of features.
4. **Restating the code as if it were design.** A design is a point of view about the product, not an
   inventory of what the proof-of-concept already does.

## How to work

- **One shot.** Design the whole product and present it. Do not run an iterative Q&A with me — I
  will react after seeing the complete design. Do not proceed to scoping or architecture until I have.
- **Design from golf.** Lean on well-understood domain knowledge of how the game is really played,
  competed, and organized. You do not need me to supply the vision; golf supplies it.
- **Be coherent.** I would rather react to something bold and complete than something small and safe. Take a clear point of view.
- **I am the arbiter.** You make the design calls confidently; I react, steers, and decides.
  The whole design is the thing I responds to — so make it whole.

## Deliverable

A single written product design: what swng is, who it's for, the core idea and point of view, the shape
of the product and its main capabilities, and what is deliberately in and out — coherent and concrete.
Then stop and let me react.
