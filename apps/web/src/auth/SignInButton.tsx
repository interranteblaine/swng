import { useAuth } from "./useAuth";

// Exactly the signed-out affordance (brief: "'Sign in' -> Hosted UI") — the signed-in header
// chrome (name, link to /profile, sign out) is a DIFFERENT visual state composed in App.tsx's
// header, not this component wearing two hats under one misleading name.
export function SignInButton() {
  const auth = useAuth();

  return (
    <button type="button" onClick={() => auth.signIn()} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-slate-50">
      Sign in
    </button>
  );
}
