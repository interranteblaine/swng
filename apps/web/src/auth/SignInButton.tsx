import { btnPrimary } from "../ui/classes";
import { useAuth } from "./useAuth";

// The header's COMPACT rendering of the shared btnPrimary idiom (padding/size swapped out for
// the header row, everything else — gold ground, forest ink, the uppercase/tracking treatment
// — inherited from the one idiom string, never re-typed). A plain template-literal append would
// leave BOTH px-6/py-4/text-sm and px-3/py-2/text-xs present, and which wins is a Tailwind
// stylesheet-order accident, not markup order — so the idiom's own conflicting utilities are
// swapped out by substring replace instead.
const compactPrimary = btnPrimary.replace("px-6 py-4", "px-3 py-2").replace("text-sm", "text-xs");

// Exactly the signed-out affordance (brief: "'Sign in' -> Hosted UI") — the signed-in header
// chrome (name, link to /profile, sign out) is a DIFFERENT visual state composed in App.tsx's
// header, not this component wearing two hats under one misleading name.
export function SignInButton() {
  const auth = useAuth();

  return (
    <button type="button" onClick={() => auth.signIn()} className={compactPrimary}>
      Sign in
    </button>
  );
}
