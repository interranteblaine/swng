import { returnToStore } from "./tokenStore";
import { useAuth } from "./useAuth";

export interface SignInCtaProps {
  // The one line of framing above the button — each page says why it's asking (join this round,
  // start a round), so the copy lives with the caller rather than baked into this shared shell.
  readonly message: string;
  // Where to land after the Hosted-UI round trip (accounts-only identity spec §3): the join
  // funnel passes `/join?code=ABC123` so the code survives sign-up. OMITTED means the default
  // (AuthCallbackPage falls back to home) — the header's own SignInButton and any CTA that has
  // nothing to preserve pass nothing.
  readonly returnTo?: string;
}

// The page-body sign-in call to action (accounts-only identity spec §3): the signed-out state
// of every gated page (join, create, home) shows this instead of an anonymous form — signing
// in through the stock Hosted UI IS the sign-up funnel. Distinct from auth/SignInButton (the
// header's compact affordance): this is the prominent, framed body version, and it is the ONE
// place a returnTo is stashed before the redirect so no page re-implements that seam.
export function SignInCta({ message, returnTo }: SignInCtaProps) {
  const auth = useAuth();

  const signIn = () => {
    if (returnTo) returnToStore.save(returnTo);
    auth.signIn();
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-slate-800 p-4">
      <p className="text-slate-300">{message}</p>
      <button type="button" onClick={signIn} className="rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold text-slate-50">
        Sign in
      </button>
    </div>
  );
}
