import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import type { GetGolferResponse } from "@swng/contracts";
import { formatHandicapIndex, golferId as makeGolferId, indexSourcePhrase, resolveIndex } from "@swng/domain";
import { ApiError, getGolfer } from "../api";
import { SignInCta } from "../auth/SignInCta";
import { useAuth } from "../auth/useAuth";
import { linkEntity } from "../ui/classes";
import { usePageTitle } from "../ui/usePageTitle";
import { RecordSections } from "./RecordSections";

const NOT_FOUND_MESSAGE = "This golfer isn't available";

// GET /golfers/{golferId} (navigation spec §6c): any signed-in golfer's own record, read-only —
// the SAME index line + record sections ProfilePage renders for yourself, but third-person
// (indexSourcePhrase(kind, "their")) and with NO controls: name/home Save and the index-source
// picker stay ProfilePage-only, never here. Signed-out hit runs the same SignInCta funnel every
// gated page uses, returnTo the current path so the round trip lands back here.
export function GolferPage() {
  const { golferId: param } = useParams<{ golferId: string }>();
  const auth = useAuth();
  const { withAuth, signedIn } = auth;

  const [golfer, setGolfer] = useState<GetGolferResponse | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  // Re-runs once the golfer loads (usePageTitle's own title-prop-change contract) — "swng" while
  // loading, then their name.
  usePageTitle(golfer?.name);

  useEffect(() => {
    if (!signedIn || !param) return;
    setGolfer(undefined);
    setError(undefined);
    void withAuth((token) => getGolfer(token, makeGolferId(param)))
      .then(setGolfer)
      .catch((caught: unknown) => {
        // Never the raw server text (ArchivedRoundPage.tsx / ProfilePage.tsx's own save-error
        // discipline) — an unresolvable id reads honestly, everything else is a generic retry ask.
        setError(caught instanceof ApiError && caught.code === "golfer-not-found" ? NOT_FOUND_MESSAGE : "Could not load this golfer — try again.");
      });
  }, [signedIn, param, withAuth]);

  if (!param) {
    return <Navigate to="/" replace />; // unreachable given the route pattern; keeps TS/runtime honest
  }

  if (!signedIn) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-cream p-6">
        <SignInCta message="Sign in to see this golfer's record." returnTo={`/golfers/${param}`} />
      </main>
    );
  }

  if (error) {
    // No form, nothing else to do with an unresolvable golfer (CrewJoinPage's DeadInvite idiom) —
    // role="status" (informational, the message already names the problem), a link home.
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 bg-cream p-6 text-center text-forest">
        <p role="status">{error}</p>
        <Link to="/" className="text-forest underline decoration-fairway">
          Back to swng
        </Link>
      </main>
    );
  }

  if (!golfer) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 bg-cream p-6">
        <p className="text-forest">Loading…</p>
      </main>
    );
  }

  // Resolved exactly as ProfilePage does — the SAME resolveIndex + formatHandicapIndex imports —
  // but named third-person via indexSourcePhrase's "their" arm (@swng/domain, the model owning
  // both arms of the same convention).
  const resolved = resolveIndex(golfer.indexSource, golfer.metrics);
  const isSelf = auth.golfer != null && auth.golfer.golferId === makeGolferId(param);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-8 bg-cream p-6">
      <h1 className="text-2xl font-bold text-forest">{golfer.name}</h1>
      <p className="text-fairway">
        plays off {resolved.value !== undefined ? formatHandicapIndex(resolved.value) : "—"} · {indexSourcePhrase(resolved.kind, "their")}
      </p>

      {isSelf && (
        <Link to="/profile" className={`text-sm text-forest ${linkEntity}`}>
          This is you · your profile
        </Link>
      )}

      {/* The chart/typical-18/history JSX (navigation spec §6c.3) — the SAME extracted component
          ProfilePage renders for yourself, no second copy. No controls of any kind here. */}
      <section className="flex flex-col gap-4">
        <RecordSections metrics={golfer.metrics} history={golfer.history} />
      </section>
    </main>
  );
}
