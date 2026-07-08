import type { DeviceId } from "../ids.js";

// Hybrid logical clock: authoring-time causality for conflict resolution.
// deviceId in the tie-break makes the order total, so LWW merges are deterministic.
export interface Hlc {
  readonly wallMs: number;
  readonly counter: number;
  readonly deviceId: DeviceId;
}

export const compareHlc = (a: Hlc, b: Hlc): number => {
  if (a.wallMs !== b.wallMs) return a.wallMs - b.wallMs;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0;
};
