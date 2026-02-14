/**
 * Stub for future "already a player?" bypass.
 * Will eventually call a server API to resolve accessCode → roundId
 * so we can skip the join flow for returning players.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useLookupRound(accessCode: string) {
  return {
    roundId: undefined as string | undefined,
    isLoading: false,
    error: null as string | null,
  };
}
