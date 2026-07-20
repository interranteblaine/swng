# Mid-Round Course Handicap Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A participant can correct any participant's course handicap during a live round; the correction re-strikes the whole round (dots, standings, archive) by construction.

**Architecture:** One new additive round event `participant-handicap-set { golferId, courseHandicap }` (subject/author split like `score-recorded`), folded as HLC-latest-vs-the-latest-join per golfer with presence untouched; one REST command `POST /rounds/{roundId}/handicap` (participant auth, server-minted envelope, `leaveRound` shape); one roster-row inline editor in `SetupPanel`. Everything downstream (dots, engines, AGS, settle, archive, record lines, watch) already reads the folded roster live — zero changes there.

**Tech Stack:** TypeScript ESM monorepo — `@swng/domain` (pure fold), `@swng/contracts` (Zod), `@swng/application` (use cases + in-memory fakes), `@swng/lambda` (declarative routes), `apps/infra-cdk` (route list), `apps/web` (React 19 + Vitest/happy-dom), root `e2e/` (wire) + `apps/web/e2e/` (Playwright). Binding spec: `docs/superpowers/specs/2026-07-20-mid-round-handicap-correction-design.md`.

## Global Constraints

- **Retroactive by construction:** no snapshotting of strokes anywhere — dots/engines/AGS/settle keep reading `participant.courseHandicap` from the fold. No change to `allocation.ts`, the engines, or `archive.ts`.
- **The event carries ONLY `golferId` + `courseHandicap`** (plus the shared envelope). It must be structurally unable to carry a name or tee (name-freeze holds by construction).
- **Presence untouched:** `departed` still resolves from {join, leave} only. A handicap-set never re-seats a departed golfer; correcting a departed golfer's CH must work.
- **Fold rule:** a set applies iff its hlc is strictly later than that golfer's `latestJoinHlc`; latest set wins among sets; a set with no folded join contributes nothing; commutative under permutation; opId-deduped (existing pass).
- **Server-minted envelope only** (`serverEnvelope`, authorId = caller). The client transport's `score-recorded`-only push guard (`packages/client/src/transport.ts`) is NOT touched.
- **Authority:** any participant may correct any participant (`requireParticipant` on author AND subject). Errors: existing codes only — `not-a-participant` (403), `round-not-live` (409). No new error codes.
- **Route:** `POST /rounds/{roundId}/handicap`, auth `participant`, success 200, response `{ events }` (append idiom). Route counts 37→38 HTTP (40 total). NOT added to the anonymous throttle set.
- **Teaching line, verbatim:** `Strokes apply to the whole round — dots and games update everywhere.`
- **CH display always through `formatCourseHandicap`;** the editor's `<input>` holds the raw signed integer (the plus-handicap gate's editable-input carve-out).
- `pnpm validate` green at every commit.

---

### Task 1: Domain — the `participant-handicap-set` event and fold rule

**Files:**
- Modify: `packages/domain/src/round/events.ts` (add the arm after `participant-left`)
- Modify: `packages/domain/src/round/state.ts` (fold rule in the participants register, §4)
- Test: `packages/domain/src/round/state.test.ts`
- Test: `packages/domain/src/round/archive.test.ts` (settle passthrough)
- Modify: `packages/domain/src/round/state.properties.test.ts` (add the arm to the event generator)

**Interfaces:**
- Produces: `RoundEvent` gains `{ kind: "participant-handicap-set"; golferId: GolferId; courseHandicap: number }` — Tasks 2–6 depend on this exact shape and kind string.

- [ ] **Step 1: Write the failing fold tests**

Append to `packages/domain/src/round/state.test.ts` (harness at the top of the file: `base(wallMs)`, `genesis`, `joinA` seats A with `courseHandicap: 8`, `at(wallMs, device)`):

```ts
describe("participant-handicap-set", () => {
  const setA = (wallMs: number, courseHandicap: number): RoundEvent => ({ ...base(wallMs), kind: "participant-handicap-set", golferId: A, courseHandicap });

  it("a set later than the join overrides the seat's courseHandicap in place", () => {
    const state = reduceRound([genesis, joinA, started, setA(10, 13)]);
    const seat = state.participants.find((p) => p.golferId === A);
    expect(seat?.courseHandicap).toBe(13);
    // Everything else about the seat is the join's own data, untouched.
    expect(seat?.name).toBe("Ann");
    expect(seat?.tee).toBe("white");
  });

  it("is order-independent: the set folds identically wherever it lands in arrival order", () => {
    const events = [genesis, joinA, started, setA(10, 13)];
    const shuffled = [events[3], events[0], events[2], events[1]] as RoundEvent[];
    expect(reduceRound(shuffled)).toEqual(reduceRound(events));
  });

  it("latest set wins among multiple sets, including a plus-handicap value", () => {
    const state = reduceRound([genesis, joinA, started, setA(10, 13), setA(11, -2)]);
    expect(state.participants.find((p) => p.golferId === A)?.courseHandicap).toBe(-2);
  });

  it("a REJOIN later than a set wins — the fresh join's CH applies", () => {
    const leave: RoundEvent = { ...base(11), kind: "participant-left", golferId: A };
    const rejoin: RoundEvent = { ...base(12), kind: "participant-joined", participant: { golferId: A, name: "Ann", tee: "white", courseHandicap: 20 } };
    const state = reduceRound([genesis, joinA, started, setA(10, 13), leave, rejoin]);
    const seat = state.participants.find((p) => p.golferId === A);
    expect(seat?.courseHandicap).toBe(20);
    expect(seat?.departed).toBeUndefined();
  });

  it("a set earlier than the latest join loses to that join", () => {
    const leave: RoundEvent = { ...base(11), kind: "participant-left", golferId: A };
    const rejoin: RoundEvent = { ...base(13), kind: "participant-joined", participant: { golferId: A, name: "Ann", tee: "white", courseHandicap: 20 } };
    // Set minted between the leave and the rejoin — the rejoin's later hlc supersedes it.
    const state = reduceRound([genesis, joinA, started, leave, setA(12, 13), rejoin]);
    expect(state.participants.find((p) => p.golferId === A)?.courseHandicap).toBe(20);
  });

  it("corrects a DEPARTED golfer's CH without re-seating them", () => {
    const leave: RoundEvent = { ...base(11), kind: "participant-left", golferId: A };
    const state = reduceRound([genesis, joinA, started, leave, setA(12, 13)]);
    const seat = state.participants.find((p) => p.golferId === A);
    expect(seat?.courseHandicap).toBe(13);
    expect(seat?.departed).toBe(true); // presence untouched — the set is not a join
  });

  it("a set for a golfer with no folded join contributes nothing and never throws", () => {
    const setB: RoundEvent = { ...base(10), kind: "participant-handicap-set", golferId: B, courseHandicap: 5 };
    const state = reduceRound([genesis, joinA, started, setB]);
    expect(state.participants.map((p) => p.golferId)).toEqual([A]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F @swng/domain vitest run src/round/state.test.ts`
Expected: FAIL — TypeScript error on the unknown event kind (the union rejects `"participant-handicap-set"`).

- [ ] **Step 3: Add the event arm**

In `packages/domain/src/round/events.ts`, after the `participant-left` arm:

```ts
    // Mid-round course handicap correction (spec 2026-07-20): a NARROW, dedicated event —
    // deliberately NOT a second participant-joined, which is a presence fact (a later join
    // clears `departed`; that's what makes rejoin work) and carries the whole seat. This arm
    // carries ONLY the number, so a correction structurally cannot rewrite a card name or tee
    // and never touches presence. `golferId` is the SUBJECT (whose handicap); `authorId` (the
    // envelope) is who recorded it — the score-recorded split; any participant may correct any
    // participant (the score-for-anyone trust model), enforced at the API layer, not here.
    // Additive/append-only, like every arm before it.
    | { readonly kind: "participant-handicap-set"; readonly golferId: GolferId; readonly courseHandicap: number }
```

- [ ] **Step 4: Implement the fold rule**

In `packages/domain/src/round/state.ts`, participants register (§4). Add a latest-set map alongside `leavesByGolfer`, fed in the same scan loop:

```ts
  const seatByGolfer = new Map<GolferId, { participant: Participant; latestJoinHlc: Hlc; firstHlc: Hlc }>();
  const leavesByGolfer = new Map<GolferId, Hlc>();
  // Handicap corrections (spec 2026-07-20): latest set per golfer by the same HLC total order.
  // Applied below iff strictly later than that golfer's latest join — a rejoin's fresh CH
  // supersedes an older correction. A set with no folded join waits here harmlessly (no seat
  // to apply to), exactly like a leave-before-join: what keeps the fold commutative.
  const handicapSetsByGolfer = new Map<GolferId, { courseHandicap: number; hlc: Hlc }>();
  for (const event of deduped) {
    if (event.kind === "participant-joined") {
      const existing = seatByGolfer.get(event.participant.golferId);
      seatByGolfer.set(event.participant.golferId, { participant: event.participant, latestJoinHlc: event.hlc, firstHlc: existing?.firstHlc ?? event.hlc });
    } else if (event.kind === "participant-left") {
      const existing = leavesByGolfer.get(event.golferId);
      if (!existing || compareHlc(event.hlc, existing) > 0) leavesByGolfer.set(event.golferId, event.hlc);
    } else if (event.kind === "participant-handicap-set") {
      const existing = handicapSetsByGolfer.get(event.golferId);
      if (!existing || compareHlc(event.hlc, existing.hlc) > 0) handicapSetsByGolfer.set(event.golferId, { courseHandicap: event.courseHandicap, hlc: event.hlc });
    }
  }
  const participants: RosterEntry[] = [...seatByGolfer.values()]
    .sort((a, b) => compareHlc(a.firstHlc, b.firstHlc) || (a.participant.golferId < b.participant.golferId ? -1 : a.participant.golferId > b.participant.golferId ? 1 : 0))
    .map(({ participant, latestJoinHlc }) => {
      const set = handicapSetsByGolfer.get(participant.golferId);
      // Seat data stays the join's own payload; ONLY courseHandicap is correctable, and only by
      // a set strictly later than the latest join (presence and CH are separate concerns — a
      // set never clears `departed`, and a rejoin always re-asserts its own typed CH).
      const seat = set !== undefined && compareHlc(set.hlc, latestJoinHlc) > 0 ? { ...participant, courseHandicap: set.courseHandicap } : participant;
      const leaveHlc = leavesByGolfer.get(participant.golferId);
      const departed = leaveHlc !== undefined && compareHlc(leaveHlc, latestJoinHlc) > 0;
      return departed ? { ...seat, departed: true } : seat;
    });
```

Also update the §4 doc comment above the block: append one sentence — "Handicap corrections layer the same way: `participant-handicap-set` overrides the seat's courseHandicap iff strictly later than the latest join, touching neither presence nor any other seat field."

- [ ] **Step 5: Run the fold tests**

Run: `pnpm -F @swng/domain vitest run src/round/state.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 6: Settle passthrough test**

Append to `packages/domain/src/round/archive.test.ts`, using that file's existing fixture idiom (a finalizable log builder exists in the file — reuse its genesis/join/score/finalize fixtures; adapt names to the file's own):

```ts
it("settles the CORRECTED courseHandicap into archive.participants and handicapping", () => {
  // Take the file's existing minimal finalizable log (genesis + join + started + full scores +
  // round-finalized) and inject one participant-handicap-set for the joined golfer, minted
  // between started and the scores, with a value different from the join's.
  // Assert: settleRound(log).participants[0].courseHandicap === the corrected value, and the
  // golfer's handicapping entry (AGS path) reflects the corrected CH via handicappingFor.
});
```

Write it as real code against the file's actual fixtures (they exist — mirror the adjacent settle tests). The assertion targets: `archive.participants` carries the corrected CH; if the file's fixtures make an AGS assertion convenient, assert the `handicapping` entry changed accordingly (net-double-bogey caps depend on CH).

- [ ] **Step 7: Property suite**

In `packages/domain/src/round/state.properties.test.ts`, find the arbitrary-event generator (it enumerates event kinds — the `participant-left` arm is the template) and add a `participant-handicap-set` generator arm (random seated-or-not golferId, small int CH incl. negatives). The commutativity/idempotency properties then cover the new arm automatically.

Run: `pnpm -F @swng/domain vitest run src/round/state.properties.test.ts`
Expected: PASS.

- [ ] **Step 8: Full domain suite + commit**

Run: `pnpm -F @swng/domain test`
Expected: PASS.

```bash
git add packages/domain/src/round/events.ts packages/domain/src/round/state.ts packages/domain/src/round/state.test.ts packages/domain/src/round/archive.test.ts packages/domain/src/round/state.properties.test.ts
git commit -m "feat(domain): participant-handicap-set — a narrow correction event, presence untouched"
```

---

### Task 2: Contracts — the wire arm + command schemas

**Files:**
- Modify: `packages/contracts/src/round.ts` (event union arm + `SetHandicapResponse`)
- Modify: `packages/contracts/src/commands.ts` (`setHandicapRequestSchema`)
- Test: the contracts package's existing round/commands test files (extend in place)

**Interfaces:**
- Consumes: Task 1's event shape.
- Produces: `setHandicapRequestSchema` / `SetHandicapRequest` (`{ golferId, courseHandicap }`), `SetHandicapResponse` / `setHandicapResponseSchema` (`{ events }`) — Tasks 3–5 import these exact names from `@swng/contracts`.

- [ ] **Step 1: Failing round-trip test**

In the contracts test file that exercises `roundEventSchema` (find the existing `participant-left` parse case and sit beside it):

```ts
it("parses participant-handicap-set (incl. a plus-handicap negative value)", () => {
  const event = {
    opId: "op-1", hlc: { wallMs: 5, counter: 0, deviceId: "d1" }, authorId: "g-author",
    kind: "participant-handicap-set", golferId: "g-subject", courseHandicap: -2,
  };
  expect(roundEventSchema.parse(event)).toEqual(event);
});
```

Run: the contracts test command (`pnpm -F @swng/contracts test`)
Expected: FAIL (unknown discriminator value).

- [ ] **Step 2: Add the wire arm**

In `packages/contracts/src/round.ts`, after the `participant-left` arm of `roundEventSchemaImpl`:

```ts
  // Mid-round handicap correction (spec 2026-07-20): additive/append-only, like every arm
  // above. Carries ONLY the number — structurally cannot rewrite a name or tee. `golferId` is
  // the SUBJECT; `authorId` (envelope) is who recorded it. An OLD deployed bundle that pulls a
  // log containing this kind fails the union parse until refresh — the accepted stale-bundle
  // window (cleared-score precedent), open only once someone in the round used the new editor.
  z.object({ ...envelope, kind: z.literal("participant-handicap-set"), golferId: golferIdSchema, courseHandicap: z.number().int() }),
```

The `roundEventSchema: z.ZodType<RoundEvent>` alias now type-checks against Task 1's union — if it errors, the shapes drifted; fix the schema, never the domain.

- [ ] **Step 3: Add the command schemas**

In `packages/contracts/src/commands.ts`, after `recordScoreRequestSchema`:

```ts
// POST /rounds/{roundId}/handicap (spec 2026-07-20): any participant corrects any participant —
// the score-for-anyone trust model, so the SUBJECT rides the body while the author is the
// token's own golferId. The server minds the envelope (server-minted, like join/leave); the
// value may be negative (plus handicap), and the correction is retroactive by construction.
export const setHandicapRequestSchema = z.object({
  golferId: golferIdSchema,
  courseHandicap: z.number().int(),
});
export type SetHandicapRequest = z.infer<typeof setHandicapRequestSchema>;
```

In `packages/contracts/src/round.ts`, after `leaveRoundResponseSchema` (the append idiom):

```ts
// POST /rounds/{roundId}/handicap: response mirrors leaveRound's append idiom — `events`
// carries exactly what THIS call appended (the one participant-handicap-set), seq-stamped.
export interface SetHandicapResponse {
  readonly events: readonly RoundEvent[];
}

export const setHandicapResponseSchema: z.ZodType<SetHandicapResponse> = z.object({
  events: z.array(roundEventSchema).readonly(),
});
```

Confirm the package barrel (`packages/contracts/src/index.ts`) re-exports both files' names already (it exports whole modules — verify, add if the barrel is per-name).

- [ ] **Step 4: Request-schema test + parity**

Beside the join/record request tests:

```ts
it("setHandicapRequestSchema: accepts a negative (plus) value, rejects a non-integer", () => {
  expect(setHandicapRequestSchema.parse({ golferId: "g1", courseHandicap: -2 })).toEqual({ golferId: "g1", courseHandicap: -2 });
  expect(() => setHandicapRequestSchema.parse({ golferId: "g1", courseHandicap: 12.4 })).toThrow();
});
```

Run: `pnpm -F @swng/contracts test`
Expected: PASS — including the existing impl/domain parity check, which now covers the new arm by construction.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/round.ts packages/contracts/src/commands.ts packages/contracts/src/*.test.ts
git commit -m "feat(contracts): participant-handicap-set wire arm + SetHandicap command schemas"
```

---

### Task 3: Application — the `setHandicap` use case

**Files:**
- Create: `packages/application/src/rounds/setHandicap.ts`
- Test: `packages/application/src/rounds/setHandicap.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2 (`SetHandicapRequest`/`SetHandicapResponse`, the event kind), `requireParticipant`, `loadRoundState`, `serverEnvelope`/`createServerHlcSource`, ports `EventJournal`/`Broadcast`/`Clock`/`IdGenerator`.
- Produces: `setHandicap(deps)(claims, request)` — Task 4 wires it into `UseCases` and `compositionRoot`.

- [ ] **Step 1: Failing use-case tests**

Create `packages/application/src/rounds/setHandicap.test.ts` — copy `leaveRound.test.ts`'s harness verbatim (`createTestTokenIssuer`, `createClientOps`, `setup`, `freshLiveRound` — Ann CH 8, Bo CH 2), add `setHandicap` to `setup`'s returned use cases (`set: setHandicap({ journal, broadcast, clock, ids })`), then these cases:

```ts
describe("setHandicap — any participant corrects any participant", () => {
  it("appends exactly one participant-handicap-set (author = caller, subject = body), broadcasts it, and the fold shows the corrected CH", async () => {
    const round = await freshLiveRound();

    const result = await round.set(round.hostClaims, { golferId: round.bo.golferId, courseHandicap: 13 });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ kind: "participant-handicap-set", golferId: round.bo.golferId, courseHandicap: 13, authorId: round.host.golferId });
    expect(round.broadcast.calls.some((call) => call.events.some((event) => event.kind === "participant-handicap-set"))).toBe(true);

    const { state } = await loadRoundState(round.journal, round.host.roundId);
    expect(state.participants.find((p) => p.golferId === round.bo.golferId)?.courseHandicap).toBe(13);
    // The seat's name/tee are untouched — the event cannot carry them.
    expect(state.participants.find((p) => p.golferId === round.bo.golferId)?.tee).toBe("white");
  });

  it("accepts a plus handicap (negative int) and self-correction", async () => {
    const round = await freshLiveRound();
    await round.set(round.boClaims, { golferId: round.bo.golferId, courseHandicap: -2 });
    const { state } = await loadRoundState(round.journal, round.host.roundId);
    expect(state.participants.find((p) => p.golferId === round.bo.golferId)?.courseHandicap).toBe(-2);
  });

  it("corrects a DEPARTED participant without re-seating them", async () => {
    const round = await freshLiveRound();
    await round.leave(round.boClaims);
    await round.set(round.hostClaims, { golferId: round.bo.golferId, courseHandicap: 13 });
    const { state } = await loadRoundState(round.journal, round.host.roundId);
    const bo = state.participants.find((p) => p.golferId === round.bo.golferId);
    expect(bo?.courseHandicap).toBe(13);
    expect(bo?.departed).toBe(true);
  });
});

describe("setHandicap — guards", () => {
  it("throws not-a-participant when the AUTHOR is not seated", async () => {
    const round = await freshLiveRound();
    const stranger: ParticipantClaims = { roundId: round.host.roundId, golferId: golferId("stranger") };
    await expect(round.set(stranger, { golferId: round.bo.golferId, courseHandicap: 13 })).rejects.toMatchObject({ code: "not-a-participant" });
  });

  it("throws not-a-participant when the SUBJECT is not seated", async () => {
    const round = await freshLiveRound();
    await expect(round.set(round.hostClaims, { golferId: golferId("stranger"), courseHandicap: 13 })).rejects.toMatchObject({ code: "not-a-participant" });
  });

  it("throws round-not-live once the round is final", async () => {
    const round = await freshLiveRound();
    const annPhone = createClientOps("ann-phone");
    const boPhone = createClientOps("bo-phone");
    for (let hole = 1; hole <= 9; hole += 1) {
      await round.record(round.hostClaims, { golferId: round.host.golferId, hole, result: { kind: "strokes", strokes: 4 }, ...annPhone() });
      await round.record(round.boClaims, { golferId: round.bo.golferId, hole, result: { kind: "strokes", strokes: 4 }, ...boPhone() });
    }
    await round.finalize(round.hostClaims);
    await expect(round.set(round.hostClaims, { golferId: round.bo.golferId, courseHandicap: 13 })).rejects.toMatchObject({ code: "round-not-live" });
  });
});
```

Run: `pnpm -F @swng/application vitest run src/rounds/setHandicap.test.ts`
Expected: FAIL (module doesn't exist).

- [ ] **Step 2: Implement the use case**

Create `packages/application/src/rounds/setHandicap.ts`:

```ts
import type { SetHandicapRequest, SetHandicapResponse } from "@swng/contracts";
import { ApplicationError } from "../errors.js";
import type { Broadcast } from "../ports/broadcast.js";
import type { Clock } from "../ports/clock.js";
import type { EventJournal } from "../ports/eventJournal.js";
import type { IdGenerator } from "../ports/idGenerator.js";
import type { ParticipantClaims } from "../ports/tokenIssuer.js";
import { requireParticipant } from "../scoringPolicy.js";
import { loadRoundState } from "./loadRoundState.js";
import { createServerHlcSource, serverEnvelope } from "./serverEnvelope.js";

// Mid-round course handicap correction (spec 2026-07-20). Any participant corrects any
// participant — the score-for-anyone trust model, so the SUBJECT rides the body while the
// author is the token's own golferId (the same split score-recorded uses). requireParticipant
// on BOTH: isParticipant is seat-based, so a DEPARTED subject still passes — deliberately: a
// player who left after 12 holes still counts in every game, and their mis-struck holes
// deserve the fix. The correction is retroactive by construction (the fold + every compute
// read live CH); shaped exactly like leaveRound — a connected, online round act,
// server-envelope-stamped, gated by round-not-live like every other participant append.
export const setHandicap =
  (deps: { journal: EventJournal; broadcast: Broadcast; clock: Clock; ids: IdGenerator }) =>
  async (claims: ParticipantClaims, request: SetHandicapRequest): Promise<SetHandicapResponse> => {
    const { state } = await loadRoundState(deps.journal, claims.roundId);
    requireParticipant(state, claims.golferId);
    requireParticipant(state, request.golferId);
    if (state.status !== "live") throw new ApplicationError("round-not-live");

    const hlc = createServerHlcSource(deps.clock);
    const result = await deps.journal.append(claims.roundId, [
      { kind: "participant-handicap-set", golferId: request.golferId, courseHandicap: request.courseHandicap, ...serverEnvelope({ hlc, ids: deps.ids }, claims.golferId) },
    ]);
    await deps.broadcast.publish(claims.roundId, result.appended);
    return { events: result.appended };
  };
```

- [ ] **Step 3: Run the tests**

Run: `pnpm -F @swng/application vitest run src/rounds/setHandicap.test.ts`
Expected: PASS.

- [ ] **Step 4: Full application suite + commit**

Run: `pnpm -F @swng/application test`
Expected: PASS.

```bash
git add packages/application/src/rounds/setHandicap.ts packages/application/src/rounds/setHandicap.test.ts
git commit -m "feat(application): setHandicap — any participant corrects any participant, live rounds only"
```

---

### Task 4: Lambda route + infra route list

**Files:**
- Modify: `packages/lambda/src/http/routes.ts` (`UseCases` + route entry, after the leave route)
- Modify: `packages/lambda/src/compositionRoot.ts` (wire `setHandicap` beside `leaveRound`, line ~285)
- Modify: `packages/lambda/src/http/dispatch.test.ts` (the test wiring at ~line 176 constructs real use cases — add `setHandicap` the same way; add a dispatch case)
- Modify: `apps/infra-cdk/lib/swngStack.ts` (`HTTP_ROUTES` gains the entry)
- Test: run the lambda + infra suites; update any route-count pin that fails (counts derive from `HTTP_ROUTES.length`; docs record 37→38 HTTP / 40 total)

**Interfaces:**
- Consumes: Task 3's `setHandicap`, Task 2's schemas.
- Produces: `POST /rounds/{roundId}/handicap` live on the dispatcher — Task 5's `api.setHandicap` and Task 6's e2e call it.

- [ ] **Step 1: Failing dispatch test**

In `packages/lambda/src/http/dispatch.test.ts`, beside the leave-route case (mirror its request-building idiom — participant token, path params):

```ts
it("POST /rounds/{roundId}/handicap: participant auth, 200, appends the correction", async () => {
  // Mirror the leave-route test's setup: start a round, join a second participant, then POST
  // { golferId: <second participant>, courseHandicap: 13 } with the FIRST participant's token.
  // Assert 200, body.events[0].kind === "participant-handicap-set", and a follow-up
  // GET /rounds/{roundId}/events shows the event.
});
```

Write as real code against the file's actual harness (the leave test is the template). Also assert the spectator-token failure path if the file has that idiom for other participant routes (a spectator token on this route → 403 `read-only-token`) — only if an adjacent route test does the same; do not invent new harness machinery.

Run: `pnpm -F @swng/lambda vitest run src/http/dispatch.test.ts`
Expected: FAIL (route not found / UseCases missing member).

- [ ] **Step 2: Wire the route**

`packages/lambda/src/http/routes.ts` — `UseCases` gains (beside `leaveRound`):

```ts
  setHandicap: (claims: ParticipantClaims, request: SetHandicapRequest) => Promise<SetHandicapResponse>;
```

Route table, immediately after the leave entry:

```ts
  {
    method: "POST",
    path: "/rounds/{roundId}/handicap",
    schema: setHandicapRequestSchema,
    auth: "participant", // spec 2026-07-20: any participant corrects any participant (score-for-anyone).
    successStatus: 200, // an act on an existing round (appends participant-handicap-set), not a mint — same 200 spirit as leave/finalize.
    handler: async (ctx, body) => useCases.setHandicap(ctx.claims!, body as SetHandicapRequest),
  },
```

`packages/lambda/src/compositionRoot.ts`, beside leaveRound:

```ts
    setHandicap: setHandicap({ journal, broadcast, clock, ids }),
```

`apps/infra-cdk/lib/swngStack.ts` `HTTP_ROUTES`, beside the leave entry:

```ts
  { method: HttpMethod.POST, path: "/rounds/{roundId}/handicap" },
```

- [ ] **Step 3: Run lambda + infra suites**

Run: `pnpm -F @swng/lambda test && pnpm -F infra-cdk test` (use the infra package's actual name from its package.json if different)
Expected: PASS after fixing any route-count pin the suites hold (the stack test derives from `HTTP_ROUTES.length`; if a literal count is pinned anywhere, 37→38 HTTP / 40 total). The route must NOT be added to the anonymous throttle set.

- [ ] **Step 4: Commit**

```bash
git add packages/lambda/src/http/routes.ts packages/lambda/src/compositionRoot.ts packages/lambda/src/http/dispatch.test.ts apps/infra-cdk/lib/swngStack.ts apps/infra-cdk/test/swngStack.test.ts
git commit -m "feat(lambda,infra): POST /rounds/{roundId}/handicap — participant-gated correction route (38 HTTP)"
```

---

### Task 5: Web — the roster-row editor

**Files:**
- Modify: `apps/web/src/api.ts` (`setHandicap`)
- Modify: `apps/web/src/round/SetupPanel.tsx` (per-row Edit affordance + inline editor + `onSetHandicap` prop)
- Modify: `apps/web/src/routes/RoundPage.tsx` (wire the prop: api call + `await sync()`)
- Test: `apps/web/src/round/SetupPanel.test.tsx`, `apps/web/src/api.test.ts` (if it pins per-fn parsing — mirror the leave entry)

**Interfaces:**
- Consumes: Task 2's `SetHandicapRequest`/`setHandicapResponseSchema`, Task 4's route.
- Produces: `SetupPanelProps.onSetHandicap: (golferId: GolferId, courseHandicap: number) => Promise<void>`.

- [ ] **Step 1: Failing component tests**

In `apps/web/src/round/SetupPanel.test.tsx` (the file's existing render harness + the plus-handicap describe at ~213 are the idiom source):

```ts
describe("SetupPanel — mid-round handicap correction (spec 2026-07-20)", () => {
  it("Edit opens an inline editor holding the raw signed CH, with the whole-round teaching line", async () => {
    // Render with a roster incl. a plus-handicap participant (courseHandicap: -2) and a spy
    // onSetHandicap. Click that row's "Edit" button (accessible name scoped to the row).
    // Assert: a spinbutton/textbox holds "-2" (the raw signed value — the editable-input
    // carve-out), and the text "Strokes apply to the whole round — dots and games update
    // everywhere." renders.
  });

  it("Save submits the parsed signed integer for THAT golfer and closes the editor", async () => {
    // Type "13" (replacing the value), click Save, assert onSetHandicap called once with
    // (thatGolferId, 13); after the promise resolves the editor is gone and the static
    // "CH ..." row shows again (the corrected value arrives via the fold, not local state —
    // assert the spy, not the row text).
  });

  it("Cancel restores the static row without calling onSetHandicap", async () => {
    // Open the editor, type a new value, click Cancel. Assert: onSetHandicap never called,
    // the input is gone, and the row's static "CH ..." text renders unchanged.
  });

  it("a failed save surfaces the error text and keeps the editor open", async () => {
    // onSetHandicap rejects; assert the file's existing error-copy idiom renders.
  });
});
```

Write these as real code against the file's actual harness (its existing tests build `RoundState` fixtures and use testing-library queries — mirror them; drive the picker/inputs by accessible name, the e2e-reconciliation lesson).

Run: `pnpm -F @swng/web vitest run src/round/SetupPanel.test.tsx`
Expected: FAIL (no Edit affordance, no prop).

- [ ] **Step 2: api.setHandicap**

In `apps/web/src/api.ts`, beside `leaveRound` (imports from `@swng/contracts`: `setHandicapResponseSchema`, types `SetHandicapRequest`/`SetHandicapResponse`):

```ts
// POST /rounds/{roundId}/handicap (spec 2026-07-20): any participant corrects any participant's
// course handicap mid-round; the correction is retroactive by construction (dots, standings,
// and the eventual archive all read the folded roster). Append idiom — the response carries the
// one participant-handicap-set this call appended; the caller sync()s and lets the fold render.
export const setHandicap = async (roundId: RoundId, token: string, request: SetHandicapRequest): Promise<SetHandicapResponse> => {
  const json = await requestJson(`/rounds/${roundId}/handicap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), token });
  return parse(setHandicapResponseSchema, json);
};
```

- [ ] **Step 3: SetupPanel editor**

`apps/web/src/round/SetupPanel.tsx` — add to props:

```ts
  // Mid-round handicap correction (spec 2026-07-20): the roster row is the editor. Implemented
  // by RoundPage as api.setHandicap + sync() — no optimistic local write; the corrected CH
  // arrives via the fold like every roster fact.
  readonly onSetHandicap: (golferId: GolferId, courseHandicap: number) => Promise<void>;
```

Roster row: keep the identity line byte-identical; add an "Edit" button (btnSecondary-family idiom, small) after the CH span. Local state: `editing: GolferId | undefined`, `value: string`, `error: string | undefined`, `saving: boolean`. When `editing === p.golferId`, render in place of the static CH span:

```tsx
<span className="inline-flex items-center gap-2">
  <input
    type="number"
    inputMode="numeric"
    aria-label={`Course handicap for ${p.name}`}
    className={`${inputBox} w-16`}
    value={value}
    onChange={(e) => setValue(e.target.value)}
  />
  <button type="button" className={btnPrimarySmallIdiom} disabled={saving || !isValidInt(value)} onClick={save}>Save</button>
  <button type="button" className={btnSecondarySmallIdiom} onClick={cancel}>Cancel</button>
</span>
```

plus, under the row while editing, the teaching line (exact copy, `text-sm text-fairway`):

`Strokes apply to the whole round — dots and games update everywhere.`

and the file's error idiom when `error` is set. `save` parses `parseInt(value, 10)` (reject NaN by disabling Save), calls `await onSetHandicap(p.golferId, parsed)`, closes on success, sets `error` from the caught message on failure. Use the ACTUAL button/input class idioms from `ui/classes.ts` (`inputBox`, the small-button composition other inline forms use — mirror AddGameForm's own buttons rather than inventing sizes). Departed rows keep the Edit affordance (spec: departed golfers are correctable).

- [ ] **Step 4: RoundPage wiring**

`apps/web/src/routes/RoundPage.tsx` — beside `onAddGame`'s definition, following the same api-then-sync pattern (and its comment style):

```tsx
const onSetHandicap = async (golferId: GolferId, courseHandicap: number) => {
  // Server-authored append, then sync() — the corrected CH re-strikes dots/standings when the
  // fold re-renders, matching every other mutation's sync()-then-let-the-fold-swap pattern.
  await setHandicap(roundId, credential.token, { golferId, courseHandicap });
  await sync();
};
```

Pass `onSetHandicap={onSetHandicap}` at the `SetupPanel` render site (line ~293). Update any other `SetupPanel` render/test sites the compiler flags.

- [ ] **Step 5: Run web suite**

Run: `pnpm -F @swng/web test`
Expected: PASS — including the plus-handicap whole-tree render gate (the new `<input>` value is the carved-out editable-input form; if the gate's pattern list needs the new expression registered, extend the carve-out THERE with a comment, never render a bare signed CH as text) and the scoring-surface linkless structural pin (SetupPanel is not a pinned file; no change expected).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/round/SetupPanel.tsx apps/web/src/routes/RoundPage.tsx apps/web/src/round/SetupPanel.test.tsx apps/web/src/api.test.ts
git commit -m "feat(web): roster-row course-handicap editor — one tap, whole-round correction"
```

---

### Task 6: e2e — the wire case and the browser spec

**Files:**
- Modify: `e2e/roundSlice.e2e.test.ts` (one wire-level case)
- Create: `apps/web/e2e/handicapCorrection.spec.ts`
- Reference (read, don't modify): `apps/web/e2e/support.ts`, `apps/web/e2e/unratedCourse.spec.ts` (structure template), `apps/web/e2e/fieldTest.spec.ts` (scoring/locator idioms)

**Interfaces:**
- Consumes: Tasks 4–5 deployed behavior (locally: the dispatch layer via the root suite's harness; in browser: the beta stack — these specs run at close-out, but must typecheck and reconcile against the Task 5 JSX now).

- [ ] **Step 1: Root e2e wire case**

In `e2e/roundSlice.e2e.test.ts`, following the file's existing start/join/score idioms (it exercises the deployed beta API):

```ts
it("corrects a course handicap mid-round: events carry it, the fold and archive reflect it", async () => {
  // 1. Start a round (host CH 8), join a second account (CH 2).
  // 2. Score hole 1 for both.
  // 3. POST /rounds/{roundId}/handicap as the HOST with { golferId: <second>, courseHandicap: 13 }.
  //    Assert 200 and events[0].kind === "participant-handicap-set".
  // 4. GET events → fold with reduceRound → the second seat's courseHandicap === 13, departed
  //    undefined, name/tee untouched.
  // 5. Score remaining holes, finalize, GET /rounds/{roundId}/archive → participants carry 13.
});
```

Write as real code with the file's actual helpers (account minting, `recordScoreDirect`-style ops — the file has its own local idioms; mirror the adjacent cases). Note the suite's test count moves 16→17: the close-out gate records `e2e:beta 17/17`.

- [ ] **Step 2: Browser spec**

Create `apps/web/e2e/handicapCorrection.spec.ts`, structured like `unratedCourse.spec.ts` (serial describe, `mintAccountGolfer` ×2, `ensureCourse` with a rated fixture card, `startRoundDirect`/`joinRoundDirect` for setup speed, then the browser for the beats under test):

Beats (assert each):
1. Account A (CH 9) starts a round on the seeded course; account B joins with a deliberately WRONG CH 2 (API setup). A's browser opens the round; add a net stroke-play game via the real picker (or `addGameDirect` — the game under test needs net standings, not picker coverage).
2. Score holes 1–2 for both through the real ScorePad. Record the hole-1 cell text for B (gross+net rendering) and the game chip/panel standing.
3. **The correction, through the real UI:** A opens the roster, taps Edit on B's row, sees the teaching line, replaces 2 with 13, Saves.
4. Assert retroactivity live: B's roster row shows `CH 13`; B's ALREADY-SCORED hole-1 cell now renders different net/dots than recorded in beat 2 (pin the exact expected strings by deriving from the fixture card's stroke indexes — the courseEntry.spec.ts hand-derivation discipline, not a loose "changed" assertion); the net stroke-play panel standing changed to the hand-derived value.
5. Finalize through the real dialog; the results/archived view shows B's corrected CH wherever the archived card renders it, and `getRoundArchive` (API) carries `courseHandicap: 13` for B.
6. Teardown: scrap nothing (finalized), minted users tracked via the standard ndjson teardown.

Verify every locator against Task 5's actual JSX (accessible names, the `aria-label={`Course handicap for ${name}`}` input) — the e2e-reconciliation lesson: string-level breakage is typecheck-invisible.

- [ ] **Step 3: Typecheck + lint the specs**

Run: `pnpm validate`
Expected: PASS (e2e specs compile; they RUN at close-out against beta, not here).

- [ ] **Step 4: Commit**

```bash
git add e2e/roundSlice.e2e.test.ts apps/web/e2e/handicapCorrection.spec.ts
git commit -m "test(e2e): mid-round handicap correction — wire case + browser spec with hand-derived retroactive pins"
```

---

## Close-out (controller-run, not a task)

Standard gate: `pnpm validate` → `deploy:beta` LAMBDA-FIRST (additive event + route; stale-bundle window per spec §7) → `publish:web:beta` → `pnpm e2e:beta` (now 17 cases) ×2 → `pnpm e2e:field` (all specs incl. the new one) → an adversarial USE pass on deployed beta.swng.golf exercising the real correction (wrong CH entered at join, corrected from the roster mid-round, dots visibly moving on a scored hole) → docs sweep (CLAUDE.md arc paragraph, spec close-out record).
