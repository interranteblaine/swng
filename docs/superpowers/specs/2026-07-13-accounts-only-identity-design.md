# Accounts-Only Identity — Design

**Status:** implemented (2026-07-14, commits `515baac..db6b5df` + the N-T7 close; owner approved in-chat 2026-07-13).
**Supersedes:** product.md's ghost/holdout pillar (§4 "no account required", §6 "Everyone plays, even the holdout"), the M7 claim flow and its M9 hardening, M7 Task 5b ghost continuity, papercut 8's recorded fix direction.
**Preserves:** the sealed leaf, the event log + commutative fold, settle-once, crews as groupings, members-only standings, delegated scoring (product.md §9), the read-only share link.

## 1. The ruling: the wall

Every person who appears in a round is a signed-in account. There are no ghosts, no
guests, no round-scoped placeholder identities, and therefore no claims — nothing exists
to claim. swng scores games between people who exist.

The costs are accepted knowingly:

- **The transitional Saturday.** A foursome where two players haven't signed up can't
  score its four-player games in-app until they do. Those side bets live on cardboard
  that week. The join link (§4) makes signing up a 30-second, one-time act.
- **The season-long holdout starts at zero.** Someone who spent a season as names on
  other people's cards gets no history when they finally sign up. Keeping history for
  the unsigned was precisely the machinery (claims, proofs, reuse, continuity) that
  generated this system's identity bugs and attack surface. It goes.

Why this is right for this product: everything swng claims to be — the rivalry, the
skins pot, the ledger, the head-to-head — is a relationship between identities. A ghost
was a fake party to a relationship, and every identity defect shipped to date traces to
maintaining that fake. The market is the persistent crew, which signs up once.

## 2. Identity: account = golfer, born together

- **Cognito is a pure authenticator** (owner amendment, 2026-07-13): it verifies the
  email and hands us a `sub` — no custom attributes, no name claim, no product data,
  stock sign-up form. The name lives only in the domain, where it is a display
  attribute, editable forever on the profile; nothing keys on it (GolferIds do).
- **Get-or-create returns, and is now sound.** M7's "GET /me never creates" rule existed
  because sign-in couldn't distinguish a new golfer from someone's claimable ghost.
  That ambiguity is dead: the first authenticated request that needs the caller's
  golfer mints it, with a **deterministic placeholder name derived from the sub**
  ("Golfer 4821" — boring by design, never cute; f(sub) so the concurrent-first-request
  race cannot even generate two names). The mint routes through the existing M9
  `SUB#<sub>` `attribute_not_exists` transaction: the race's loser re-reads and gets the
  winner's golfer. One golfer per account, always, with no Cognito trigger and no
  sign-up-flow failure mode.
- **The placeholder is the invariant's backstop, not the UX.** On first landing — for
  most people the join-link funnel — the app asks one required field, "What should the
  card call you?", which is simply a PUT of the name at the highest-motivation moment.
  Someone who deep-links around the prompt renders as the bland placeholder until they
  fix it on the profile; nothing anywhere blocks on it.
- Papercut 8 is resolved structurally: there is no moment in any flow where a person
  exists but cannot be shown on a roster, card, or ledger.

## 3. Round membership: self-join only

- **Nobody puts anyone on a card.** StartRound seats its creator only; the ghost-seeding
  `players[]` path and the round-setup "Add player" ghost form are deleted. JoinRound is
  always as-self from the caller's token; `JoinRoundRequest.golferId` and what remains of
  `resolveSuppliedGolfer` are deleted (as-self is all that exists).
- **The join link is the invite and the sign-up funnel.** One artifact per round. A
  signed-in tap joins; a signed-out tap routes through stock sign-up, then the funnel's
  one name prompt (§2), and lands on the card. There is no invite system, no pending
  state, no acknowledgment protocol.
- **Anonymous round creation and joining die.** The `optional-golfer` route tier's
  reason to exist goes with them; round create/join become `golfer` auth. The
  spectator/watch tier is untouched — the participation matrix is: on the card /
  watching via the read-only link / not in the system.
- **Delegated scoring is unchanged and is the point.** Any participant scores for any
  participant; "scorer" is not a role; finalize stays any-participant. John's only
  required action, ever, is his one join tap.

## 4. Leaving a round

- `participant-left` is an ordinary round event, appendable to any live round with no
  preconditions — no referenced-by-a-game gate, no dominance rules. The commutative fold
  absorbs races (a concurrent game-add referencing a departed player converges, in any
  arrival order, to "game exists, player departed, holes unscored" — a state the system
  already models). Rejoining is just joining again; same identity, no special case.
  After finalize nothing appends for anyone (sealed leaf, existing law).
- **Leaving stops the future and never rewrites the past.** Played holes are facts; the
  skins taken on 1–3 stay taken. Games resolve around an absence with machinery that
  already exists: remaining holes marked picked-up/conceded by any participant, or
  `game-terminated`, surfaced by the existing finalize-readiness dialog. Walking off a
  match is a concession, not an erasure — otherwise every losing Saturday ends with a
  "leave" on the 16th and the ledger never records a loss.
- **Settle decides once; readers never have policy.** `settleRound` writes the round's
  outcomes into the snapshot ("Al def. John", points, skins); the golfer history, index,
  crew ledger, and head-to-head are arithmetic over those stored results and cannot
  disagree. The index takes a partial round only per WHS's own minimum-holes rules — no
  leave-specific handicap case. One settle rule covers the empty case: a departed
  participant with no scored holes and no game membership settles out with no results,
  so they appear nowhere downstream — because there is nothing to aggregate, not because
  a reader filtered them.

## 5. Canonical round designation (derived, never stored)

A round is referred to everywhere as **course + date**, rendered one way: "Casa Verde GC
· Sat, Jul 12", with the tee time appended when two rounds share course and day ("·
7:58a"). A pure function of facts the round already records (frozen course card,
created-at); no name field, no tags, nothing stored. Used identically on the home list,
the archive page, and the join link's sign-up framing ("Ann added you to Casa Verde GC ·
Sat, Jul 12"). Today's rendering (bare course name — the home list showed two
indistinguishable "Walker" rounds) is replaced by this rule.

## 6. The between-holes digest is deleted (owner call, 2026-07-13)

The after-each-hole popup ("After hole N" with game deltas, or — solo with no games — a
literally empty card with a Dismiss button, reproduced live during the M-close
spot-walk) is removed entirely, not conditionally. Game standings remain available on
demand via the existing per-game chips and dots; the digest was a push-interruption for
pullable information. Its component, its multi-hole collapse logic, and its tests go.

## 7. Implementation surface

**Deleted:** the claim use case, claim proofs (`claim-proof-required`), all claim UI
("This is me", claim-carries-name); unclaimed-reuse and ghost continuity;
`resolveSuppliedGolfer`; StartRound `players[]` ghost seeding; the SetupPanel ghost
form; ghost lines in projections (only account golfers are projected); the
`optional-golfer` auth tier; the between-holes digest; the claim-dependent e2e stories
(`identityRecord`'s play-then-claim arc, `crewSeason`'s claim-Bo-inherits step) —
rewritten to accounts-only stories with equivalent coverage of what remains.

**Added:** deterministic golfer get-or-create on first touch (placeholder name f(sub),
via the existing `SUB#` transaction); the funnel's required "what should the card call
you?" name prompt; the join-link sign-up funnel flow; `participant-left`
(additive event kind, standard tolerate rules for old consumers) with leave/rejoin
affordances; the departed-participant settle rule; the designation rendering.

**Rewritten:** product.md §4 (add players by link; no account required → everyone signs
in once) and §6 (the holdout pillar becomes the one-tap-join promise);
architecture.md's identity/onboarding paragraphs; CLAUDE.md's record.

**Tolerated forever:** existing rounds, logs, and snapshots contain ghost golferIds that
never had and never will have accounts. Old data folds and renders exactly as before —
identity of record for those rounds is whatever the sealed leaf says. No stored-data
migration; beta's ghost-only projection lines are dropped in the same manner as prior
projection retirements (rebuild produces only account golfers; a one-time cleanup
deletes retired lines).

## 8. Out of scope

- Merging golfer histories (`GolferMerged`) — still out of v1, now with less reason to
  ever exist.
- In-app invite inboxes, pending-member states, notification delivery — the link in the
  group chat is the invite.
- Round naming/tagging beyond the derived designation.
- Any change to crews beyond what accounts-only implies (crews were already
  accounts-only groupings; standings already members-only, computed on read).
