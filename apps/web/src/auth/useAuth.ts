import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { GolferView } from "@swng/contracts";
import { ApiError, getMe } from "../api";
import { authConfig, buildAuthorizeUrl, computeCodeChallenge, generateCodeVerifier, tokenEndpoint } from "./authConfig";
import type { AuthTokens } from "./tokenStore";
import { pkceVerifierStore, tokenStore } from "./tokenStore";

export interface AuthContextValue {
  // undefined: signed out. null: signed in, but GET /me found no golfer row yet (the plan's
  // amendment — GET /me NEVER creates). A GolferView: signed in with a real golfer.
  readonly golfer: GolferView | null | undefined;
  // Decoded straight from the ID token's own claims (no network) — the header-chrome/auto-fill
  // fallback for exactly the `golfer === null` case above (brief's controller amendment 1).
  readonly email: string | undefined;
  readonly signedIn: boolean;
  readonly signIn: () => void;
  readonly signOut: () => void;
  // Re-runs GET /me and replaces `golfer` — the explicit escape hatch for a caller that just
  // changed the golfer row itself (ProfilePage's PUT /me, RoundPage's claim) and needs the
  // context to reflect it immediately, without waiting for a future remount's one-shot fetch.
  readonly refetch: () => Promise<void>;
  // Every other golfer-tier call (updateMe/claimGolfer/getMyRecord) goes through this instead
  // of pulling the raw token — the ONE place "401 anywhere -> one silent refresh-token retry,
  // then signed-out" (brief) lives, rather than every call site re-implementing it.
  readonly withAuth: <T>(fn: (token: string) => Promise<T>) => Promise<T>;
  // AuthCallbackPage's own seam: hands the just-exchanged tokens to the provider once the code
  // exchange succeeds. A distinct method from `refetch` — this ALSO resets the "once per
  // session" GET /me guard, since a fresh sign-in is a new session by definition.
  readonly completeSignIn: (tokens: AuthTokens) => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// Decodes an ID token's payload claims WITHOUT verifying the signature — verification is the
// server's job (adapters-cognito's createCognitoVerifier); this only ever feeds a friendly
// display fallback (email/localpart) before or in the absence of a golfer row, never an
// authorization decision.
const decodeIdTokenEmail = (idToken: string): string | undefined => {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return undefined;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(normalized)) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : undefined;
  } catch {
    return undefined; // a malformed token decodes to no fallback, never a thrown render
  }
};

// Cognito's refresh grant (does NOT rotate the refresh token itself by default — the caller
// keeps using the same one). undefined on ANY failure (network, non-2xx, malformed body) — the
// caller's job is deciding what "no refreshed tokens" means (withAuth below: sign out).
const requestTokenRefresh = async (refreshToken: string): Promise<{ readonly idToken: string; readonly expiresAt: number } | undefined> => {
  try {
    const body = new URLSearchParams({ grant_type: "refresh_token", client_id: authConfig.userPoolClientId, refresh_token: refreshToken });
    const response = await fetch(tokenEndpoint(), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
    if (!response.ok) return undefined;
    const json = (await response.json()) as { id_token?: unknown; expires_in?: unknown };
    if (typeof json.id_token !== "string" || typeof json.expires_in !== "number") return undefined;
    return { idToken: json.id_token, expiresAt: Date.now() + json.expires_in * 1000 };
  } catch {
    return undefined;
  }
};

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const [tokens, setTokens] = useState<AuthTokens | undefined>(() => tokenStore.load());
  const [golfer, setGolfer] = useState<GolferView | null | undefined>(undefined);
  // Mirrors `tokens` synchronously for withAuth's own closures (useCallback below is created
  // once and must never read a stale token across a refresh) — same "ref shadows state for a
  // stable callback" idiom as useRoundSession.ts's sessionRef.
  const tokensRef = useRef(tokens);
  const fetchedOnceRef = useRef(false);

  useEffect(() => {
    tokensRef.current = tokens;
  }, [tokens]);

  const signOut = useCallback(() => {
    tokenStore.clear();
    tokensRef.current = undefined;
    setTokens(undefined);
    setGolfer(undefined);
  }, []);

  // The one 401-anywhere policy (brief): try the call; on a 401, refresh once and retry; if
  // either the refresh or the retry still fails, sign out and rethrow — never a silent
  // half-authenticated state.
  const withAuth = useCallback(
    async <T,>(fn: (token: string) => Promise<T>): Promise<T> => {
      const current = tokensRef.current;
      if (!current) throw new ApiError("not-signed-in", undefined, "not signed in");

      try {
        return await fn(current.idToken);
      } catch (caught) {
        if (!(caught instanceof ApiError) || caught.status !== 401) throw caught;

        const refreshed = await requestTokenRefresh(current.refreshToken);
        if (!refreshed) {
          signOut();
          throw caught;
        }
        const nextTokens: AuthTokens = { idToken: refreshed.idToken, refreshToken: current.refreshToken, expiresAt: refreshed.expiresAt };
        tokenStore.save(nextTokens);
        tokensRef.current = nextTokens;
        setTokens(nextTokens);

        try {
          return await fn(nextTokens.idToken);
        } catch (retryCaught) {
          signOut();
          throw retryCaught;
        }
      }
    },
    [signOut],
  );

  const refetch = useCallback(async () => {
    if (!tokensRef.current) return;
    try {
      const response = await withAuth((token) => getMe(token));
      setGolfer(response.golfer);
    } catch {
      // withAuth already handled a terminal 401 (signed out); a transient/network failure here
      // just leaves `golfer` at its previous value rather than crashing the provider.
    }
  }, [withAuth]);

  // GET-/me's once per session (brief) — fires when tokens first appear (a fresh load with a
  // saved session) and again whenever completeSignIn resets the guard (a NEW sign-in is a new
  // session), but never on every render.
  useEffect(() => {
    if (fetchedOnceRef.current) return;
    if (!tokens) return;
    fetchedOnceRef.current = true;
    void refetch();
  }, [tokens, refetch]);

  const signIn = useCallback(() => {
    void (async () => {
      const verifier = generateCodeVerifier();
      pkceVerifierStore.save(verifier);
      const challenge = await computeCodeChallenge(verifier);
      window.location.assign(buildAuthorizeUrl(challenge));
    })();
  }, []);

  const completeSignIn = useCallback((newTokens: AuthTokens) => {
    tokenStore.save(newTokens);
    fetchedOnceRef.current = false; // a fresh sign-in is a new session — refetch once more
    tokensRef.current = newTokens;
    setTokens(newTokens);
  }, []);

  const value: AuthContextValue = {
    golfer: tokens ? golfer : undefined,
    email: tokens ? decodeIdTokenEmail(tokens.idToken) : undefined,
    signedIn: tokens !== undefined,
    signIn,
    signOut,
    refetch,
    withAuth,
    completeSignIn,
  };

  // createElement, not JSX — this file stays a plain .ts module (the brief's own file list),
  // and a provider component is the one piece of it that needs to produce an element.
  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
