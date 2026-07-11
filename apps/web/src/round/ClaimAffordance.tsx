import { useState } from "react";
import type { GolferId } from "@swng/domain";
import { ApiError, claimGolfer } from "../api";
import { useAuth } from "../auth/useAuth";

export interface ClaimAffordanceProps {
  readonly rowGolferId: GolferId;
  // Papercut 5 (M8 Task 5): sent with the claim so a FRESH claim's profile is named after the
  // roster row, not the JWT-derived email default (claimGolferRequestSchema's `name` only seeds
  // a lazily-created golfer row — never renames an existing one, golfers.ts's own doc comment).
  readonly rowName: string;
  // M9 hardening (claim proof-of-context): the round's own join code — the ONE proof token
  // that lets the server confirm rowGolferId genuinely belongs to this round before binding
  // the caller's sub to it. Both call sites (SetupPanel, ResultsView) already have their
  // round's joinCode in props/session state; there is no crew-page claim affordance to send a
  // crew code instead (checked — CrewPage.tsx has none).
  readonly code: string;
}

// The ghost-claim affordance on one roster row (M7 Task 6; model corrected after a field smoke
// caught the original over-restriction): signed in + this row not already linked to THIS
// account → "This is me" → confirm → POST /golfers/claim → success re-fetches /me (the claim
// bound this account's sub to the EXISTING GolferId — the header chrome updates to the claimed
// name; the record is unbroken because nothing else moved).
//
// Renders for ANY signed-in user on ANY row not already linked to their account — including the
// row belonging to THIS DEVICE's own round session. Device round-identity (which participant
// this browser tab is scoring as) is not account identity (who is signed in): the most common
// case is the very person who created the round signing in afterward to claim the row they've
// been playing as all along. Collisions (the row already claimed by someone else, or this
// account already bound to a different golfer) are the claim endpoint's own 409 arms to
// disambiguate, not a client-side guess at who "should" be allowed to try.
//
// Two views render this component: SetupPanel (the live roster) and ResultsView (the finalized
// roster) — claiming stays reachable after a round ends too ("sign in that evening and claim
// your round" is part of the M7 promise, not just a mid-round affordance).
// Round-membership-as-claim-capability is beta-grade by design (M9 hardens with a
// challenge/confirmation).
export function ClaimAffordance({ rowGolferId, rowName, code }: ClaimAffordanceProps) {
  const auth = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  if (!auth.signedIn) return null;

  // Checked BEFORE the already-mine guard below: a claim made in THIS session flips
  // auth.golfer to this very row on refetch, and the success confirmation must survive that.
  if (claimed) {
    return (
      <span role="status" className="text-xs text-emerald-400">
        Linked to your account
      </span>
    );
  }

  // A steady "You" marker (M8 Task 5 — was a bare null) once this signed-in account already IS
  // this golfer: claimed in an earlier session, the account's own golfer joined this round, OR
  // (the milestone's headline behavior) the round was created/joined AS this account golfer in
  // the first place — nothing left to claim, but the row should still say whose it is.
  if (auth.golfer?.golferId === rowGolferId) {
    return (
      <span role="status" className="text-xs text-emerald-400">
        You
      </span>
    );
  }

  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await auth.withAuth((token) => claimGolfer(token, { golferId: rowGolferId, name: rowName, code }));
      // Re-fetch /me (brief): the claim is what binds a fresh account to its season ghost, so
      // the app's identity chrome must reflect the claimed golfer now, not on the next reload.
      await auth.refetch();
      setClaimed(true);
      setConfirming(false);
    } catch (caught) {
      // Never the raw caught.message — every arm below gets honest wording.
      if (caught instanceof ApiError && caught.code === "claim-proof-required") {
        // M9 hardening: `code` didn't resolve to a round/crew naming this golferId — always a
        // real proof failure here (this component only ever sends the round's OWN join code,
        // so this arm is effectively unreachable in practice, but the copy stays honest rather
        // than falling through to the generic "try again" if it ever were).
        setError("This claim needs a round or crew code that includes this player.");
      } else if (caught instanceof ApiError && caught.code === "golfer-already-claimed") {
        // Both of claimGolfer.ts's collision arms throw the SAME "golfer-already-claimed"
        // code, so the client disambiguates by auth.golfer instead: if this signed-in account
        // already has a golfer (auth.golfer non-null), the 409 is arm 2 — THIS account's sub
        // is already bound elsewhere, one profile-Save away for every new user, and claiming a
        // second ghost isn't supported yet. Only when auth.golfer is null could the 409 mean
        // arm 1 — the row itself already claimed by a different account.
        setError(auth.golfer ? "Your account already has a profile — claiming another ghost isn't supported yet." : "Already claimed by another account.");
      } else {
        setError("Could not claim — try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="flex flex-col gap-1">
      {!confirming ? (
        <button type="button" onClick={() => setConfirming(true)} className="self-start rounded-md bg-slate-800 px-2 py-1 text-xs font-medium text-emerald-400">
          This is me
        </button>
      ) : (
        <span role="dialog" aria-label="Confirm claim" className="flex items-center gap-2 text-xs">
          <span className="text-slate-300">Claim this golfer&apos;s history as yours?</span>
          <button type="button" onClick={() => void confirm()} disabled={busy} className="rounded-md bg-emerald-700 px-2 py-1 font-medium text-slate-100 disabled:opacity-50">
            Confirm
          </button>
          <button type="button" onClick={() => setConfirming(false)} disabled={busy} className="rounded-md bg-slate-800 px-2 py-1 text-slate-300 disabled:opacity-50">
            Cancel
          </button>
        </span>
      )}
      {error && (
        <span role="alert" className="text-xs text-red-400">
          {error}
        </span>
      )}
    </span>
  );
}
