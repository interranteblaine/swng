import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { cellKey, compareHlc, deviceId, fixtureLinks, gameId, golferId, opId, reduceRound, roundId } from "@swng/domain";
import type { DeviceId, GameConfig, GolferId, HoleResult, OpId, RoundEvent } from "@swng/domain";
import { createRoundSession } from "./session.js";
import type { RoundSession } from "./session.js";
import { createSimServer } from "./testing/simServer.js";
import type { SimServer } from "./testing/simServer.js";

// M4 Task 4 — the convergence simulation: real RoundSessions (Tasks 1-3's client, unmodified)
// driven over an in-memory SimServer, proving every interleaving of offline windows,
// corrections, and duplicate/out-of-order wire delivery folds to the SAME state the server's
// own log folds to. This is the test that would have caught M3's same-instant-hlc-collision
// bug class on the CLIENT (a FROZEN-clock device and a SKEWED-BEHIND device are load-bearing
// below, not decoration).

const ROUND_ID = roundId("round-convergence");
const ANN_ID = golferId("ann");
const BO_ID = golferId("bo");
const SEED_DEVICE = deviceId("seed");

const toResult = (score: number | "picked-up"): HoleResult => (score === "picked-up" ? { kind: "picked-up" } : { kind: "strokes", strokes: score });

// The creation/join/game-added scaffolding a real StartRound/JoinRound/AddGame flow would
// append, built directly from domain primitives (packages/client may only import
// @swng/domain + @swng/contracts, lint-enforced) — same pattern as session.test.ts's
// buildServerLog, minus the seq stamping: SimServer.seed() assigns seq itself, mirroring how
// append() assigns it for every other event.
const buildSeedEvents = (): RoundEvent[] => {
  let wallMs = 1_000;
  const nextHlc = () => ({ wallMs: wallMs++, counter: 0, deviceId: SEED_DEVICE });
  let opCounter = 0;
  const nextOpId = (): OpId => opId(`seed-op-${(opCounter += 1)}`);
  const stableford: GameConfig = { kind: "stableford", id: gameId("game-1"), players: [ANN_ID, BO_ID] };

  return [
    { kind: "round-created", roundId: ROUND_ID, card: fixtureLinks, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "participant-joined", participant: { golferId: ANN_ID, name: "Ann", tee: "white", courseHandicap: 8 }, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "round-started", authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "participant-joined", participant: { golferId: BO_ID, name: "Bo", tee: "white", courseHandicap: 2 }, authorId: BO_ID, opId: nextOpId(), hlc: nextHlc() },
    { kind: "game-added", config: stableford, authorId: ANN_ID, opId: nextOpId(), hlc: nextHlc() },
  ];
};

// One real RoundSession wired to the sim server's transport for a given deviceId, plus
// harness-only instrumentation SimServer's own contract has no reason to expose: capturing
// the last socket batch delivered to THIS device so a "redeliver" op (duplicate wire
// delivery) can replay it without SimServer growing a bespoke method for a property-test-only
// concern.
interface DeviceHandle {
  readonly id: DeviceId;
  readonly golferId: GolferId;
  readonly session: RoundSession;
  setOnline(online: boolean): void;
  redeliver(): boolean; // true iff a non-empty batch was actually replayed (vs. a degenerate no-op)
}

const createDevice = async (server: SimServer, golfer: GolferId, deviceIdValue: DeviceId, clock: { now(): number }): Promise<DeviceHandle> => {
  const raw = server.transportFor(deviceIdValue);
  let lastBatch: readonly RoundEvent[] | undefined;
  let liveOnEvents: ((events: readonly RoundEvent[]) => void) | undefined;

  const transport = {
    push: raw.push,
    pull: raw.pull,
    openSocket: (onEvents: (events: readonly RoundEvent[]) => void, onClose: () => void, onOpen?: () => void) => {
      const wrapped = (events: readonly RoundEvent[]): void => {
        lastBatch = events;
        onEvents(events);
      };
      liveOnEvents = wrapped;
      return raw.openSocket(wrapped, onClose, onOpen);
    },
  };

  const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: golfer, deviceId: deviceIdValue, clock });

  return {
    id: deviceIdValue,
    golferId: golfer,
    session,
    setOnline: raw.setOnline,
    redeliver: () => {
      // lastBatch is only ever set from inside the wrapped openSocket callback, which
      // SimServer's broadcast() only invokes with a non-empty array (see simServer.ts:
      // `if (events.length === 0) return;`) — so its mere presence already means "a
      // non-empty batch," but the length check here stays explicit rather than relying on
      // that invariant silently.
      if (liveOnEvents && lastBatch && lastBatch.length > 0) {
        liveOnEvents(lastBatch);
        return true;
      }
      return false;
    },
  };
};

// Quiescence (brief's exact recipe): bring every device online, then sync() everyone twice.
// The first pass pushes every device's remaining outbox to the server; the second pass is
// what guarantees every device's pull picks up every OTHER device's first-pass push,
// regardless of what order the two passes visited devices in.
const quiesce = async (devices: readonly DeviceHandle[]): Promise<void> => {
  for (const device of devices) device.setOnline(true);
  for (const device of devices) await device.session.sync();
  for (const device of devices) await device.session.sync();
};

describe("N-device convergence — deterministic examples", () => {
  it("two devices converge after an offline window and a correction", async () => {
    const server = createSimServer();
    server.seed(buildSeedEvents());

    const ann = await createDevice(server, ANN_ID, deviceId("ann-phone"), { now: () => 10_000 });
    const bo = await createDevice(server, BO_ID, deviceId("bo-phone"), { now: () => 20_000 });
    const devices = [ann, bo];

    ann.session.connect();
    bo.session.connect();
    await ann.session.sync();
    await bo.session.sync();

    // Bo's offline window: three recordScore calls queue locally, nothing reaches the server.
    bo.setOnline(false);
    bo.session.recordScore(BO_ID, 1, toResult(4));
    bo.session.recordScore(BO_ID, 2, toResult(5));
    expect(bo.session.pending()).toBe(2);

    // Meanwhile Ann, still online, scores and confirms.
    ann.session.recordScore(ANN_ID, 1, toResult(5));
    await ann.session.sync();

    // Bo comes back online and reconnects, draining the offline queue.
    bo.setOnline(true);
    bo.session.connect();
    await bo.session.sync();

    // A correction: Bo rewrites Ann's hole-1 score after observing it (score-for-anyone).
    bo.session.recordScore(ANN_ID, 1, toResult(6));

    await quiesce(devices);

    const expected = reduceRound(server.log());
    expect(ann.session.state()).toEqual(expected);
    expect(bo.session.state()).toEqual(expected);
    expect(ann.session.pending()).toBe(0);
    expect(bo.session.pending()).toBe(0);
    expect(ann.session.rejected()).toEqual([]);
    expect(bo.session.rejected()).toEqual([]);
  });

  it("a FROZEN-clock device still produces climbing hlc counters that order correctly against the server log", async () => {
    const server = createSimServer();
    server.seed(buildSeedEvents());

    const frozen = await createDevice(server, ANN_ID, deviceId("frozen-phone"), { now: () => 5_000 });
    await frozen.session.sync(); // pulls genesis before this device records anything (otherwise reduceRound throws round-log-missing-genesis)

    frozen.session.recordScore(ANN_ID, 1, toResult(4));
    frozen.session.recordScore(ANN_ID, 2, toResult(5));
    frozen.session.recordScore(ANN_ID, 3, toResult(3));

    const hlc1 = frozen.session.state().cells[cellKey(ANN_ID, 1)]!.hlc;
    const hlc2 = frozen.session.state().cells[cellKey(ANN_ID, 2)]!.hlc;
    const hlc3 = frozen.session.state().cells[cellKey(ANN_ID, 3)]!.hlc;

    // The wall clock never advances, but the HLC send rule still climbs the counter on every
    // call — the exact mechanism the M3 bug class broke, and Task 1 fixed on the client.
    expect(hlc1.wallMs).toBe(5_000);
    expect(hlc2.wallMs).toBe(5_000);
    expect(hlc3.wallMs).toBe(5_000);
    expect(hlc1.counter).toBe(0);
    expect(hlc2.counter).toBe(1);
    expect(hlc3.counter).toBe(2);
    expect(compareHlc(hlc1, hlc2)).toBeLessThan(0);
    expect(compareHlc(hlc2, hlc3)).toBeLessThan(0);

    await quiesce([frozen]);
    expect(frozen.session.state()).toEqual(reduceRound(server.log()));
  });

  it("a SKEWED-BEHIND device's correction still wins the cell it corrects (the M3 receive-rule regression test)", async () => {
    const server = createSimServer();
    server.seed(buildSeedEvents());

    const writer = await createDevice(server, BO_ID, deviceId("bo-live-phone"), { now: () => 100_000 });
    writer.session.connect();
    await writer.session.sync();
    writer.session.recordScore(BO_ID, 5, toResult(4));
    await writer.session.sync(); // confirmed server-side

    // Five minutes behind the writer's clock.
    const skewed = await createDevice(server, ANN_ID, deviceId("ann-skewed-phone"), { now: () => 100_000 - 5 * 60 * 1000 });
    skewed.session.connect();
    await skewed.session.sync(); // pulls the writer's confirmed score; observe() floors the skewed source past it

    skewed.session.recordScore(BO_ID, 5, toResult(9)); // score-for-anyone correction to the SAME cell

    await quiesce([writer, skewed]);

    const expected = reduceRound(server.log());
    const winner = expected.cells[cellKey(BO_ID, 5)];
    expect(winner?.result).toEqual(toResult(9)); // the correction won, not the original write
    expect(winner?.recordedBy).toBe(ANN_ID);
    expect(writer.session.state()).toEqual(expected);
    expect(skewed.session.state()).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------------------

const CLOCK_KINDS = ["live", "frozen", "skewed-behind"] as const;
type ClockKind = (typeof CLOCK_KINDS)[number];

const RECORD_KINDS = ["record", "correct"] as const;
const SIMPLE_KINDS = ["goOffline", "comeOnline", "sync", "redeliver", "pullOutOfOrder"] as const;

interface RecordLikeOp {
  readonly kind: (typeof RECORD_KINDS)[number];
  readonly deviceIndex: number;
  readonly golferIndex: 0 | 1;
  readonly hole: number;
  readonly strokes: number;
}
interface SimpleOp {
  readonly kind: (typeof SIMPLE_KINDS)[number];
  readonly deviceIndex: number;
}
type ScheduleOp = RecordLikeOp | SimpleOp;

interface Schedule {
  readonly deviceCount: number;
  readonly clockKinds: readonly ClockKind[];
  readonly ops: readonly ScheduleOp[];
}

const scheduleArb: fc.Arbitrary<Schedule> = fc.integer({ min: 2, max: 4 }).chain((deviceCount) => {
  const deviceIndexArb = fc.integer({ min: 0, max: deviceCount - 1 });
  const opArb: fc.Arbitrary<ScheduleOp> = fc.oneof(
    fc.record({
      kind: fc.constantFrom(...RECORD_KINDS),
      deviceIndex: deviceIndexArb,
      golferIndex: fc.constantFrom(...([0, 1] as const)),
      hole: fc.integer({ min: 1, max: 9 }),
      strokes: fc.integer({ min: 1, max: 10 }),
    }),
    fc.record({
      kind: fc.constantFrom(...SIMPLE_KINDS),
      deviceIndex: deviceIndexArb,
    }),
  );
  return fc.record({
    deviceCount: fc.constant(deviceCount),
    clockKinds: fc.array(fc.constantFrom(...CLOCK_KINDS), { minLength: deviceCount, maxLength: deviceCount }),
    ops: fc.array(opArb, { minLength: 10, maxLength: 40 }),
  });
});

// 5 minutes — the exact M3-lesson skew (matches the deterministic example above); fixed
// rather than itself generated, so every "skewed-behind" device is a genuine instance of the
// bug class this task exists to catch, not a randomly-diluted one.
const SKEW_MS = 5 * 60_000;

const makeClock = (kind: ClockKind, trueClockRef: { value: number }): { now(): number } => {
  if (kind === "frozen") {
    const frozenAt = trueClockRef.value;
    return { now: () => frozenAt };
  }
  if (kind === "skewed-behind") return { now: () => trueClockRef.value - SKEW_MS };
  return { now: () => trueClockRef.value };
};

const golfersByIndex: readonly [GolferId, GolferId] = [ANN_ID, BO_ID];

// Fix-wave (review Finding 1) — aggregate effectiveness counters for the two socket-race
// ops, accumulated across the WHOLE fc.assert run (all `numRuns` schedules), not per
// schedule: op targeting (`deviceIndex`, and which op kind gets drawn) is uniformly random,
// so no single generated schedule is guaranteed to exercise either op meaningfully. Reset
// at the top of the `it` body below (not here at module scope) so a vitest rerun/watch-mode
// re-invocation of this same test never lets counts leak from a prior run.
let redeliverEffectiveCount = 0;
let pullOutOfOrderRacedCount = 0;

describe("N-device convergence property", () => {
  it("every generated interleaving of 2-4 devices folds to reduceRound(server.log())", async () => {
    redeliverEffectiveCount = 0;
    pullOutOfOrderRacedCount = 0;

    await fc.assert(
      fc.asyncProperty(scheduleArb, async (schedule) => {
        const server = createSimServer();
        server.seed(buildSeedEvents());

        // A deterministic logical wall clock — no Date.now(), no Math.random() anywhere in
        // this simulation. Advances a fixed step after every executed op so "live" devices'
        // stamps spread out over time the same way a real session's clock would.
        const trueClockRef = { value: 1_000_000 };
        const advanceTrueClock = (): void => {
          trueClockRef.value += 1_000;
        };

        const devices: DeviceHandle[] = [];
        for (let i = 0; i < schedule.deviceCount; i += 1) {
          const golfer = golfersByIndex[i % golfersByIndex.length]!;
          const clock = makeClock(schedule.clockKinds[i]!, trueClockRef);
          devices.push(await createDevice(server, golfer, deviceId(`sim-device-${i}`), clock));
        }
        // Every device connects (opens its socket) AND catches up before the schedule runs.
        // connect() mirrors real usage — a session always syncs at least once after
        // construction; recordScore before genesis is ever pulled is not a real client
        // scenario and reduceRound correctly refuses to fold a log with no round-created
        // event. Fix-wave (review Finding 1): connect() here too, not just via the
        // `comeOnline` op, so every device's socket is live from schedule start — otherwise
        // a device that never happens to draw `comeOnline` never opens a socket, `lastBatch`
        // never populates, and every `redeliver`/`pullOutOfOrder` targeting it silently
        // degenerates to a no-op regardless of what the property is meant to exercise.
        // Devices that later draw `goOffline` still lose the socket via onClose, and
        // `comeOnline` still reconnects it — that machinery is unchanged.
        for (const device of devices) {
          device.session.connect();
          await device.session.sync();
        }

        const mintedOpIds = new Set<OpId>();

        for (const op of schedule.ops) {
          const device = devices[op.deviceIndex % devices.length]!;
          switch (op.kind) {
            case "record":
            case "correct": {
              const golfer = golfersByIndex[op.golferIndex]!;
              device.session.recordScore(golfer, op.hole, { kind: "strokes", strokes: op.strokes });
              // The just-authored event's hlc is provably greater than everything this
              // device has ever stamped or observed (Task 1's send rule), so it is
              // guaranteed to be the CURRENT winner of this exact cell in this device's own
              // local fold right after the call — reading it back here is a reliable way to
              // recover the opId recordScore minted internally, without depending on its
              // internal counter/opId-naming scheme.
              const minted = device.session.state().cells[cellKey(golfer, op.hole)]?.opId;
              if (minted) mintedOpIds.add(minted);
              break;
            }
            case "goOffline":
              device.setOnline(false);
              break;
            case "comeOnline":
              device.setOnline(true);
              device.session.connect();
              await device.session.sync();
              break;
            case "sync":
              await device.session.sync();
              break;
            case "redeliver":
              if (device.redeliver()) redeliverEffectiveCount += 1;
              break;
            case "pullOutOfOrder": {
              // Fires the redelivery synchronously in the gap before sync()'s pull settles
              // (JS run-to-first-await semantics: the socket's ingest() runs to completion
              // before the pull's own ingest() gets a chance to), genuinely racing the two
              // ingest paths against each other rather than just serializing them. sync()'s
              // returned promise is already in flight (pushPending/pull have been kicked
              // off) by the time redeliver() runs synchronously in this same tick, whether
              // or not that pull ultimately succeeds — so a true (non-empty) redeliver()
              // here is exactly "a redelivery raced against a real in-flight pull," which is
              // what pullOutOfOrderRacedCount counts.
              const pendingSync = device.session.sync();
              if (device.redeliver()) pullOutOfOrderRacedCount += 1;
              await pendingSync;
              break;
            }
          }
          advanceTrueClock();
        }

        await quiesce(devices);

        const serverLog = server.log();
        const expected = reduceRound(serverLog);
        const expectedJson = JSON.stringify(expected);

        for (const device of devices) {
          expect(device.session.state()).toEqual(expected); // property 1
          expect(device.session.pending()).toBe(0); // property 4
          // Fix-wave (review Finding 2): this half of property 4 is currently UNFALSIFIABLE
          // in this harness. SimServer's fixed contract (module comment atop
          // testing/simServer.ts) only ever rejects a duplicate opId, and a duplicate
          // surfaces as `{duplicate: true}` from append() — not as a thrown TransportError
          // — so session.ts's permanent-rejection path (pushPending's catch branch that
          // moves an event into rejectedOps) can never fire against this sim server, and
          // this assertion can never fail regardless of what the fix wave changes. The
          // controller's decision stands: the sim contract per the plan is NOT altered to
          // add rejection injection just to make this line falsifiable. Real coverage for
          // the permanent-rejection path already lives in session.test.ts: "(e) a permanent
          // 409 mid-queue drops only that entry into rejected() and still pushes the rest"
          // and "a permanent rejection under overlapping sync() triggers yields exactly one
          // rejected() entry for that op". This assertion stays here as a quiescence
          // invariant — every device SHOULD converge with an empty rejected() given the sim
          // never permanently rejects anything — and will automatically start pulling real
          // weight the moment SimServer ever grows rejection injection.
          expect(device.session.rejected()).toEqual([]); // property 4
          expect(JSON.stringify(device.session.state())).toBe(expectedJson); // property 5
        }

        const referenceGames = devices[0]!.session.games();
        for (const device of devices) {
          expect(device.session.games()).toEqual(referenceGames); // property 2
        }

        for (const mintedId of mintedOpIds) {
          expect(serverLog.filter((event) => event.opId === mintedId)).toHaveLength(1); // property 3
        }

        for (const device of devices) await device.session.close();
      }),
      { numRuns: 50 },
    );

    // Fix-wave (review Finding 1) — floor rationale: with op targeting (deviceIndex, op
    // kind) drawn uniformly at random, no single schedule is guaranteed to make either op
    // effective, but every device's socket is now armed from schedule start (see the
    // per-device setup above), and 10-40 ops per schedule across 50 schedules gives both
    // ops abundant opportunity. A floor of 5 across the WHOLE run is deliberately
    // conservative: high enough to catch total structural degeneration (e.g. every
    // redeliver/pullOutOfOrder execution silently collapsing to a no-op, as could happen
    // before this fix when a device never drew `comeOnline`), low enough that ordinary
    // randomness in what fc.assert happens to generate can never make this assertion flaky.
    expect(redeliverEffectiveCount).toBeGreaterThanOrEqual(5);
    expect(pullOutOfOrderRacedCount).toBeGreaterThanOrEqual(5);
  }, 30_000);
});
