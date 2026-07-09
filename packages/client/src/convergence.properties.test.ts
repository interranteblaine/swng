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
  redeliver(): void;
}

const createDevice = async (server: SimServer, golfer: GolferId, deviceIdValue: DeviceId, clock: { now(): number }): Promise<DeviceHandle> => {
  const raw = server.transportFor(deviceIdValue);
  let lastBatch: readonly RoundEvent[] | undefined;
  let liveOnEvents: ((events: readonly RoundEvent[]) => void) | undefined;

  const transport = {
    push: raw.push,
    pull: raw.pull,
    openSocket: (onEvents: (events: readonly RoundEvent[]) => void, onClose: () => void) => {
      const wrapped = (events: readonly RoundEvent[]): void => {
        lastBatch = events;
        onEvents(events);
      };
      liveOnEvents = wrapped;
      return raw.openSocket(wrapped, onClose);
    },
  };

  const session = await createRoundSession({ transport, roundId: ROUND_ID, golferId: golfer, deviceId: deviceIdValue, clock });

  return {
    id: deviceIdValue,
    golferId: golfer,
    session,
    setOnline: raw.setOnline,
    redeliver: () => {
      if (liveOnEvents && lastBatch) liveOnEvents(lastBatch);
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

describe("N-device convergence property", () => {
  it("every generated interleaving of 2-4 devices folds to reduceRound(server.log())", async () => {
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
        // Every device catches up before the schedule runs — mirrors real usage (a session
        // always syncs at least once after construction; recordScore before genesis is ever
        // pulled is not a real client scenario and reduceRound correctly refuses to fold a
        // log with no round-created event).
        for (const device of devices) await device.session.sync();

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
              device.redeliver();
              break;
            case "pullOutOfOrder": {
              // Fires the redelivery synchronously in the gap before sync()'s pull settles
              // (JS run-to-first-await semantics: the socket's ingest() runs to completion
              // before the pull's own ingest() gets a chance to), genuinely racing the two
              // ingest paths against each other rather than just serializing them.
              const pending = device.session.sync();
              device.redeliver();
              await pending;
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
  }, 30_000);
});
