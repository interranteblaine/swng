const NAME_KEY = "playerPrefs:lastPlayerName";

export function getLastPlayerName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

export function setLastPlayerName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // ignore quota/availability errors
  }
}
