const NAME_KEY = "playerPrefs:lastPlayerName";
const TEE_KEY = "playerPrefs:lastTeeColor";

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

export function getLastTeeColor(): string {
  try {
    return localStorage.getItem(TEE_KEY) ?? "White";
  } catch {
    return "White";
  }
}

export function setLastTeeColor(color: string): void {
  try {
    localStorage.setItem(TEE_KEY, color);
  } catch {
    // ignore quota/availability errors
  }
}
