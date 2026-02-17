import type { Clock, IdGenerator } from "@swng/application";

function uuid(): string {
  return crypto.randomUUID();
}

function randomAccessCode(length = 6): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
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
