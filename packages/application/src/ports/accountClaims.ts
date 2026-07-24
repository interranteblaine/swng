// The verified identity a signed-in golfer's request carries once past the dispatcher's
// "golfer" auth tier (adapters-cognito's JWT verifier, M7 Task 4/5) — mirrors
// ParticipantClaims' house style (tokenIssuer.ts) for the same reason: GolferId is
// deliberately NOT the Cognito sub (architecture.md §3), so every golfer use case resolves
// its own GolferId via GolferStore.getBySub(sub) rather than trusting one on the claims.
export interface AccountClaims {
  readonly sub: string;
}
