// The one legal source of wall time for server-authored events (conventions §4: "two
// clocks, two jobs, never a third") — use cases never call Date.now() directly.
export interface Clock {
  now(): number;
}
