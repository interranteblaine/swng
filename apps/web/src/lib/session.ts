/**
 * Current round pointer for this tab (used by nav to provide "Back to Round")
 */
const CURRENT_ROUND_KEY = "round:current";

export const SESSION_UPDATED_EVENT = "session:updated";

export function notifySessionUpdate(): void {
  try {
    window.dispatchEvent(new Event(SESSION_UPDATED_EVENT));
  } catch {
    // ignore
  }
}

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
    notifySessionUpdate();
  } catch {
    // ignore quota/availability errors
  }
}

export function clearSession(roundId: string): void {
  try {
    sessionStorage.removeItem(keyFor(roundId));
    notifySessionUpdate();
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
    notifySessionUpdate();
  } catch {
    // ignore
  }
}

export function clearSelfPlayerId(roundId: string): void {
  try {
    sessionStorage.removeItem(selfKeyFor(roundId));
    notifySessionUpdate();
  } catch {
    // ignore
  }
}

export function getCurrentRoundId(): string | null {
  try {
    return sessionStorage.getItem(CURRENT_ROUND_KEY);
  } catch {
    return null;
  }
}

export function setCurrentRoundId(roundId: string): void {
  try {
    sessionStorage.setItem(CURRENT_ROUND_KEY, roundId);
    notifySessionUpdate();
  } catch {
    // ignore quota/availability errors
  }
}

export function clearCurrentRoundId(): void {
  try {
    sessionStorage.removeItem(CURRENT_ROUND_KEY);
    notifySessionUpdate();
  } catch {
    // ignore
  }
}
