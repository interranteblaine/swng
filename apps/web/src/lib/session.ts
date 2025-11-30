const keyFor = (roundId: string) => `session:${roundId}`;
const selfKeyFor = (roundId: string) => `player:self:${roundId}`;

/**
 * Session ID per roundId (used for authenticated HTTP + WS)
 */
export function getSessionId(roundId: string): string | null {
  try {
    return sessionStorage.getItem(keyFor(roundId));
  } catch {
    return null;
  }
}

export function setSessionId(roundId: string, sessionId: string): void {
  try {
    sessionStorage.setItem(keyFor(roundId), sessionId);
  } catch {
    // ignore quota/availability errors
  }
}

export function clearSession(roundId: string): void {
  try {
    sessionStorage.removeItem(keyFor(roundId));
  } catch {
    // ignore
  }
}

/**
 * Current player's id for this session/round (persisted to restore identity after refresh)
 */
export function getSelfPlayerId(roundId: string): string | null {
  try {
    return sessionStorage.getItem(selfKeyFor(roundId));
  } catch {
    return null;
  }
}

export function setSelfPlayerId(roundId: string, playerId: string): void {
  try {
    sessionStorage.setItem(selfKeyFor(roundId), playerId);
  } catch {
    // ignore
  }
}

export function clearSelfPlayerId(roundId: string): void {
  try {
    sessionStorage.removeItem(selfKeyFor(roundId));
  } catch {
    // ignore
  }
}
