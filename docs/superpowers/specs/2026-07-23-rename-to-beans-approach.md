# Rename swng → Beans — approach & findings (PARKED)

**Status:** PARKED (2026-07-23). Owner call: too much investment for a side project right now.
Not scheduled. This document is the durable record so the work can resume cleanly.

**Why this exists:** `swng` is someone else's trademark; the product must eventually rename. The
owner has acquired **beans.golf** (Route 53) and the **@beans.golf** Instagram handle, so the
working new identity is **"Beans" / beans.golf**. The owner has since stated the product **is going
to prod** — which changes the trademark calculus (see Findings).

**Two gating decisions before this un-parks:**
1. Trademark clearance clears for "Beans" in the relevant classes (see Findings → recommendation).
2. Owner confirms the name and the three sub-decisions below.

---

## 1. The core framing: this is FOUR renames, not one

Treating "swng" as a single find-and-replace is the mistake. The string lives at four
semantically distinct levels, each with a different blast radius and a different clock:

| Layer | What it is | Examples | Blast radius | Cost |
|---|---|---|---|---|
| **1. Brand / copy** | User-visible name | `<title>swng`, page-title suffix `· swng`, wordmark, landing copy | Presentation only | Trivial, web-only, reversible |
| **2. Code identity** | npm scope & names | `@swng/*` (12 packages), root `swng`, `SwngStack`, dir/repo | Compile-checked, zero runtime/data effect | Wide but mechanical — green build = done |
| **3. Infra identity** | Named cloud resources | stack `swng-beta`, DynamoDB `swng-rounds-beta` (×5 tables), Cognito pool/client/domain, HMAC secret, APIs, DLQ, alarms | Destroy + recreate — **tables can't be renamed in place** | The real operational work |
| **4. Domain vocabulary** | Stored/wire values | `indexSource.kind:"swng"` (the "**swng index**" metric — persisted, defaulted-to on parse), localStorage keys `swng:auth`/`swng:returnTo`/`swng:pkceVerifier` | A *contract enum with stored data*, not cosmetic | Schema change → needs a wipe + a product decision |

**Layer 4 is the easily-missed one.** `{kind:"swng"}` is not the brand — it's a **named metric in
the model** (the *swng index* vs. the *WHS index*), living in the Zod schema and defaulted-to when a
golfer row has no source. It cannot be sed'd away without a wire/schema decision.

## 2. The insight that makes it cheap: there is NO data-migration problem

The single most important fact. **There is no prod stack yet, and beta is explicitly disposable**
(wiped + reseeded as routine close-out). So the part of a rename that is normally a multi-week
nightmare — renaming live infrastructure *under production data* — **does not exist right now.**
The move for Layers 3 & 4 is: destroy `swng-beta`, stand up `beans-beta`, wipe the data. No
migration, no dual-write, no tolerate-old-values machinery.

**This is the cheapest this rename will ever be, and it gets more expensive the moment prod exists.**
If the rename is going to happen at all, doing it *before* the prod-stack milestone is correct by a
wide margin. (Corollary: if prod ships first under "swng", the rename becomes a genuinely hard
data-bearing migration.)

## 3. What NOT to touch (scope discipline)

- **Historical specs & plans** (~600 of the occurrences, under `docs/superpowers/`) — a *dated record
  of what happened under the name swng*. Rewriting them is dishonest and pointless. They stay. Only
  the **live north-star docs** adopt the new name: `CLAUDE.md`, `docs/product.md`, `docs/roadmap.md`,
  `docs/architecture.md`, `docs/engineering-conventions.md`, `docs/implementation-plan.md`,
  `docs/papercuts.md`.
- **The POC stacks** (`InfraCdkStack-beta` / `InfraCdkStack-prod`) — untouched, as always.
  `BeansStack`'s constructor keeps the same throw-guard against those ids.
- **Data** — no migration. Wipe, don't migrate.

## 4. The three decisions that are the owner's

Everything mechanical is decidable without the owner. These three are not:

1. **The name.** Assumed: product **"Beans"**, npm scope **`@beans/*`**, stack **`beans-beta`**,
   domain **beans.golf / beta.beans.golf**. Confirm or correct.
2. **The "swng index" metric (Layer 4).** *Recommendation:* rename the user-facing metric to
   **"Beans index"** and move the wire enum to `{kind:"beans"}` (beta is wipeable — take the clean
   value rather than carrying a `swng` codename that contradicts the brand forever). Alternative
   (keep `kind:"swng"` as an internal stable codename) is rejected: an internal name that
   contradicts the brand is exactly the latent confusion we design out.
3. **Repo + local dir** (`github.com/interranteblaine/swng`, `~/workplace/swng`). Cosmetic, and the
   owner never pushes (local `main` is far ahead of a stale origin), so low value. *Recommendation:*
   rename the GitHub repo (auto-redirects), leave the local dir unless the owner wants it moved.

## 5. Execution sequence (when un-parked)

One atomic rename branch for Layers 1/2/4, then a controlled infra cutover for Layer 3 — same
SDD + controller-gate discipline as every other arc:

1. **Code + brand + vocabulary** (one branch): scope `@swng`→`@beans`, class/resource-*name*
   strings, brand copy, the `indexSource` enum + localStorage keys, live north-star docs. The
   compiler + `pnpm validate` is the proof — a green build means Layer 2 is complete by
   construction.
2. **Infra cutover** (controller-run, operational):
   - `deploy:beta` stands up `beans-beta` fresh, alongside `swng-beta`.
   - Mint beans.golf DNS / ACM cert (in-stack, DNS-validated via Route 53) / Cognito Hosted-UI
     domain / CloudFront alias.
   - `publishWeb` to the new bucket; verify `beta.beans.golf` end-to-end with a real PKCE sign-in.
   - **Then** tear down `swng-beta` and retire swng.golf.
3. **Gates:** `e2e:beta` + `e2e:field` repointed at the new API/domain, plus a live USE walk on
   `beta.beans.golf`.

## 6. Risks / gotchas

- **Cognito domain-prefix global uniqueness** — `beans-beta-<account>` must be available; pre-flight
  check before the deploy (the prefix is globally unique across all AWS accounts).
- **ACM DNS validation** is automatic via Route 53 but adds a few minutes to the first deploy;
  sequence the cert before the CloudFront alias flip.
- **Trademark clearance is the owner's to obtain** — not something code can assume done (see
  Findings). Owning beans.golf grants **zero** trademark rights.
- **Everyone gets logged out** when the localStorage keys + Cognito pool change — a non-event on beta
  (no real users), noted so it isn't a surprise.

---

## Scope, quantified (measured 2026-07-23 at HEAD)

- **2,059** occurrences of `swng` (case-insensitive) across **358** files.
- By area (occurrences): `apps/` 684 · `docs/` 673 · `packages/` 519 · root `.md` 83 · `scripts/` 24
  · `e2e/` 22. (`CLAUDE.md` alone is 82.)
- Of the ~673 in `docs/`, **~600 are historical specs/plans** under `docs/superpowers/` → **leave**.
- **12 packages** under the `@swng/` scope + the root `swng` package:
  `@swng/{domain,contracts,application,client,adapters-apigateway,adapters-cognito,adapters-dynamodb,adapters-powertools,lambda}`,
  `@swng/web`, `@swng/infra-cdk`, `@swng/e2e`.
- **Infra resource-naming pattern is uniform:** `swng-*-${stage}`. The load-bearing (data-holding)
  ones — the 5 DynamoDB tables: `swng-rounds`, `swng-snapshots`, `swng-core`, `swng-projections`,
  `swng-connections` (each `-${stage}`). Plus Cognito pool `swng-${stage}`, client `swng-web-${stage}`,
  Hosted-UI prefix `swng-${stage}-${account}`, HMAC secret `swng-token-secret-${stage}`, DLQ
  `swng-projector-dlq-${stage}`, WS API `swng-ws-${stage}`, HTTP API `swng-http-${stage}`, alarms
  topic `swng-alarms-${stage}`, CSP policy `swng-web-csp-${stage}`. Stack class `SwngStack`, stack
  name `swng-beta`.
- **Domain/DNS:** `swng.golf` (76 occurrences) in `apps/infra-cdk/bin/infra-cdk.ts` (the `STAGE_WEB`
  table), `apps/infra-cdk/lib/swngStack.ts`, `apps/web/src/auth/authConfig.ts`, and a few tests.
  Live today at `beta.swng.golf`.
- **Layer-4 vocabulary:** `indexSource.kind:"swng"` (contracts Zod enum, defaulted on parse across
  the golfer wire); localStorage keys `swng:auth`, `swng:returnTo`, `swng:pkceVerifier`; page-title
  suffix `· swng`; `apps/web/index.html` `<title>swng`.
- **Repo:** `https://github.com/interranteblaine/swng.git` (origin is stale — owner never pushes);
  local dir `/Users/blaine/workplace/swng`.

---

## Trademark findings — the cheap collision check (2026-07-23)

A quick Google / App Store / trademark-index sweep to catch obvious collisions cheaply. **This is
NOT a clearance opinion.**

**The search that matters came back clean:**
- **No golf product named "Beans" exists.** Not in any "best golf apps 2026" roundup, not in App
  Store golf listings, no beans.golf company/app, no golf software or hardware brand. The only golf
  "Beans" hits are a **podcast** ("Golf Beans") and a **golfer's nickname** (Peyton "Beans" Factor)
  — neither is a product or a mark in-lane. This is the collision that would kill it, and it's absent.
- **No "BEANS" trademark in the golf / sports / software lane surfaced.** The identifiable live
  standalone-"BEANS" marks are food/agriculture: Farmer Bean & Seed (Class 29, *dried beans*),
  BEANSTORE (retail/network software — a different mark). A `Beans LLC` "BEANS" application exists
  (USPTO serial **90008760**) whose class **could not be confirmed** (Justia/Trademarkia blocked
  automated fetches) — **owner should eyeball this directly.**

**Two real caveats (neither a blocker):**
1. **App Store namespace is crowded with non-golf "Beans"** (a food-loyalty app literally named
   *Beans*, plus *Beansy*, *Smart Beans*, *BEAN Now*). Apple allows duplicate display names → doesn't
   block, but "Beans" is a hard word to rank for / be found by in store search. Marketing cost, not
   legal.
2. **"Beans" is a dictionary word → a weaker mark to *own*.** Nobody can own "beans" broadly (good),
   but the register is packed with BEANS-formative marks, so likelihood-of-confusion is fact-specific
   and class-by-class — exactly what a web look cannot conclude. Note: `swng` (a coinage) was
   actually a *stronger* trademark position than a dictionary word; the problem was someone else
   reached "swng" first, not that a coined name is weak. A bare "Beans" is harder to protect/enforce
   than "Beans + distinctive element" or a fresh coinage.

**Recommendation (given "going to prod"):**
- On the obvious-collision test: **green.** Don't abandon "Beans" over a collision — there isn't one.
- **Commission a real clearance search before public launch / the prod stack — not before the code
  work.** A knockout + clearance search (trademark attorney, or at minimum a paid clearance service)
  over **Classes 9, 42, 41, 28** is a few hundred dollars / ~a week. It catches the non-obvious
  BEANS-in-a-related-class mark a Google search never will, and gives a defensible basis to file.
- **Treat a clean clearance as the launch gate, not the code-work gate.** The rename can ship to
  beta under "Beans" and remain fully reversible in git; the **prod cutover** is what should wait on
  clearance. A forced *second* rename after the name is live in prod is the one scenario that
  genuinely hurts.
- **Owner to-do (2 min):** open USPTO Trademark Search (`https://tmsearch.uspto.gov/`, the tool that
  replaced TESS) and confirm `Beans LLC` serial **90008760** is not in Class 9/41/42/28.

**Sources:**
- App Store — "Beans" (food loyalty app, not golf): https://apps.apple.com/us/app/beans/id6504507114
- Golf Monthly, Best Golf Apps for iPhone 2026 (no "Beans"): https://www.golfmonthly.com/best-golf-deals/best-golf-apps-for-iphone-140359
- Great Games for Golfers, best golf side-game apps (no "Beans"): https://greatgamesforgolfers.com/golf-reviews/the-best-apps-for-golf-side-games/
- "Golf Beans" podcast: https://open.spotify.com/show/3tPrygkq994Gid71TAbfvx
- Golfer Peyton "Beans" Factor: https://ictnews.org/news/with-a-name-like-beans-chickasaw-golfer-lands-licensing-deal/
- BEANS — Farmer Bean & Seed, Class 29 dried beans (food, live): https://huski.ai/trademark-details-mark-beans-country-us-serial-number-US-TM-78963775
- BEANS application — Beans LLC, serial 90008760 (class unconfirmed): https://trademarks.justia.com/900/08/beans-90008760.html
- USPTO Trademark Search (replaced TESS): https://tmsearch.uspto.gov/
