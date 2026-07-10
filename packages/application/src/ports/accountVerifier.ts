import type { AccountClaims } from "./accountClaims.js";

// Wraps the Cognito JWT verifier (adapters-cognito's createCognitoVerifier, M7 Task 4) behind
// a port — the dispatcher's "golfer" auth tier (lambda/http/dispatch.ts) depends on this
// interface, never on aws-jwt-verify directly, mirroring TokenIssuer's shape (tokenIssuer.ts)
// for the same reason (adapters implement application's ports; lambda only ever sees the
// port). `verify` rejects (never resolves undefined) on an invalid/expired/wrong-audience
// bearer token — the dispatcher maps that rejection to the same `invalid-token` code a failed
// participant-token verify already produces.
export interface AccountVerifier {
  verify(bearer: string): Promise<AccountClaims>;
}
