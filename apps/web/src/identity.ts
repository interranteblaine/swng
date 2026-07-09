import { deviceId, roundId } from "@swng/domain";
import type { DeviceId, GolferId, RoundId } from "@swng/domain";

const TAB_DEVICE_ID_KEY = "swng:tabDeviceId";

// One id per browser TAB, not per device/user (docs/implementation-plan.md's M4→M5
// handoff): two live sessions sharing a deviceId mint colliding opIds off the same
// opCounter, and the server silently dedupes that down to one side's score. sessionStorage
// is exactly the tab-scoped storage that gives each tab (including a duplicated one) its own
// id, cached for the tab's lifetime so a reload doesn't mint a fresh id mid-session and
// orphan the previous id's outbox.
export const tabDeviceId = (): DeviceId => {
  const existing = sessionStorage.getItem(TAB_DEVICE_ID_KEY);
  if (existing) return deviceId(existing);
  const fresh = crypto.randomUUID();
  sessionStorage.setItem(TAB_DEVICE_ID_KEY, fresh);
  return deviceId(fresh);
};

export interface RoundCredential {
  readonly token: string;
  readonly golferId: GolferId;
  readonly name: string;
  readonly joinCode: string;
}

const CREDENTIAL_KEY_PREFIX = "swng:credential:";
const credentialKey = (id: RoundId): string => `${CREDENTIAL_KEY_PREFIX}${id}`;

// localStorage, not sessionStorage: a round credential must survive a reload AND outlive the
// tab it was created in — that's the whole point of Home's "your rounds" list — the opposite
// lifetime from tabDeviceId's per-tab isolation above.
export const credentialStore = {
  load: (id: RoundId): RoundCredential | undefined => {
    const raw = localStorage.getItem(credentialKey(id));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as RoundCredential;
    } catch {
      return undefined; // corrupted entry: treat as absent rather than throwing
    }
  },

  save: (id: RoundId, credential: RoundCredential): void => {
    localStorage.setItem(credentialKey(id), JSON.stringify(credential));
  },

  // Scans localStorage rather than keeping a separate index — one source of truth, and a
  // crew's worth of rounds is small enough that a linear scan is free.
  list: (): { roundId: RoundId; name: string }[] => {
    const rounds: { roundId: RoundId; name: string }[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(CREDENTIAL_KEY_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const credential = JSON.parse(raw) as RoundCredential;
        rounds.push({ roundId: roundId(key.slice(CREDENTIAL_KEY_PREFIX.length)), name: credential.name });
      } catch {
        continue; // corrupted entry: skip rather than throwing
      }
    }
    return rounds;
  },
};
