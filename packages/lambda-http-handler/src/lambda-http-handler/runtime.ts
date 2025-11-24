import type { Clock, IdGenerator } from "@swng/application";

function uuid(): string {
  const cryptoObj: Crypto | undefined = globalThis.crypto;
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function randomAccessCode(length = 6): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < length; i++) {
    const idx = Math.floor(Math.random() * alphabet.length);
    s += alphabet[idx];
  }
  return s;
}

export const idGenerator: IdGenerator = {
  newRoundId: () => `rnd_${uuid()}`,
  newPlayerId: () => `ply_${uuid()}`,
  newSessionId: () => `sess_${uuid()}`,
  newAccessCode: () => randomAccessCode(6),
};

export const clock: Clock = {
  now(): string {
    return new Date().toISOString();
  },
};
