// localStorage persistence for the signed-in golfer's Cognito tokens (M7 Task 6) — same
// "load/save, corrupted entry treated as absent" idiom as identity.ts's credentialStore, one
// directory over. Beta-grade (brief): plaintext tokens in localStorage, no rotation beyond the
// one-shot refresh useAuth.ts drives; M9 hardens this.
export interface AuthTokens {
  readonly idToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number; // epoch ms — informational only; useAuth.ts's 401-triggered refresh is what actually gates re-use, not a client-side clock check
}

const AUTH_KEY = "swng:auth";

export const tokenStore = {
  load: (): AuthTokens | undefined => {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as AuthTokens;
    } catch {
      return undefined; // corrupted entry: treat as absent rather than throwing
    }
  },

  save: (tokens: AuthTokens): void => {
    localStorage.setItem(AUTH_KEY, JSON.stringify(tokens));
  },

  clear: (): void => {
    localStorage.removeItem(AUTH_KEY);
  },
};

// The PKCE code_verifier, stashed between SignInButton's redirect to the Hosted UI and
// AuthCallbackPage picking the flow back up on return — sessionStorage (not localStorage,
// unlike tokenStore above): it only needs to survive the round-trip to Cognito and back in
// THIS tab, the same lifetime tabDeviceId's own sessionStorage use relies on (identity.ts).
// `take` reads-and-removes in one step: a code_verifier is single-use by construction (PKCE's
// own contract), and a stale leftover from an abandoned sign-in must never be replayed against
// a later one.
const PKCE_VERIFIER_KEY = "swng:pkceVerifier";

export const pkceVerifierStore = {
  save: (verifier: string): void => {
    sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  },

  take: (): string | undefined => {
    const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
    sessionStorage.removeItem(PKCE_VERIFIER_KEY);
    return verifier ?? undefined;
  },
};
