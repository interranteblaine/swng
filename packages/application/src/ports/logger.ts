export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  // Realignment Task 13: presence writes (rounds/presence.ts's writePresence) are a
  // best-effort discovery nicety that must never fail the seating act they ride along with —
  // a failure is caught and logged at `warn`, not `error` (nothing is actually broken; the
  // round itself committed fine), so an operator can tell "presence lagged" apart from a real
  // fault at a glance.
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}
