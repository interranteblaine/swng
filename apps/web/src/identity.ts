import { deviceId } from "@swng/domain";
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
// tab it was created in — RoundPage and the join flow both depend on that survival to resume
// scoring on this device — the opposite lifetime from tabDeviceId's per-tab isolation above.
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
};
