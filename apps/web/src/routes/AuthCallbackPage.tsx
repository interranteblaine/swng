import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { authConfig, tokenEndpoint } from "../auth/authConfig";
import { pkceVerifierStore, returnToStore } from "../auth/tokenStore";
import { useAuth } from "../auth/useAuth";

// The Hosted UI redirects here with ?code=... (brief: "/auth/callback exchanges the code at
// the pool's /oauth2/token") — window.location.search would NOT reflect this under
// MemoryRouter in tests (it only tracks its own in-memory history, never the real browser
// location), so this reads the query string through react-router's own location instead, the
// same source CreateRoundPage.tsx's useLocation-based state read already relies on.
export function AuthCallbackPage() {
  const navigate = useNavigate();
  const auth = useAuth();
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | undefined>(undefined);
  // A code exchange is single-use (Cognito rejects a replayed authorization code) — this guard
  // is what keeps a React StrictMode double-invoke (or any other re-render of this effect) from
  // firing it twice.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    void (async () => {
      const code = searchParams.get("code");
      const verifier = pkceVerifierStore.take();
      if (!code || !verifier) {
        setError("Sign-in link is missing or expired — try signing in again.");
        return;
      }

      try {
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          client_id: authConfig.userPoolClientId,
          code,
          redirect_uri: authConfig.redirectUri,
          code_verifier: verifier,
        });
        const response = await fetch(tokenEndpoint(), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
        if (!response.ok) throw new Error(`token exchange failed with status ${response.status}`);

        const json = (await response.json()) as { id_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
        if (typeof json.id_token !== "string" || typeof json.refresh_token !== "string" || typeof json.expires_in !== "number") {
          throw new Error("token exchange returned an unexpected shape");
        }

        auth.completeSignIn({ idToken: json.id_token, refreshToken: json.refresh_token, expiresAt: Date.now() + json.expires_in * 1000 });
        // The join funnel (accounts-only identity spec §3) stashed where to land before the
        // redirect — consume it (single-use) so the code survives the round trip; a plain
        // sign-in that stashed nothing falls back to home, exactly as before this seam existed.
        navigate(returnToStore.take() ?? "/", { replace: true });
      } catch {
        setError("Could not complete sign-in — try again.");
      }
    })();
  }, [auth, navigate, searchParams]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-cream p-6">
      {error ? (
        <div className="flex flex-col items-center gap-3 text-center">
          <p role="alert" className="text-oxblood">
            {error}
          </p>
          <a href="/" className="text-forest underline decoration-gold decoration-2">
            Back to swng
          </a>
        </div>
      ) : (
        <p role="status" className="font-serif text-forest">Signing you in…</p>
      )}
    </main>
  );
}
