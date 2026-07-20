import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { PeekCrewInviteResponse } from "@swng/contracts";
import { ApiError, joinCrewByInvite, peekCrewInvite, updateMe } from "../api";
import { SignInCta } from "../auth/SignInCta";
import { useAuth } from "../auth/useAuth";
import { btnPrimary, cardBox, inputBox } from "../ui/classes";
import { usePageTitle } from "../ui/usePageTitle";

// Crew membership (invited in, accountable out — spec §2/§5): the two failure codes a token
// check can throw (peekCrewInvite AND joinCrewByInvite both make the SAME check — application/
// src/crews/peekCrewInvite.ts's own doc comment), mapped to the brief's exact copy. Never the
// raw server text (the M7 discipline).
const mapInviteTokenError = (caught: unknown): string | undefined => {
  if (!(caught instanceof ApiError)) return undefined;
  if (caught.code === "crew-invite-expired") return "This invite link has expired — ask your crew for a fresh one.";
  if (caught.code === "crew-invite-invalid") return "This invite link isn't valid — ask your crew for a fresh one.";
  return undefined;
};

const humanizePeekError = (caught: unknown): string => mapInviteTokenError(caught) ?? "Could not load this invite — try again.";
const humanizeJoinError = (caught: unknown): string => mapInviteTokenError(caught) ?? "Could not join the crew — try again.";

// A dead end, WatchPage's own idiom for a broken capability link (createWatchPage's missing-
// fragment/invalid-token states): role="status" (informational, not an alarming role="alert" —
// the mapped copy already names the problem), with a link home since there is nothing else to
// do with a token that can't be resolved — no form, brief: "no form, nothing else to do with a
// dead token."
function DeadInvite({ message }: { readonly message: string }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 bg-cream p-6 text-center text-forest">
      <p role="status">{message}</p>
      <Link to="/" className="text-forest underline decoration-fairway">
        Back to swng
      </Link>
    </main>
  );
}

// The funnel's one required field (accounts-only identity spec §2): a placeholder golfer names
// themselves at the highest-motivation moment — a PUT of the name, nothing more. Duplicated from
// JoinRoundPage's own NamePrompt (not exported there) rather than extracted — the two funnels
// are independent pages, and this is the smallest unit either owns. Only ever mounted once
// identity has resolved (the consent card gates it behind isIdentityLoading, same as
// JoinRoundPage), so it can never fire a rename over a still-loading profile.
function NamePrompt() {
  const auth = useAuth();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || saving) return;

    setSaving(true);
    setError(undefined);
    try {
      await auth.withAuth((token) => updateMe(token, { name: trimmed }));
      await auth.refetch(); // flips auth.golfer to the real name → the consent card's Join button renders
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not save your name — try again.");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-forest">
        What should the card call you?
        <input value={name} onChange={(event) => setName(event.target.value)} className={`${inputBox} text-lg`} />
      </label>

      {error && (
        <p role="alert" className="text-oxblood">
          {error}
        </p>
      )}

      <button type="submit" disabled={saving || !name.trim()} className={`${btnPrimary} disabled:opacity-50`}>
        Continue
      </button>
    </form>
  );
}

// The consent screen itself (spec §2: "the join page is a consent screen first: the crew name
// is visible BEFORE sign-in"). Mounted only once peek has resolved — `peek` is the trusted,
// already-verified preview; `token` rides through to the actual join call untouched.
function ConsentCard({ peek, token }: { readonly peek: PeekCrewInviteResponse; readonly token: string }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | undefined>(undefined);

  // Same three-state funnel split JoinRoundPage.tsx uses (accounts-only identity spec §3): signed
  // out → SignInCta; signed in but identity still loading → a quiet placeholder (the M8 defect
  // class — a submit here once silently renamed a profile that hadn't loaded yet); a placeholder
  // golfer → the name prompt; a real golfer → the Join button itself.
  const isIdentityLoading = auth.signedIn && auth.golfer === undefined;
  const needsName = auth.signedIn && !isIdentityLoading && (!auth.golfer || auth.golfer.namePlaceholder === true);

  const submitJoin = async () => {
    setJoining(true);
    setJoinError(undefined);
    try {
      const response = await auth.withAuth((authToken) => joinCrewByInvite(authToken, { token }));
      navigate(`/crews/${response.crew.crewId}`);
    } catch (caught) {
      setJoinError(humanizeJoinError(caught));
      setJoining(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-cream p-6">
      {/* The consent screen itself is a card (JoinRoundPage's own funnel idiom) — the crew
          name/member count/inviter is the trust surface shown BEFORE sign-in (spec §2). */}
      <div className={`${cardBox} flex flex-col gap-1 p-4`}>
        <h1 className="text-2xl font-bold text-forest">Join {peek.crewName}?</h1>
        <p className="text-fairway">
          {peek.memberCount} member{peek.memberCount === 1 ? "" : "s"} · invited by {peek.inviterName}
        </p>
      </div>

      {!auth.signedIn ? (
        // The join link IS the sign-up funnel (spec §3, mirroring JoinRoundPage's own): signing
        // in through the stock Hosted UI is how a new player joins. returnTo carries the FULL
        // link (path + fragment) back so the round trip lands ready to join, same as
        // JoinRoundPage's own code-preserving returnTo.
        <SignInCta message="Sign in to join this crew — new players create their account on the way." returnTo={`/crews/join#${token}`} />
      ) : isIdentityLoading ? (
        <div role="status" aria-label="Loading your profile" className="flex flex-col gap-1">
          <div className={`${cardBox} p-3 text-lg text-fairway/70`}>Loading your profile…</div>
        </div>
      ) : needsName ? (
        <NamePrompt />
      ) : (
        <div className="flex flex-col gap-4">
          {joinError && (
            <p role="alert" className="text-oxblood">
              {joinError}
            </p>
          )}
          <button type="button" onClick={() => void submitJoin()} disabled={joining} className={`${btnPrimary} disabled:opacity-50`}>
            {joining ? "Joining…" : "Join"}
          </button>
        </div>
      )}
    </main>
  );
}

// /crews/join#<token> (crew membership, invited in, accountable out — spec §2): the invite
// funnel. Token from the URL FRAGMENT (WatchPage's own idiom — fragments never leave the
// browser, never appear in server/proxy access logs), never a query param. peek → consent card
// → join, mirroring JoinRoundPage's own funnel shape exactly (SignInCta + returnToStore, the
// placeholder-name prompt) but for a crew instead of a round.
export function CrewJoinPage() {
  const location = useLocation();
  // location.hash carries the leading "#" (matches window.location.hash) — stripped once, here,
  // same as WatchPage.tsx's own token read.
  const token = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;

  const [peek, setPeek] = useState<PeekCrewInviteResponse | undefined>(undefined);
  const [peekError, setPeekError] = useState<string | undefined>(undefined);
  // Re-runs once the peek resolves (usePageTitle's own title-prop-change contract) — "Join a
  // crew" until the crew's own name is known.
  usePageTitle(peek?.crewName ?? "Join a crew");

  useEffect(() => {
    if (!token) return;
    setPeek(undefined);
    setPeekError(undefined);
    peekCrewInvite({ token })
      .then(setPeek)
      .catch((caught: unknown) => setPeekError(humanizePeekError(caught)));
  }, [token]);

  if (!token) {
    // Brief: "without a valid token there is nothing to join; render the error and a link home."
    return <DeadInvite message="This invite link looks incomplete — ask your crew for a fresh one." />;
  }

  if (peekError) {
    return <DeadInvite message={peekError} />;
  }

  if (!peek) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-cream text-forest">
        <p role="status">Loading invite…</p>
      </main>
    );
  }

  return <ConsentCard peek={peek} token={token} />;
}
