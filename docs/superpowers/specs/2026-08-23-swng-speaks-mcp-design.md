# swng speaks MCP

> Status: **proposed** (2026-08-23; revised 2026-08-24 after two adversarial reviews and an
> owner call that the refactor comes first — §1.1).
>
> **Phase 1 — the refactor, no MCP in it:** golf presentation moves out of `apps/web` into
> `@swng/domain/scoring/present.ts`; `foldAndScore` moves out of `@swng/client` into
> `@swng/domain`; one shared compute fence replaces the per-consumer ones; `GET
> /rounds/{roundId}/view` serves a folded round; the dispatcher is decoupled from API Gateway.
> Every item stands on its own with the MCP arc cancelled.
>
> **Phase 2 — MCP:** `packages/lambda/src/mcp/`, two Lambda entries, a second verifier in
> `@swng/adapters-cognito`, `apps/infra-cdk`, a Playwright gate.
>
> **No new golf rule anywhere.** Everything Phase 1 touches is a move. No migration, no wipe, no
> new event type.
>
> **BETA ONLY — no prod deploy in this arc** (owner call, 2026-08-23). `swng-prod` keeps serving
> its current build and is not touched: the `mcp` stack prop stays absent for prod, so prod
> synthesizes byte-identical to today.
>
> The Cognito behaviour this design rests on was **measured against the beta pool on 2026-08-23**
> — §4.2 records the method and the controls, including one place measurement and documentation
> disagree. The spike created a throwaway app client, two resource servers and one user, and
> deleted all three; beta ended as it started.

## 1. What this is

An MCP server lets an agent read and write swng on a golfer's behalf. "How did I play this year?"
"Who's up in the Saturday crew?" "Put me down for a 5 on 7." swng already holds every answer.

The guiding constraint is that **this arc adds no golf rule**. It adds a second doorway onto
use-cases that already exist, plus the OAuth machinery that lets a stranger's agent walk through
it as a specific, consenting golfer.

## 1.1 The refactor comes first (owner call, 2026-08-24)

**The first step of MCP is not MCP.** This codebase was built on one intent — everything behind
the API, golf logic in one tested copy — and a second consumer is the thing that reveals where
that intent has drifted. Building the second consumer *on top of* the drift is how a ball of mud
starts: the MCP layer would hand-write its own copy of whatever the browser happens to hold.

So Phase 1 of this arc contains **no MCP at all**. It is the refactor, and every item in it is
justified without MCP — the test each one has to pass is *"would this still be worth doing if the
MCP arc were cancelled tomorrow?"*

### What actually drifted

The golf **math** did not drift. `apps/web/src/round/dots.ts` and `finalizeReadiness.ts` carry
comments recording that their hand-mirrored arithmetic was already deleted in favour of
`@swng/domain`. That work was done.

What drifted is the **golf presentation vocabulary — how a golf fact is said in words** — and it
drifted in the least visible way: it is *half* in the right place. `packages/domain/src/scoring/
present.ts` already exists and already owns `gameKindLabel`, `gameKindBlurb`, `gameKindFits`,
`holeSelectionLabel`, `gameTreatment`, `strokesNote`, `underPar`, `formatOverPar`,
`formatScoreVsPar`. Three more functions of exactly that character live in `apps/web/src`
instead, every one React-free:

| Today | What it is | Imports |
|---|---|---|
| `apps/web/src/games/describeGame.ts` | how a game is named and described — the other half of `gameKindLabel`'s job | `@swng/domain` only |
| `apps/web/src/roundLabel.ts` | how a round is named, and how same-day rounds are disambiguated | nothing |
| `apps/web/src/round/finalizeReadiness.ts` | "holes 2–4 unscored for Pat", over the domain's structured `unresolvedGames` | `@swng/client` + `@swng/domain` |

**A fourth is not presentation, and the distinction matters.**
`apps/web/src/round/dots.ts` → `strokesSummary` reads as prose ("Pat 5 dots · Alex 1 dot"), but it
takes a `CourseCard` and *runs the stroke allocation* to produce those numbers. `present.ts`'s own
doc comment draws the line and explains why the module is fence-exempt: *"Pure formatters — no
golf RESULT is computed here, which is why the web may import them directly"* — and it explicitly
contrasts `gameTreatment`'s comparison of stored roster numbers against *"a second copy of
gameStrokeAllocation's per-hole placement rule, which is the only thing that needs a CourseCard."*
`strokesSummary` needs a CourseCard.

So moving it into `present.ts` would break that module's stated invariant and silently un-fence
on-device allocation for the web, inside a commit labelled a pure move. Instead it **splits**: the
sentence — a formatter over an already-computed `[{ name, dots }]` list — goes to `present.ts`; the
allocation stays where allocation lives, reached by each runtime through its own sanctioned seam.
That split is the general rule this arc establishes: **compute-then-format is compute.**

A second drift of the same kind sits one layer over: **`foldAndScore` and `KNOWN_GAME_KINDS` live
in `@swng/client`**, so the only code that can safely fold a round is code running in a browser —
`scoreGame` throws on a game kind it doesn't recognize, and the guard against that is in the
client package.

And a third, at the API surface itself: **no route returns a folded round.** `/archive` and
`/events` return event logs, and every caller folds them. That is fine when the only caller is a
phone that must fold offline anyway; it means "everything behind the API" is not actually true of
the single most important read in the product.

### The corrected shape

- `@swng/domain` owns golf math **and golf language**. `present.ts` is already the declared home;
  the four strays move into it.
- The compute guard (`foldAndScore`, `KNOWN_GAME_KINDS`) moves down beside the `scoreGame` it
  guards, so both runtimes fold through one tested copy.
- **One fence, shared by every consumer.** The web's compute fence is an `importNames` banlist on
  `@swng/domain` — compute banned, presentation allowed. Every non-domain consumer gets that same
  banlist rather than inventing its own rule. An earlier draft of this spec gave the MCP layer a
  blanket "may not import `@swng/domain`", which would have forced it to re-write the very
  vocabulary Phase 1 exists to share.
- The API serves the folded round (§5.1), so the browser is no longer the only thing that can
  answer "how is this round going".
- The dispatcher is transport-agnostic, so a second delivery adapter consumes the same core
  instead of a look-alike beside it (§3.1).

**Then** MCP is what it claimed to be in the first place: a thin doorway that renders, and writes
almost no golf language of its own.

## 2. The protocol moved, in our favour

The current revision is [`2026-07-28`](https://modelcontextprotocol.io/specification/2026-07-28),
and it deleted precisely what made serverless MCP a fight: no `initialize` handshake (version and
capabilities ride in each request's `_meta`), no `Mcp-Session-Id`, no GET stream, no
`Last-Event-ID` resumability, and no server-initiated requests (sampling and elicitation come back
in-band as an `InputRequiredResult` the client retries against).

What remains: **one endpoint, POST only, one JSON response per request.** A server that declines
the single long-lived stream that survives (`subscriptions/listen`) never holds a connection open.
That is the shape API Gateway + Lambda already has — no Function URL, no response streaming, no
session store, no sticky routing. We decline `subscriptions/listen` and declare `tools` with
`listChanged: false`.

`@modelcontextprotocol/server@2.0.0` implements what the revision demands of us: `server/discover`;
`MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` validated against the body (`-32020` on drift);
`resultType` on every result; `ttlMs` + `cacheScope` on list results; `404` + `-32601` for unknown
methods; `UnsupportedProtocolVersionError`. Its `createMcpHandler(factory)` defaults to
`legacy: 'stateless'`, serving 2025-era clients per-request through the same endpoint. **We keep
that default** — Claude today speaks 2025-era MCP, and one endpoint serves both eras sessionlessly.

The SDK is **web-standard**: handlers are `(Request) => Promise<Response>`. Binding it to
`APIGatewayProxyEventV2` is a ~40-line event↔`Request`/`Response` shim in `packages/lambda` — not
a framework adapter, and not Hono. Its dependency on `zod@^4.2.0` is satisfied by the workspace's
existing `4.4.3`.

## 3. The shape

```
mcp.swng.golf  (new HttpApi + custom domain)
│
├── POST /mcp ─────────────────────────▶ mcp Lambda
│                                          @swng/mcp: tool table
│                                          → createDispatcher (packages/lambda/src/http)
│                                          → @swng/application use-cases
│
├── GET  /.well-known/oauth-protected-resource[/mcp]
├── GET  /.well-known/oauth-authorization-server
├── GET  /authorize        POST /token
├── GET  /oauth/callback   POST /register  ──▶ mcpAuth Lambda ──▶ Cognito (beta/prod user pool)
└──                                            + mcp-oauth-<stage> table (TTL)
```

**3.1 The MCP Lambda calls the dispatcher in-process.** `@swng/mcp` holds a declarative table
mapping each tool to an entry in `packages/lambda/src/http/routes.ts`, and the dispatcher is
invoked directly. HTTP-over-HTTP would need a second credential, a second hop, and an
impersonation story, since the MCP token is not one the app API accepts. In-process keeps **one**
authorization path, one contracts parse, one error mapping.

**The dispatcher gets decoupled from API Gateway, and the MCP layer is not a package.** An earlier
draft put the tool table in a new `@swng/mcp` package, discovered that `packages/lambda`'s entry
would have to import it back (a workspace cycle pnpm does not error on — it silently drops
topological ordering, and `pnpm -r typecheck` then fails on a clean clone), and solved it by
injecting a *structural look-alike* of the dispatcher. That is the ball-of-mud move: a second
shape beside the real one, kept in sync by nothing.

The actual problem is that `createDispatcher` is welded to `APIGatewayProxyEventV2` — and the weld
is five lines deep (`event.headers`, `event.body`/`isBase64Encoded`,
`requestContext.http.method`, `rawPath`, `queryStringParameters`). So Phase 1 splits it: a
transport-agnostic `dispatch(HttpRequest): Promise<HttpResponse>` core, plus a thin API Gateway
adapter over it. The `http` entry, the MCP layer and the tests then consume **one** dispatcher.

With that done, the MCP layer needs no package of its own: it is a delivery adapter exactly like
`packages/lambda/src/http/`, it has precisely one consumer, and living at
`packages/lambda/src/mcp/` dissolves the cycle rather than working around it. The compute fence
survives as an ESLint `files` glob over that subtree — the same banlist every other consumer gets
(§1.1), not a bespoke rule.

**3.2 Round-scoped tokens are minted once, in the tool dispatcher.** Ten routes are
`auth: "participant"` — every round-scoped **write** — and they want a round-scoped HMAC token an
agent holding a golfer-tier credential does not have. The tool dispatcher mints it in-process
through the use-case behind `POST /rounds/{roundId}/token`, which already proves participation,
then dispatches. One place, no new authorization logic.

**`mintParticipantToken` refuses a finalized round** (`round-final`, by design — there is nothing
left to score). That is correct for all ten writes, and it is why §5.1's read is *not* in this
tier: a read that only works while the round is live would fail on exactly the rounds
`list_my_rounds` returns.

**3.3 A separate `HttpApi`.** Mapping `mcp.swng.golf` at the root of the existing API would serve
`/rounds` and `/crews` under the MCP hostname, muddying the canonical resource URI the whole OAuth
design keys on. It also keeps the two CORS and throttle policies from having to be one policy.

**3.4 Two Lambda entries.** `mcp` and `mcpAuth` share a hostname and nothing else. Claude allows
**10 s** for discovery, registration and token endpoints (30 s for refresh), so `mcpAuth` carries
no MCP SDK and no `aws-jwt-verify`; it serves the two well-known documents from hand-authored
constants typed against the SDK's `OAuthMetadata` / `OAuthProtectedResourceMetadata` **types**,
which erase at build. (`oauthMetadataResponse` would serve them for us, but only by pulling the
SDK into the endpoint whose cold start we are protecting.)

## 4. Authorization

### 4.1 The gap, precisely

MCP requires the resource server to publish RFC 9728 metadata naming an authorization server, and
requires clients to get a `client_id` with no prior relationship — via **Client ID Metadata
Documents** (CIMD), with RFC 7591 DCR retained only as a deprecated fallback. Claude picks CIMD
only when AS metadata advertises **both** `client_id_metadata_document_supported: true` **and**
`"none"` in `token_endpoint_auth_methods_supported`; otherwise it falls back to DCR.

Cognito does neither. That is the *only* thing it can't do.

### 4.2 What Cognito does — measured

Method: the existing beta pool (Essentials, managed login v2), a headless browser through the real
sign-in, then the token and refresh endpoints directly. Every negative below has a **positive
control in the same script, on the same app client, with the same PKCE and `redirect_uri` code
path** — which is what rules out the usual `invalid_grant` confounders (replayed code, 5-minute
expiry, verifier mismatch, redirect mismatch) as explanations.

| # | Question | Result |
|---|---|---|
| F1 | Audience with no `resource` | **No `aud` claim at all**; `client_id` only. |
| F2 | `resource` = a URL that is **not** a registered resource server | `/authorize` returns a code; that code is **unredeemable** (`invalid_grant`), with or without `resource` repeated at `/token`. Controls: the same flow minus `resource` succeeded, and the same flow with a *registered* resource succeeded. |
| F3 | `resource` = a **registered** resource server identifier | `aud` = that identifier exactly. **The identifier may carry a path** — `https://…/mcp` verified end to end. |
| F4 | Refresh grant | `aud` **and** `scope` carried over unchanged. |
| F5 | Custom scopes vs. requested resource | Must belong to it, else `/authorize` fails `invalid_request`: *"custom scopes requested for resource-binding must be assigned to the resource being requested"*. Binding still works with only OIDC scopes. |
| F6 | Managed-login-v2 pool, app client with no branding resource | **"Login pages unavailable. Please contact an administrator."** No form, no error code. |
| F7 | Unknown query parameters on `/authorize` | Tolerated; a code is still returned. |

On F2: AWS documents that `resource` may be "a URL of your choosing," and that is not what the
pool did. The pool held **no resource servers at all** when F2 was measured, so the honest reading
is narrower than "the docs are wrong": *a `resource` value that does not name a registered resource
server produced an unredeemable code here.* **Nothing in this design depends on F2** — §4.3
registers a resource server per F3. It is recorded because the failure is late and quiet: the user
believes they signed in, and the error surfaces at the token endpoint wearing the same
`invalid_grant` as four ordinary faults.

**F3 is what makes the design work.** MCP's canonical resource URI is the endpoint *including its
path*, and Claude requires the PRM `resource` to match the URL the user typed exactly. Because a
Cognito resource server identifier may carry a path, one string is all three things at once.

### 4.3 The design

**One constant, three roles.** `CANONICAL = "https://mcp.swng.golf/mcp"` (beta:
`https://mcp.beta.swng.golf/mcp`) is simultaneously the MCP endpoint URL, the Cognito resource
server identifier, and the PRM `resource`. Scopes are therefore `…/mcp/read` and `…/mcp/write` —
ungainly, forced by F3 + F5, never typed by a human.

**Cognito stays the token issuer; `mcp.swng.golf` is an authorization server that mediates.** It
issues no JWTs. No signing key, no JWKS, no key rotation. It owns the two things Cognito lacks —
client registration and consent — and delegates the rest.

1. **`GET /authorize`** — resolve the client. A URL-shaped `client_id` is fetched as a CIMD (https
   only, no redirects into private address space, 64 KB cap, 5 s timeout, cached per HTTP headers,
   and the document's `client_id` must equal the URL exactly); otherwise it must be a client
   registered at `/register`. Validate `redirect_uri` by exact match, except loopback
   (`http://localhost/*`, `http://127.0.0.1/*`) which matches **port-agnostically** per RFC 8252
   §7.3 — Claude Code binds an ephemeral port. Record the request under a short TTL, then 302 to
   Cognito managed login with **our** app client, our PKCE, and `resource=CANONICAL`. We do not
   request `openid`: `sub` is in the access token, and no ID token is needed.
2. **`GET /oauth/callback`** — exchange Cognito's code immediately (it expires in 5 minutes), hold
   the tokens under a short TTL, then render **our consent page**. Consent is not optional: a proxy
   holding a static upstream client id **MUST** obtain consent per registered client before
   forwarding, and the page **MUST** display the redirect URI hostname. It names the client and its
   hostname, warns when the only registered redirect URIs are loopback, and — see §4.4 — carries
   the read-only choice.
3. **On approve** — mint an opaque code bound to the held tokens, the granted scopes and the
   recorded PKCE challenge; 302 with `code`, `state` and `iss` (RFC 9207).
4. **`POST /token`** (`application/x-www-form-urlencoded`; `/register` is JSON — different parsers)
   — `authorization_code`: verify verifier, `client_id`, `redirect_uri`, return the
   **Cognito-issued access token** plus an opaque refresh handle. `refresh_token`: redeem, call
   Cognito's refresh grant, **rotate** the handle, return the new token. The prior handle stays
   redeemable for a 30-second grace window, because Claude refreshes proactively up to five minutes
   before expiry and two in-flight requests will race. Every failure answers `invalid_grant` —
   Claude keys its recovery on that exact code.

**AS metadata** advertises `issuer`, `authorization_endpoint`, `token_endpoint`,
`registration_endpoint`, `response_types_supported: ["code"]`,
`grant_types_supported: ["authorization_code","refresh_token"]`,
`token_endpoint_auth_methods_supported: ["none"]`,
`client_id_metadata_document_supported: true`,
`authorization_response_iss_parameter_supported: true`, and
**`code_challenge_methods_supported: ["S256"]`** — that last one is a client-side MUST-refuse if
absent, so omitting it fails every connection before it starts.

**Why wrap the refresh token.** Cognito's is bound to our *confidential* app client and useless
without the secret we hold, so passthrough would not be an immediate vulnerability — but it would
put a Cognito credential outside our control with no rotation and no revocation, and OAuth 2.1
requires rotation for public clients, which every CIMD/DCR client is.

**Verification at the endpoint.** The SDK's `requireBearerAuth({ verifier, requiredScopes,
resourceMetadataUrl })` produces the spec-correct `401`/`403 insufficient_scope` challenges; we
supply the verifier as an `OAuthTokenVerifier` — an object with `verifyAccessToken(token):
Promise<AuthInfo>`, returning `{ token, clientId, scopes, expiresAt }`. `expiresAt` is not
optional in practice: the SDK rejects an `AuthInfo` without a numeric one as "Token has no
expiration time", so it is read from the JWT's `exp`. It wraps `aws-jwt-verify` with
`tokenUse: "access"` and our MCP app client id
— **a second verifier in `@swng/adapters-cognito`**, since the existing `createCognitoVerifier`
hard-codes `tokenUse: "id"` for the web and stays exactly as it is. Then the check the library
does **not** do: reading `aws-jwt-verify@5.2.1`'s source, an access token is validated against
`client_id` and **`aud` is never examined** — an audience-bound token and an unbound one verify
identically. So `aud === CANONICAL` is an explicit check in our verifier, and it is load-bearing,
not belt-and-braces. The token never leaves the Lambda; the application is called in-process, so
there is nothing to pass it through to.

**DCR ships, marked as the fallback it is.** CIMD is what Claude and VS Code use and what the spec
prefers; `/register` exists so a client that never learned CIMD isn't locked out. Registration
records carry a 90-day TTL, because DCR's failure mode is an unbounded pile of clients.

### 4.4 Read-only has to be a choice someone can make

Two scopes are pointless unless a golfer can actually pick one, and **the client chooses the scope
set, not the user**: Claude requests what the `WWW-Authenticate` challenge names, or failing that
everything in `scopes_supported`. So a design that advertises both scopes grants write on every
connection, and the `403 insufficient_scope` path never fires.

Therefore, both halves are wired:

- `scopes_supported` advertises **`…/mcp/read` only** — the spec's own guidance is that it carry
  the minimal set for basic functionality, with more requested incrementally.
- **The consent page carries the choice**: read-only, or read and write. Only the approved scopes
  are forwarded to Cognito, so the granted token is the one the golfer picked.
- **Write tools are not listed at all for a read-only token.** `tools/list` may vary by the
  authorization presented — credentials are per-request input, not connection state — and an
  agent shown a tool it cannot use will burn a turn discovering that. So a read-only connection
  sees eleven tools, not twenty-three.

  The consequence is deliberate and worth stating plainly: **there is no runtime step-up.** A
  golfer who chose read-only changes their mind by reconnecting, which walks the same consent
  page. An earlier revision of this spec described the `403 insufficient_scope` → step-up flow as
  the mechanism, which cannot fire for a tool the client was never shown. The `403` path still
  exists — `requireBearerAuth`'s `requiredScopes` produces it — as the backstop for a token whose
  scopes changed between `tools/list` and `tools/call`, not as the primary route to write access.

### 4.5 Why not WorkOS Connect, or Cognito directly

WorkOS Connect standalone does exactly this, well, in front of an existing IdP with no user
migration — and it is the right answer if the façade turns out to be a tar pit. It is not the
starting answer: it makes a third party the issuer of the credential that reaches swng's data, adds
a hosted completion hop through the SPA, and replaces roughly five endpoints against an identity
provider we already run. Keep it as the documented escape hatch.

Pointing clients straight at Cognito fails on §4.1: no CIMD, no DCR. `oauth_anthropic_creds` would
fix claude.ai but not Claude Code, which runs its own CIMD flow, and nothing else at all.

## 5. The tool surface, and the fence

**`…/mcp/read`** (11) — `whoami`, `list_my_rounds`, `get_round`, `list_live_rounds`, `peek_round`,
`search_courses`, `get_course`, `my_course_record`, `list_my_crews`, `get_crew`,
`crew_season_standings`

**`…/mcp/write`** (12) — `start_round`, `join_round`, `record_score`, `set_participant_strokes`,
`set_round_holes`, `set_round_played_at`, `add_game`, `terminate_game`, `finalize_round`,
`abandon_round`, `leave_round`, `share_round`

**The round is covered whole** (owner call, 2026-08-23). An earlier draft withheld `abandon`,
`leave` and `share` as "destructive or socially consequential"; that was the wrong cut. A round is
one aggregate with one lifecycle, and an agent that can start and score a round but cannot scrap
it, or cannot say the group played the back nine, is a half-doorway that pushes the golfer back to
the phone mid-task. Every round-scoped verb in `routes.ts` is a tool. `set_round_holes` takes the
domain's own `HoleSelection` — `"all" | "front" | "back"` — so the enum is the contract, and a
card with one nine resolves every arm to that nine without an error case.

The model forgives a wrong write: every score is an event, every correction is another event,
nothing is destroyed. The two genuinely one-way acts get called out in their tool descriptions
rather than withheld — `abandon_round` is terminal and produces no archive, and `share_round`
mints an immortal public spectator link.

Still **not** exposed: crew administration, course-card maintenance, and `POST
/rounds/{roundId}/token` (an internal capability, minted by §3.2, never a tool).

Each tool returns `structuredContent` plus a text rendering. It declares **no `outputSchema`** in
v1: the protocol makes one optional, and validation only runs when it exists — but declaring one
means authoring a zod mirror of every response type, including a five-arm `GameState` union that
`@swng/contracts` does not have today. That is a real piece of work with its own review, not a
field on a tool definition, and it buys nothing until a client is observed to want it. The table is
sorted, because the spec asks for deterministic `tools/list` ordering to keep caches warm.

### 5.1 `get_round` needs a route that does not exist yet

Nothing on the wire returns a **folded** round. `GET /rounds/{roundId}/archive` returns
`{ events }` and reads `SnapshotStore` only, so a live round answers `round-not-found`;
`GET /rounds/{roundId}/events` returns `{ events, nextSeq }`. The web folds these itself through
`@swng/client`'s `foldAndScore` — a path closed to us twice over, since `packages/lambda` is
already barred from importing `@swng/client` (`eslint.config.mjs`), and folding inside `@swng/mcp`
is exactly what §5.2 forbids. Handing a raw `RoundEvent[]` to the model and letting it total the
card is the same violation with extra steps.

So this arc adds **`GET /rounds/{roundId}/view`** (`auth: "golfer"`): one read that folds
server-side and returns the card, participants, games and results — from the journal for a live
round, from the snapshot for a finalized one. This is not a new pattern: `peekRound` already folds
through `loadRoundState` → `reduceRound` and returns a wire response.

**The tier is `golfer`, not `round-read`**, and the reason is the one §3.2 names: a round-scoped
token cannot be minted for a finalized round, so a `round-read` view would 409 on every round in a
golfer's history — the exact rounds this tool exists to read. `golfer` matches the precedent
already set by `GET /rounds/{roundId}/archive`, whose own comment says the archive outlives any one
device's credential. Authorization then splits inside the use case, on the one axis that matters:
**a finalized round is readable by any signed-in golfer** (identical to `/archive`'s existing rule
— a settled scorecard is already visible on every participant's record), while **a live round is
readable only by someone on its roster**. Live rounds are the capability-gated ones; settled ones
are history.

One thing has to move first (Phase 1). `reduceRound` + `scoreGame` is the whole fold, but
`scoreGame` throws on a game kind it doesn't recognize, so every caller needs the known-kinds
filter — and that filter (`KNOWN_GAME_KINDS`, `foldAndScore`) lives in `@swng/client`, which
`@swng/application` is barred from importing. Copying the list would put a second
name-every-game-kind list in the tree, which `scoring.ts`'s own comment exists to prevent. So it
moves into `@swng/domain` beside the `scoreGame` it guards, and `@swng/client` re-exports it. That
is decision #3 of `architecture.md` applied literally: one domain, two runtimes, one tested copy.

**The response must carry `GameState`, and that means `@swng/contracts` gains the schema it is
missing.** A previous revision of this spec tried to compose the response out of `RoundArchive`'s
vocabulary — `card`, `holes`, `participants`, `games`, `cells`, `results` — on the grounds that
`gameResultSchema` already exists and a new `z.ZodType<GameState>` "should not exist". That was
wrong, and `resultOf`'s own comment says why:

> "A game 'resolves' when: stroke-play/stableford's `complete === true`; a match's `outcome !==
> undefined`; skins' `complete === true`. Undefined means keep polling — **there is no partial
> `GameResult`, only the live `GameState` for in-progress views.**"

`GameResult` is the *settled* shape. Composed that way, a live round's response would carry a
course card, a roster, game *configs* and a bag of raw `ScoreCell`s — no totals, no thru, no
leader, nobody's standing. It would answer "how did that round end" and be silent on "how is this
round going", which is the question the arc exists to answer and the one only a browser can answer
today.

So authoring `z.ZodType<GameState>` — a five-arm discriminated union over the same kinds
`gameResultSchemaImpl` already covers — is **a real, estimated Phase 1 task**, not overhead to be
designed away. It is also the sharpest instance of §1.1's point: the live scoring shape has never
been on the wire, so the browser has been the only thing that could see it. Serving it is the
"everything behind the API" fix, and it stands on its own with MCP cancelled.

The response is therefore: `status`, `card`, `holes`, `playedAt`, `participants` (`RosterEntry`),
`games` (`GameState` — live scoring), and `unresolved` (from `unresolvedGames(state)`, rendered
through the prose Phase 1 moves into `present.ts`).

Cost: the `GameState` schema, a `@swng/contracts` response type, a `@swng/application` use-case,
one entry in `routes.ts` and one in `HTTP_ROUTES`.

That the flagship read needed a new route is the finding that most changed this spec. `@swng/mcp`
stays a pure renderer *because* of it.

### 5.2 The fence

The MCP layer renders; it computes nothing. But **it gets the same fence every other consumer
gets, not a bespoke one** — and that distinction is the whole lesson of §1.1.

The web's fence is an `importNames` banlist on `@swng/domain`: the fold, the five scoring engines,
stroke allocation, net arithmetic and leaderboard ordering are banned; the presentation vocabulary
in `present.ts` is *allowed*. An earlier draft gave the MCP layer a blanket "may not import
`@swng/domain` at all", which sounds stricter and is worse: it would have barred the MCP layer
from `describeGame`, `strokesSummary` and `holeSelectionLabel` — forcing it to hand-write a second
English rendering of every golf fact, which is precisely the drift Phase 1 exists to undo.

So the banlist is extracted into one shared constant in `eslint.config.mjs` and applied to
`apps/web/src` and `packages/lambda/src/mcp/**` alike, and both are added to the golf-arithmetic
fence's file globs. Rendering a scorecard as text is rendering; adding two of its numbers is not.

**Applying it to the MCP subtree is a task, not a consequence.** `layer("packages/lambda", …)`
bans only `@swng/client` and the AWS SDKs, so without an explicit rule the MCP layer may import
`scoreGame` and `reduceRound` freely and the extraction buys nothing. The rule lands in the task
that creates the subtree, and its verification step is a probe that must fail lint.

Every number in a tool result still arrives already folded, through the dispatcher, from
`@swng/application` — the fence is about who may *compute*, not who may *speak*.

**Golfer identity.** `sub` resolves through the existing sub-binding, which mints a golfer with a
placeholder name if none exists. An agent-first golfer is possible and correct; nothing special is
needed for it.

## 6. Infrastructure

Added to `SwngStack`, all gated on a new optional `mcp` prop resolved from `STAGE_CONFIG` so that
**a stage without the prop synthesizes byte-identical to today**:

- One `HttpApi` (`McpApi`) + `DomainName` + `ApiMapping` + certificate + Route 53 records. Beta
  `mcp.beta.swng.golf`, prod `mcp.swng.golf`. **With `corsPreflight`** (§7).
- Two `NodejsFunction`s: `mcp`, `mcpAuth`.
- One DynamoDB table `mcp-oauth-<stage>`, TTL-driven: registered clients, in-flight authorization
  requests, held Cognito tokens awaiting consent, authorization codes, refresh handles.
- One Cognito resource server whose identifier **is** `CANONICAL`, scopes `read` and `write`.
- One Cognito app client (`swng-mcp-<stage>`, confidential, secret in Secrets Manager), callback
  `https://<mcp host>/oauth/callback`, custom scopes attached — **plus its own
  `CfnManagedLoginBranding`**. Per F6 an app client without one has no login page at all, and the
  symptom names nothing that leads to the cause.
- Explicit routes on `McpApi`, declared in a table beside `HTTP_ROUTES` for the same reason.
- Stage throttle, 5xx and p95 alarms matching the existing API's.

## 7. Origin, CORS, and other limits

**Origin.** The SDK passes requests with no `Origin` (non-browser clients send none) and 403s
Origins outside its allow-list. The transport's Origin rule sits beside "when running locally, bind
only to localhost" — it defends locally-bound servers reachable by rebinding a hostname onto
127.0.0.1. This endpoint is public HTTPS whose only credential is a bearer token in a header: no
cookie, no ambient authority, nothing a rebound page can borrow that it couldn't already request
today and be 401'd for. So the policy is deliberately permissive — any Origin admitted, the header
logged — rather than an allow-list of swng web origins, which would admit a set that never calls
this endpoint while 403-ing the browser-hosted MCP clients §1 says this is for.

**CORS.** `McpApi` ships `corsPreflight` (any origin; `Authorization`, `Content-Type`,
`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`). Without it a browser-hosted client
fails preflight before any of the above runs — the existing API configures CORS and the new one must
too.

**Timeouts.** API Gateway's integration cap is 30 s; Claude allows 10 s for discovery, registration
and token, 30 s for refresh. `mcpAuth`'s cold start is a budget item, not a footnote (§3.4).

**No streaming.** A tool that can't answer in one buffered response doesn't belong here. None of the
fifteen comes close.

**Egress.** Anthropic calls from `160.79.104.0/21`; if a WAF ever fronts `McpApi` or the Cognito
domain, that range has to survive it.

## 8. Testing

- **`toolRoutesParity`** — every tool names a live route in `buildRoutes`.
- **The `CANONICAL` drift guard.** Deriving all four uses from one exported constant makes an
  equality test unfalsifiable — there is no edit that turns `X === X` red. The guard that can fail
  is the one `routesParity.test.ts` already models: bridging independently authored places. So it
  lives in `apps/infra-cdk/test` and reads the **synthesized template** — the
  `AWS::Cognito::UserPoolResourceServer` `Identifier`, the `mcp` function's environment variable,
  and the `DomainName` plus route path — because those are where a stack edit can drift them apart.
  Drift makes every authorization code unredeemable with an error pointing nowhere near the cause.
- **Façade unit tests** — PKCE mismatch rejected; `redirect_uri` exact match with loopback
  port-agnosticism; CIMD whose `client_id` ≠ its URL rejected; CIMD fetch refusing private address
  space; no code issued before consent; a read-only consent forwarding only `read`; refresh
  rotation invalidating the prior handle **after** its grace window and honouring it within;
  `invalid_grant` on every refresh failure path.
- **Protocol conformance** — `@modelcontextprotocol/client` against the handler in-process:
  `server/discover`, `tools/list`, `tools/call`, header/body mismatch, unknown method.
- **The beta gate is Playwright, not `e2e:beta`.** Resource binding is managed-login-only, so the
  `InitiateAuth` shortcut the existing e2e suite uses **cannot** mint an MCP token. The gate signs
  in through managed login, completes consent, and drives a real `tools/call`. It belongs in
  `apps/web/e2e`.

## 9. What this deliberately does not do

Resources, prompts, `subscriptions/listen`, the tasks extension, MCP Apps, sampling and elicitation
(all deprecated in this revision anyway), WebSocket parity with the live-round channel,
`client_credentials` (Claude doesn't support it, and there is no user to consent), and every write
outside the §5 list.

## 10. Owner calls — settled 2026-08-23

1. **Tool surface: the round is covered whole.** §5 revised — every round-scoped verb is a tool,
   including `abandon_round`, `set_round_holes`, `set_round_played_at`, `leave_round`,
   `terminate_game` and `share_round`.
2. **Writes ship in v1.** Yes.
3. **`GET /rounds/{roundId}/view` is a public API addition** (§5.1), accepted — it widens the arc
   past "a wrapper", and that is the right home for the fold.
4. **Beta only in this arc.** `swng-prod` keeps serving its current build and is not touched. The
   `mcp` prop stays absent for prod, so prod synthesizes byte-identical; a later prod deploy needs
   nothing from this arc but the deploy itself.
