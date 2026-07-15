# Crew membership — invited in, accountable out

> Status: **approved** (owner, in-chat, 2026-07-14 — including the amendment: beta crew data
> is DELETED outright, no migrations, no tolerate machinery). Closes pre-prod hardening spec
> D3 (`2026-07-14-pre-prod-hardening-design.md`), the open question that blocks prod.

## The ruling

The flaw in today's model is **permanent capability + no removal**: a crew join code works
forever, and the only membership exit is `leaveCrew` (self). The fix is the membership model,
not the code mechanism: **you get in by accepting a member's invitation, you leave yourself,
or the organizer removes you.** The permanent join code dies.

## 1. The organizer role gets its authority

`CrewRole = "organizer" | "member"` has existed since M8 with the creator seated as organizer
— recorded then precisely so authority could land later without a migration. Now it lands:

- **Remove a member** — organizer only. Semantically identical to leave (membership is pure
  aggregation scope; standings rows vanish at the next read, counted rounds remain crew
  facts, a re-invite restores everything).
- **Transfer the role** — organizer only, target must be a member. Implementation is a role
  flip in the members array.
- **Invariant: a crew always has exactly one organizer.** The organizer cannot leave (new
  guard on `leaveCrew`, error `organizer-must-transfer`) and cannot be removed; transfer
  first.

Everything else stays egalitarian exactly as today: any member invites, creates seasons,
counts/uncounts rounds — matching the round layer's "any participant can finalize."

## 2. In: expiring invite links, minted by any member

- `POST /crews/{crewId}/invites` (golfer auth, member-gated): mints a stateless HMAC token —
  the SAME `TokenIssuer`/`hmacTokenIssuer` one-signer as participant and spectator tokens
  (M9's "never a parallel signer"), with a new claims variant
  `{ scope: "crew-invite", crewId, inviterGolferId, expiresAtMs }`. Returns
  `{ token, expiresAtMs }`; the web composes `/crews/join#<token>` from its own origin
  (shareRound's exact idiom). **Expiry: 7 days** — the weekly social cycle; bounds a leaked
  link with zero revocation infrastructure.
- **Union consequence, handled deliberately:** `TokenClaims`' doc invariant "every variant
  carries `roundId`" breaks with this variant. Every roundId-consuming verifier (wsConnect's
  subscribe gate; the dispatcher's participant/round-read tiers) must narrow on `scope` and
  REJECT a crew-invite token — it opens no round, no socket, nothing but a crew join.
- `POST /crews/peek` (auth `none`, body `{ token }`, joins the anonymous-route throttle set):
  the capability-scoped preview, mirroring `PeekRound` — returns crew name, member count, and
  the inviter's roster name, nothing else. The join page is a consent screen first: the crew
  name is visible BEFORE sign-in ("Join The Saturday Boys? · 8 members · invited by Al").
- `POST /crews/join` (golfer auth) keeps its path, body becomes `{ token }`: verify signature
  + expiry + **inviter is still a member** (a removed member's outstanding invites die with
  their membership — the crew document is already read to add the joiner, so the check is
  free; peek enforces it too, so the preview never over-promises). Already-a-member stays a
  no-op success, as joinCrewByCode had it. The caller joins as themselves — always.

## 3. Deletions

- **`joinCrewByCode` and the join code itself**: the `joinCode` store parameter and item
  attribute, the crew `gsi1` join-code partition and `findByJoinCode`, createCrew's
  `mintUniqueJoinCode` bounded-retry machinery and `join-code-exhausted`, `CrewView.joinCode`
  on the wire, and every join-code UI surface (CrewPage's code display, ProfilePage's
  join-by-code input — papercut 8's defensive alert arm dies with the form it guarded;
  CrewCreatePage is untouched).
- **`addCrewMember` (add an account golfer by id)**: post-wall this is a consent violation
  waiting to happen — the identity work made "the person joins as themselves" the one way
  onto a card, and crews match: nobody is conscripted; they accept an invite. One path in.
  Its route (`POST /crews/{crewId}/members`) goes with it.

## 4. Data: delete, don't migrate (owner amendment)

Beta crew data is test data. A one-time controller script deletes every crew item (root +
member items) from the core table; nothing tolerates a legacy `joinCode` attribute because
nothing will ever read one. No organizer-less-crew repair either — the invariant is enforced
going forward and pre-existing crews are gone. Prod starts clean.

## 5. Wire summary

Routes 34 → 37 HTTP (39 total): + mint-invite, + peek, + remove-member
(`DELETE /crews/{crewId}/members/{golferId}`), + transfer
(`POST /crews/{crewId}/transfer`), − add-member; `/crews/join` changes body in place.
`/crews/peek` joins the anonymous throttle set (8 → 9 routes at 5 rps/10 burst). Four-way
route lockstep (routes.ts, HTTP_ROUTES, routesParity, swngStack.test counts) moves twice
across the two backend tasks.

New error codes (mapped copy, never raw — M7 discipline): `crew-invite-expired`,
`crew-invite-invalid` (covers bad signature AND departed inviter), `organizer-must-transfer`,
`not-organizer`.

## 6. Deliberately not built

No approval queues or notifications (links travel out-of-band by text, like every share
surface here). No invite revocation list (expiry + inviter-still-member bounds exposure). No
multi-organizer. No audit log. No crew deletion (doesn't exist today, not added).

## Threat delta

Today: a leaked code admits strangers forever, no remedy. After: a leaked link works ≤7 days,
only while its named inviter remains a member, the consent screen shows who invited you, and
the organizer can remove any mistake.
