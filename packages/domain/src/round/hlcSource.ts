import type { DeviceId } from "../ids.js";
import { compareHlc, type Hlc } from "./hlc.js";

// The client-side half of the HLC protocol (server side never mints one — seq is the
// server's canonical order; hlc is authoring-time causality, entirely a client concern).
export interface HlcSource {
  next(): Hlc; // send rule: strictly greater than everything stamped OR observed so far
  observe(remote: Hlc): void; // receive rule: floor the source at the remote hlc
}

export const createHlcSource = (deviceId: DeviceId, clock: { now(): number } = { now: () => Date.now() }): HlcSource => {
  // `last` seeds below every real stamp (wallMs -Infinity, counter -1) so the very first
  // next() call takes the "wall clock advanced" branch unconditionally, without a
  // first-call special case duplicating the formula below.
  let last: Hlc = { wallMs: -Infinity, counter: -1, deviceId };

  return {
    next(): Hlc {
      const wallMs = Math.max(clock.now(), last.wallMs);
      const counter = wallMs === last.wallMs ? last.counter + 1 : 0;
      last = { wallMs, counter, deviceId };
      return last;
    },
    observe(remote: Hlc): void {
      // A correction authored on a skewed-behind phone must still win the LWW register
      // against the score it corrects, so the source floors at the remote hlc even when
      // the local wall clock never catches up — the next send then beats it on counter.
      if (compareHlc(remote, last) > 0) last = remote;
    },
  };
};
