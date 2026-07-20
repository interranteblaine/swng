# Round-Page Papercuts + Join Code With the Credential — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the five owner field reports — ScorePad "Cancel" rename, scorecard cell alignment, live-round action reorder, and a "Copy invite link" built on the model fix that serves the join code on every participant-token response.

**Architecture:** Spec `docs/superpowers/specs/2026-07-20-round-page-papercuts-join-code-design.md` is binding. Items 1–4 are composition/class/string changes in `apps/web` only. Item 5 adds required `joinCode` to `JoinRoundResponse` (both `POST /rounds/join` and `POST /rounds/{roundId}/token` return it), backed by a new `RoundStore.getJoinCode` port method reading the round meta item the adapter already writes — then the web saves `response.joinCode` on every entry path and renders one quiet copy affordance.

**Tech Stack:** existing monorepo (Zod contracts, application ports, DynamoDB adapter, React 19 + Tailwind 4, Vitest, Playwright).

## Global Constraints

- Work on local `main`; **never push**.
- `pnpm validate` green at every commit (single-file runs: `pnpm --filter <pkg> exec vitest run <file>` — the bare `-F <pkg> vitest run` form does not resolve).
- Copy strings verbatim: button **"Cancel"** (ScorePad), button **"Copy invite link"**, fallback line prefixes **"Link copied — "** / **"Copy this link — "** (ShareButton's exact idiom).
- The copy affordance wears `btnQuiet` (ui/classes.ts) — never a boxed/gold idiom; AddGameForm's submit stays the screen's one gold.
- `joinCode` is **required** on `JoinRoundResponse` (spec §2 invariant: holding a participant token means holding the code). No new routes, no new error codes (`round-not-found` reused), no event-log change.
- New `LiveRound` order (spec §1): StandingsHeader → ScorecardGrid → SetupPanel → FinalizeControl → LeaveControl → ScrapControl → ShareButton. ResultsView: ShareButton moves to the very bottom.
- Deploy (close-out, controller-run): **lambda-first**, then publish web.

---

### Task 1: The four UI corrections (web-only)

**Files:**
- Modify: `apps/web/src/round/ScorePad.tsx` (lines 29–31 comment, 63–65 button)
- Modify: `apps/web/src/round/ScorePad.test.tsx` (lines ~41, ~87–93, ~99–102)
- Modify: `apps/web/src/round/ScorecardGrid.tsx` (line 86)
- Modify: `apps/web/src/routes/RoundPage.tsx` (LiveRound, lines ~287–299)
- Modify: `apps/web/src/round/ResultsView.tsx` (line 43 removed; bottom gains it)

**Interfaces:** no signature changes anywhere — strings, one class, composition order only.

- [ ] **Step 1: ScorePad rename.** Button text `Clear selection` → `Cancel` (ScorePad.tsx:64). Update the doc comment above the component: "`Clear selection` is the only button that does NOT call onSubmit" → "`Cancel` is the only button that does NOT call onSubmit — it backs out without posting anything (renamed from the M5-era 'Clear selection', which read as a data action beside `Clear score`)."

- [ ] **Step 2: ScorePad tests.** In ScorePad.test.tsx:
  - comment `the separate Clear selection button` → `the separate Cancel button`;
  - test `"tapping Clear selection cancels without posting anything"` → `"tapping Cancel closes without posting anything"`, and its locator `getByRole("button", { name: /clear selection/i })` → `getByRole("button", { name: "Cancel" })` (exact — no other Cancel exists inside the pad);
  - the `Clear score` describe's lead comment `Distinct from \`Clear selection\` above` → `Distinct from \`Cancel\` above`.

- [ ] **Step 3: Cell alignment.** ScorecardGrid.tsx:86 — the Cell button className gains `w-full`:

```tsx
className={`${cardBox} flex min-h-14 w-full min-w-14 flex-col items-center justify-center gap-0.5 px-1 py-1 active:bg-goldwash`}
```

  Add one line to the Cell doc comment: `w-full: the cell fills its column so it stays centered under the (centered) name header at any column width — min-w alone shrink-wraps and hugs the column's left edge (owner field report, 2026-07-20).`

- [ ] **Step 4: LiveRound reorder.** RoundPage.tsx — LiveRound's return becomes (comment included):

```tsx
  // Order is the owner's ruling (spec 2026-07-20 §1): the card and its setup first, then
  // Finalize (the round's one big action), then the personal/destructive pair, then Share —
  // the least-used affordance — dead last.
  return (
    <>
      <StandingsHeader state={state} games={games} onTerminate={onTerminate} />
      <ScorecardGrid state={state} recordScore={recordScore} />
      <SetupPanel state={state} games={games} joinCode={joinCode} onAddGame={onAddGame} onSetHandicap={onSetHandicap} />
      <FinalizeControl state={state} games={games} onFinalize={onFinalize} onTerminate={onTerminate} />
      <LeaveControl onLeave={onLeave} />
      <ScrapControl onAbandon={onAbandon} />
      <ShareButton roundId={state.id} token={token} />
    </>
  );
```

- [ ] **Step 5: ResultsView.** Delete line 43 (`{shareToken && <ShareButton roundId={state.id} token={shareToken} />}`) and re-insert the identical line as the LAST child of the `<section>`, after the "Final card" `<div>`, with the comment `/* Share sits last on results too — same least-used ruling as the live view (spec 2026-07-20 §1). */`

- [ ] **Step 6: Run the web suite.**

Run: `pnpm --filter @swng/web exec vitest run`
Expected: PASS (existing Share/Finalize assertions are presence-based, not positional; only the ScorePad strings changed).

- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/round/ScorePad.tsx apps/web/src/round/ScorePad.test.tsx apps/web/src/round/ScorecardGrid.tsx apps/web/src/routes/RoundPage.tsx apps/web/src/round/ResultsView.tsx
git commit -m "fix(web): Cancel not 'Clear selection', cells fill their column, Share last / Finalize below games (owner field reports)"
```

---

### Task 2: The join code rides every participant-token response (contracts → application → adapter → lambda)

**Files:**
- Modify: `packages/contracts/src/commands.ts` (`JoinRoundResponse` ~line 91, `joinRoundResponseSchema` ~line 133)
- Modify: `packages/application/src/ports/roundStore.ts`
- Modify: `packages/application/src/rounds/joinRound.ts` (return, ~line 78)
- Modify: `packages/application/src/rounds/mintParticipantToken.ts`
- Modify: `packages/application/src/rounds/joinRound.test.ts`, `packages/application/src/rounds/mintParticipantToken.test.ts` (+ every other fake implementing `RoundStore` — the compiler enumerates them)
- Modify: `packages/adapters-dynamodb/src/createDynamoRoundStore.ts`
- Modify: `packages/adapters-dynamodb/src/contract/store.contract.test.ts`
- Modify: `packages/lambda/src/compositionRoot.ts` (line ~300)
- Modify (mock sweep, Step 9): `apps/web/src/routes/HomePage.test.tsx`, `apps/web/src/round/RoundRecordPage.test.tsx`, `apps/web/src/routes/JoinRoundPage.test.tsx`, `apps/web/src/api.test.ts`

**Interfaces:**
- Produces: `JoinRoundResponse.joinCode: string` (required); `RoundStore.getJoinCode(roundId: RoundId): Promise<string | undefined>`.
- Consumes: nothing from Task 1.

- [ ] **Step 1: Contracts.** In commands.ts:

```ts
export interface JoinRoundResponse {
  readonly roundId: RoundId;
  readonly token: string;
  readonly golferId: GolferId;
  // The round's join code — participant-scoped round metadata, delivered with the credential
  // (spec 2026-07-20 §2): holding a participant token means holding the code, on every door in
  // (join here, re-mint via POST /rounds/{roundId}/token; StartRoundResponse already carries it).
  readonly joinCode: string;
}
```

and `joinRoundResponseSchema` gains `joinCode: z.string(),`.

- [ ] **Step 2: Port.** roundStore.ts:

```ts
export interface RoundStore {
  createRound(meta: { roundId: RoundId; joinCode: string }): Promise<void>;
  findByJoinCode(code: string): Promise<RoundId | undefined>;
  // The reverse read of createRound's own meta item (spec 2026-07-20 §2: the join code is
  // round metadata served only to participants). `undefined` means no meta item exists —
  // an unknown/corrupt round — which callers surface as round-not-found.
  getJoinCode(roundId: RoundId): Promise<string | undefined>;
}
```

- [ ] **Step 3: Failing application tests.** In joinRound.test.ts, extend the existing happy-path response assertion with `expect(response.joinCode).toBe(<the code the test joins with>)`. In mintParticipantToken.test.ts, give the fake store `getJoinCode: async () => "ABC123"`, assert the happy-path response carries `joinCode: "ABC123"`, and add one case: `getJoinCode: async () => undefined` → rejects with `ApplicationError` code `round-not-found`. Give every other `RoundStore` fake the new method (the typecheck failure list is the worklist; a fake whose use case never calls it may `getJoinCode: async () => undefined`).

Run: `pnpm --filter @swng/application exec vitest run src/rounds/joinRound.test.ts src/rounds/mintParticipantToken.test.ts`
Expected: FAIL (joinCode absent from both responses).

- [ ] **Step 4: Implement.** joinRound.ts return:

```ts
    // Echo, not a second read: findByJoinCode(command.code) just matched, so command.code IS
    // the canonical stored code (spec 2026-07-20 §2).
    return { roundId: id, token, golferId: golfer, joinCode: command.code };
```

mintParticipantToken.ts — deps gain `store: RoundStore` (import the type), and after the liveness check:

```ts
    // The join code rides the credential (spec 2026-07-20 §2): a device re-minting on a new
    // phone must leave knowing the round's code, or the Join code panel goes blank (the former
    // papercut 19). A round with events but no meta item is unknown/corrupt — same 404 as any
    // missing round.
    const joinCode = await deps.store.getJoinCode(id);
    if (joinCode === undefined) throw new ApplicationError("round-not-found");

    const token = deps.tokens.issue({ scope: "participant", roundId: id, golferId: found.golfer.id });
    return { roundId: id, token, golferId: found.golfer.id, joinCode };
```

- [ ] **Step 5: Application tests pass.**

Run: `pnpm --filter @swng/application exec vitest run src/rounds/joinRound.test.ts src/rounds/mintParticipantToken.test.ts`
Expected: PASS.

- [ ] **Step 6: Adapter.** createDynamoRoundStore.ts — add `GetCommand` to the lib-dynamodb import and:

```ts
    getJoinCode: async (roundId: RoundId) => {
      // Base-table read of createRound's meta item — ConsistentRead like every other base-table
      // read here (the GSI caveat above is findByJoinCode's alone).
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: roundPk(roundId), sk: metaSk },
          ConsistentRead: true,
        }),
      );
      const item = result.Item as { joinCode: string } | undefined;
      return item?.joinCode;
    },
```

- [ ] **Step 7: Contract tests.** In store.contract.test.ts, beside the existing createRound/findByJoinCode cases (match their harness idiom for store construction and RoundId minting):

```ts
  it("getJoinCode returns the code createRound stored", async () => {
    // mint a fresh RoundId + unique code the way the neighboring cases do
    await store.createRound({ roundId: id, joinCode: code });
    expect(await store.getJoinCode(id)).toBe(code);
  });

  it("getJoinCode returns undefined for an unknown round", async () => {
    expect(await store.getJoinCode(unknownId)).toBeUndefined();
  });
```

Run: `pnpm test:contract`
Expected: PASS (95 = 93 + 2).

- [ ] **Step 8: Lambda wiring.** compositionRoot.ts line ~300: `mintParticipantToken: mintParticipantToken({ journal, golferStore, tokens, store }),` (`store` is the `createDynamoRoundStore` instance already built at line ~243).

- [ ] **Step 9: Web test-mock sweep (required-field fallout).** Web tests construct typed/parsed `JoinRoundResponse`s, so the required field breaks them WITHOUT this step: `HomePage.test.tsx:280`'s `mockedMintParticipantToken.mockResolvedValue({…})` gains `joinCode: "FRESH1"` (typecheck); `RoundRecordPage.test.tsx:248`'s `fakeResponse(200, {…})` body gains `joinCode: "FRESH1"` (the real api schema parses it); `JoinRoundPage.test.tsx` / `api.test.ts` join fixtures likewise (the typecheck/parse failure list is the worklist). Assertions pinning the SAVED credential (e.g. `RoundRecordPage.test.tsx:259`'s `joinCode: ""`) stay UNCHANGED here — the save path still writes `""` until Task 3 flips it; Task 3 updates those assertions.

- [ ] **Step 10: Full gate.**

Run: `pnpm validate`
Expected: exit 0.

- [ ] **Step 11: Commit.**

```bash
git add packages/contracts/src/commands.ts packages/application/src/ports/roundStore.ts packages/application/src/rounds/joinRound.ts packages/application/src/rounds/joinRound.test.ts packages/application/src/rounds/mintParticipantToken.ts packages/application/src/rounds/mintParticipantToken.test.ts packages/adapters-dynamodb/src/createDynamoRoundStore.ts packages/adapters-dynamodb/src/contract/store.contract.test.ts packages/lambda/src/compositionRoot.ts
git commit -m "feat(contracts,application,adapters,lambda): joinCode rides every participant-token response — token implies code (spec 2026-07-20)"
```

(Plus any fake-store files the compiler surfaced in Step 3.)

---

### Task 3: Web — save the served code, render "Copy invite link"

**Files:**
- Modify: `apps/web/src/routes/JoinRoundPage.tsx` (line ~172)
- Modify: `apps/web/src/session/openLiveRound.ts`
- Modify: `apps/web/src/round/SetupPanel.tsx`
- Test: `apps/web/src/round/SetupPanel.test.tsx`; touch `JoinRoundPage.test.tsx` / HomePage / RoundRecordPage tests only where their mocked `JoinRoundResponse`s now need the required `joinCode` (compiler-led) or where they assert the saved credential.
- Modify: `apps/web/e2e/support.ts` (readJoinCode doc comment, lines ~767–777) — comment only; the helper body is already correct.

**Interfaces:**
- Consumes: `JoinRoundResponse.joinCode` (Task 2).
- Produces: no new exports; SetupPanel's props unchanged (it already takes `joinCode`).

- [ ] **Step 1: Failing SetupPanel tests.** Using ShareButton.test.tsx's clipboard stub idiom (`vi.stubGlobal("navigator", { clipboard: { writeText } })`) and SetupPanel.test.tsx's existing render helper:

```tsx
  it("Copy invite link copies the origin-relative join URL and shows Link copied with the url", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderPanel({ joinCode: "ABC123" }); // however the file's helper takes joinCode
    fireEvent.click(screen.getByRole("button", { name: "Copy invite link" }));
    await screen.findByText(/Link copied — /);
    const url = `${window.location.origin}/join?code=ABC123`;
    expect(writeText).toHaveBeenCalledWith(url);
    expect(screen.getByText(url)).toBeTruthy();
  });

  it("still shows the raw url with 'Copy this link' when clipboard access fails", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    renderPanel({ joinCode: "ABC123" });
    fireEvent.click(screen.getByRole("button", { name: "Copy invite link" }));
    await screen.findByText(/Copy this link — /);
    expect(screen.getByText(`${window.location.origin}/join?code=ABC123`)).toBeTruthy();
  });

  it("hides Copy invite link entirely on an empty cached code (legacy re-mint credential)", () => {
    renderPanel({ joinCode: "" });
    expect(screen.queryByRole("button", { name: "Copy invite link" })).toBeNull();
  });
```

Run: `pnpm --filter @swng/web exec vitest run src/round/SetupPanel.test.tsx`
Expected: FAIL (no such button).

- [ ] **Step 2: SetupPanel implementation.** Component state + handler (beside the existing editor state):

```tsx
  const [inviteUrl, setInviteUrl] = useState<string | undefined>(undefined);
  const [inviteCopied, setInviteCopied] = useState(false);

  const copyInviteLink = async () => {
    // The receiving path already exists whole: /join?code= seeds the form and survives the
    // sign-in round trip (returnTo). The link is derived from the code on this device's own
    // origin — never minted server-side (ShareButton's precedent).
    const url = `${window.location.origin}/join?code=${joinCode}`;
    setInviteUrl(url);
    setInviteCopied(false);
    try {
      await navigator.clipboard.writeText(url);
      setInviteCopied(true);
    } catch {
      // Clipboard denied/unavailable — the visible raw-url line below still lets the golfer
      // copy by hand (ShareButton's discipline: success is never only a vanished toast).
    }
  };
```

In the join-code panel, after the "Players join with this code…" `<p>`:

```tsx
        {joinCode !== "" && (
          <>
            {/* btnQuiet, never gold — AddGameForm's submit is this screen's one gold action. */}
            <button type="button" className={`${btnQuiet} mt-2 text-sm`} onClick={() => void copyInviteLink()}>
              Copy invite link
            </button>
            {inviteUrl && (
              <p className="mt-1 text-xs text-fairway">
                {inviteCopied ? "Link copied — " : "Copy this link — "}
                <span className="select-all font-mono">{inviteUrl}</span>
              </p>
            )}
          </>
        )}
```

The `joinCode !== ""` guard gets this comment: `Legacy tolerance, not a live state (spec 2026-07-20 §3): only a credential cached by a pre-fix re-mint entry holds an empty code; it dies on the next entry through any door.`

Run: `pnpm --filter @swng/web exec vitest run src/round/SetupPanel.test.tsx`
Expected: PASS.

- [ ] **Step 3: Save the served code.** JoinRoundPage.tsx:172 — `joinCode: upperCode` → `joinCode: response.joinCode` (update the comment above it: the server now echoes the canonical code; the typed form value is no longer the source). openLiveRound.ts:26 — `joinCode: ""` → `joinCode: response.joinCode`, and rewrite the stale comment sentence (`joinCode: "" because a re-mint outside the join flow carries no join code…`) to: `The re-mint response carries the round's join code (spec 2026-07-20 §2 — token implies code), so a device entering from home shows the Join code panel like any other; the former papercut-19 blank panel is unrepresentable.`

- [ ] **Step 4: Saved-credential assertion flips.** Task 2's Step 9 already gave the mocks their `joinCode`; now that the save paths write it, flip the assertions that pin the stored credential — `RoundRecordPage.test.tsx:259`'s `joinCode: ""` becomes the mocked response's code (`"FRESH1"`), and JoinRoundPage's save assertion pins `response.joinCode`, not the typed form value.

Run: `pnpm --filter @swng/web exec vitest run`
Expected: PASS.

- [ ] **Step 5: support.ts comment.** Rewrite readJoinCode's doc-comment paragraph that says the re-mint path renders a blank panel (lines ~767–777): the helper now works on EVERY entry path (spec 2026-07-20 §2); keep the layout-coupling caveat.

- [ ] **Step 6: Full gate + commit.**

Run: `pnpm validate`
Expected: exit 0.

```bash
git add apps/web/src/routes/JoinRoundPage.tsx apps/web/src/session/openLiveRound.ts apps/web/src/round/SetupPanel.tsx apps/web/src/round/SetupPanel.test.tsx apps/web/e2e/support.ts
git commit -m "feat(web): Copy invite link — the code is served with the credential, the blank panel dies (spec 2026-07-20)"
```

(Plus the compiler-surfaced test files.)

---

### Task 4: E2E reconciliation — the wire echo and the live proof

**Files:**
- Modify: `e2e/roundSlice.e2e.test.ts` (~line 100)
- Modify: `apps/web/e2e/handicapCorrection.spec.ts` (~lines 105–112)

**Interfaces:** consumes Task 2's wire field and Task 3's rendered panel; produces nothing.

- [ ] **Step 1: Root wire echo.** In roundSlice.e2e.test.ts, right after `const bo = await post(rounds("/join"), { code: joinCode, … })`:

```ts
    // The join response echoes the canonical code (spec 2026-07-20: token implies code); the
    // re-mint arm of the same invariant is proven in the browser (handicapCorrection.spec).
    expect(bo.joinCode).toBe(joinCode);
```

(Every join in the suite also now parses through the REQUIRED-field schema, so `e2e:beta` asserts presence on all 17 cases for free.)

- [ ] **Step 2: The live proof in the browser spec.** handicapCorrection.spec.ts enters its round via the `/rounds/:id` re-mint path and currently waits on the Roster heading BECAUSE the code panel rendered blank there. Keep the Roster wait (it's the landing signal), then ADD, using support.ts's `readJoinCode`:

```ts
    // The re-mint response now carries the code (spec 2026-07-20) — the panel renders it on
    // this entry path too, the live proof the former papercut-19 blank panel is dead.
    expect(await readJoinCode(page)).toBe(joinCode);
```

(`joinCode` is the code this spec's API seeding already holds; import `readJoinCode` if not already imported. Update the spec's own comment block ~105–110 that explains why readJoinCode could NOT be used here.)

- [ ] **Step 3: Typecheck the e2e workspaces + full gate.**

Run: `pnpm validate`
Expected: exit 0 (the specs compile; they run only against beta at close-out).

- [ ] **Step 4: Commit.**

```bash
git add e2e/roundSlice.e2e.test.ts apps/web/e2e/handicapCorrection.spec.ts
git commit -m "test(e2e): join echoes the code on the wire; the re-mint entry renders it live"
```

---

## Close-out (controller-run — not a task)

1. Whole-branch review (most capable model), fixes if any.
2. `pnpm validate` → `pnpm deploy:beta` (**lambda-first** — the new bundle's schema requires `joinCode`; the old bundle ignores the extra field) → `pnpm publish:web:beta`.
3. `pnpm e2e:beta` ×2 (the required field is asserted on every join) → `pnpm e2e:field`.
4. Adversarial USE pass on beta.swng.golf **with screenshots looked at as design artifacts** (the eyes-on-pixels rule): the reordered live page top to bottom; the aligned card with a long name; Cancel on the pad; Copy invite link tapped and the link actually joining a second account; a home-screen re-mint entry showing the code panel filled.
5. Docs sweep (CLAUDE.md arc paragraph, ledger), teardown of walk users.
