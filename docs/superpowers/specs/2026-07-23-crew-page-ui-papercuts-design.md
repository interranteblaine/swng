# Crew-page UI papercuts — converge on the shared idioms

**Status:** approved (2026-07-23)
**Base:** `8a2a69e` (local `main`)

## The report

Owner field report (screenshot, phone viewport, `beta.swng.golf` crew page), two warts:

1. **The invite link overflows the screen.** The copied invite URL (a long HMAC
   token) runs off the right edge, breaking the page layout.
2. **The `Remove…` / `Make organizer…` roster buttons are oversized boxed
   idioms**, not the inline text-register style used everywhere else for
   row-scale affordances.

## The root cause (why these exist, and why we keep revisiting warts like them)

Both warts have the same origin: **the crew page reinvented shared idioms
instead of using them, then drifted.**

- The app already has ONE copy-link component — `ui/CopiedLinkLine.tsx` — with
  `break-all` on the URL span and a comment citing this exact overflow class
  from a 2026-07-21 owner field report. Round share and round invite both route
  through it. The crew invite panel hand-rolled its own two `<p>` lines
  (`CrewPage.tsx:379–380`) and so never received the `break-all` fix.
- The design system already names the row-scale action register — `btnQuiet`
  (`ui/classes.ts:28`, "for row-scale affordances living INSIDE a line of text
  … where any boxed button idiom is visually oversized"). The crew-name
  **Edit/Save/Cancel** and SeasonPanel **Edit** use it. The roster
  `Remove…`/`Make organizer…` reached for the boxed `btnDanger`/`btnSecondary`
  instead.

The fix is therefore convergence, not a patch: route the crew invite through the
shared component, and apply the established row register to the roster buttons.

## The sweep (the recurrence guarantee, verified not promised)

A whole-`apps/web/src` grep grounds the scope:

- **Copy-link lines:** exactly ONE hand-rolled holdout — `CrewPage.tsx:380`.
  Every other copy-link surface already uses `CopiedLinkLine`.
- **Row buttons:** of every `btnDanger`/`btnSecondary` use in the app, exactly
  TWO are row-scale affordances wearing a boxed idiom — the crew page's
  `Remove…` and `Make organizer…`. All others are section-level actions
  (`Leave crew`, `End game…`, `Scrap`, `Clear score`) or confirm-dialog buttons,
  which are correctly boxed.

So this is not an app-wide problem — it is two drifted spots on one page. After
this arc there is no second hand-rolled copy-link line and no other row button
wearing a boxed idiom. That is the "stop revisiting this class of wart" claim,
as a fact about the two classes rather than an app-wide audit.

## Fix 1 — converge the crew invite onto `CopiedLinkLine`

`CopiedLinkLine` gains ONE optional prop, `note?: string`, rendered with the
"Copy this link" / "Link copied" label so a caller can state a link-scoped fact
(here: the invite's 7-day expiry). The URL keeps its existing
`font-mono break-all select-all` treatment inside the component — unchanged for
the two existing callers, which pass no `note`.

Current component (single paragraph): `{copied ? "Link copied — " : "Copy this
link — "}<span …>{url}</span>`. With a `note`, the paragraph reads
`Copy this link · good for 7 days — <url>` (note set off before the em-dash that
introduces the URL). Without a `note`, the output is byte-identical to today.

`CrewPage` deletes its hand-rolled lines (379–380) and renders:

```tsx
{inviteUrl && <CopiedLinkLine url={inviteUrl} copied={inviteCopied} note="good for 7 days" className="mt-2" />}
```

The invite-error `<p>` below is unchanged. Result: all three copy-link surfaces
(round share, round invite, crew invite) render through one `break-all`-correct,
tested component; the overflow cannot recur without regressing shared code.

## Fix 2 — apply the row-action register to the roster buttons

`ui/classes.ts` gains `btnQuietDanger` — the same text register as `btnQuiet`,
in oxblood, so a destructive row action keeps the brand's "oxblood = careful
action" signal while shedding the oversized box:

```ts
// The destructive sibling of btnQuiet — a row-scale text action that is also a
// careful one (a roster Remove…). Oxblood carries the destructive signal; the
// text register keeps it row-sized. The heavier oxblood weight (btnDanger box,
// btnDangerSolid confirm) is still reserved for the confirm step.
export const btnQuietDanger = "text-oxblood underline decoration-oxblood/50 disabled:opacity-50";
```

`CrewPage` roster row (the not-confirming branch, ~442–463):

- `Remove…` → `className={btnQuietDanger}` (was `btnDanger`).
- `Make organizer…` → `className={btnQuiet}` (was `btnSecondary`).

The inline row already sits inside a `text-sm` parent, so both buttons inherit
row-appropriate sizing. No layout change beyond the button chrome.

## What stays as-is (and why)

- The in-dialog **Confirm / Cancel** (`btnDangerSolid` / `btnSecondary`) stay
  boxed — a decision moment, matching the `Leave crew` confirm exactly.
- The section-level **Leave crew** trigger (`btnDanger`, `self-start`) stays
  boxed — not a roster-row affordance.
- The crew invite's **expiry copy** stays (now carried by `note`) — an invite
  that expires is a fact the inviter needs.

## Non-goals

- No wire/schema change, no new route, no `deploy:beta`. Presentation only.
- No app-wide UI audit beyond the two verified classes above.
- No change to the two existing `CopiedLinkLine` callers' rendered output.

## Testing & gate

- `CopiedLinkLine.test.tsx`: add a case that the `note` renders with the label
  and that omitting `note` leaves the existing output unchanged (the URL's
  `break-all`/`select-all` assertions already exist and must stay green).
- `CrewPage.test.tsx`: existing tests query `Remove…` / `Make organizer…` by
  accessible name and assert the invite copy by text — restyling is
  test-transparent; they must stay green with no edits.
- `pnpm validate` green at every commit and at HEAD.
- Close: `publish:web:beta` (web-only, no lambda), then `e2e:field`
  reconciliation (no locator depends on the changed chrome; a run confirms it).
