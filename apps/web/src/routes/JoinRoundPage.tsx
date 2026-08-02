import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { HoleSelection } from "@swng/domain";
import { holeSelectionLabel } from "@swng/domain";
import type { PeekRoundResponse } from "@swng/contracts";
import { ApiError, joinRound, peekRound, updateMe } from "../api";
import { SignInCta } from "../auth/SignInCta";
import { useAuth } from "../auth/useAuth";
import { teeNumbers } from "../courses/teeNumbers";
import { credentialStore } from "../identity";
import { roundLabel } from "../roundLabel";
import { btnPrimary, cardBox, inputBox, inputCode } from "../ui/classes";
import { usePageTitle } from "../ui/usePageTitle";

// >=250ms, same debounce window as CourseSearch's own — long enough that a fast typist never
// fires one request per keystroke.
const DEBOUNCE_MS = 250;

// The peek's per-tee shape — name plus the numbers the tee picker shows (teeNumbers). Nothing on
// this page asks about your game (spec 2026-07-30 §9): strokes are typed onto the round's roster
// by whoever agreed them, so joining is a code and a tee.
type PeekTee = PeekRoundResponse["teeSets"][number];

export function JoinRoundPage() {
  usePageTitle("Join a round");
  const navigate = useNavigate();
  const auth = useAuth();
  const [searchParams] = useSearchParams();

  // The wall (accounts-only identity spec §3): joining is self-join only, from the caller's own
  // account. The old free-text `name` field and the anonymous/no-golfer join branches are gone.
  // The funnel is a straight line: signed out → sign-in CTA; signed in but identity still loading
  // → a quiet placeholder (the M8 defect class: a submit here once renamed a real profile with
  // stale text); a placeholder golfer → the one name prompt (§2); a real golfer → the join form.
  const isIdentityLoading = auth.signedIn && auth.golfer === undefined;
  // A golfer whose name is still the sub-derived backstop (or the transient no-row case) names
  // themselves before joining. `!auth.golfer` here is only reachable once identity has resolved
  // (isIdentityLoading is checked first), so it means the dead null case, not "still loading".
  // Everything else — signed in, resolved, real name — is the join form itself (the final else
  // of the render chain below).
  const needsName = auth.signedIn && !isIdentityLoading && (!auth.golfer || auth.golfer.namePlaceholder === true);

  // Seeded from the URL (a join link, or the funnel's own returnTo landing) so a code carried
  // across the sign-in round trip lands ready to join without retyping.
  const [code, setCode] = useState(() => (searchParams.get("code") ?? "").toUpperCase());
  const [tee, setTee] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const [courseName, setCourseName] = useState<string | undefined>(undefined);
  // WHEN THE GOLF HAPPENED, from the peek — feeds roundLabel so the join-link framing carries the
  // SAME designation (course + date) as home/archive/watch (accounts-only identity spec §5,
  // dated onto the played instant by round-played-date spec 2026-08-01 §6).
  const [playedAt, setPlayedAt] = useState<number | undefined>(undefined);
  // Which holes the round set out to play (spec 2026-08-02 §6, task 8b) — the ONE surface the
  // plan named and never wired up. Absent means the whole card: `peekRound` omits this key
  // entirely for an "all" round (application/rounds/peekRound.ts), so undefined here is the
  // ordinary case and renders nothing, exactly like courseName/playedAt above render nothing
  // before a peek has landed.
  const [holes, setHoles] = useState<HoleSelection | undefined>(undefined);
  // The peek's tee sets (name + rating/slope), not just names — the picker shows each tee's
  // rating/slope via teeNumbers.
  const [peekTees, setPeekTees] = useState<readonly PeekTee[] | undefined>(undefined);
  // Only ever true after a peek actually rejected — gates the fallback NOTE (not the fallback
  // input itself, which is simply whatever renders whenever peekTees is absent).
  const [peekFailed, setPeekFailed] = useState(false);

  // joinRoundRequestSchema expects the canonical uppercase 6-char form — uppercase here so a
  // golfer typing lowercase never hits a validation error on something this trivial to fix.
  const upperCode = code.trim().toUpperCase();

  useEffect(() => {
    setCourseName(undefined);
    setPlayedAt(undefined);
    setHoles(undefined);
    setPeekTees(undefined);
    setPeekFailed(false);
    if (upperCode.length !== 6) return undefined; // peek only once the code looks complete

    const timer = setTimeout(() => {
      peekRound(upperCode)
        .then((response) => {
          setCourseName(response.courseName);
          setPlayedAt(response.playedAt);
          setHoles(response.holes);
          setPeekTees(response.teeSets);
          setTee(response.teeSets[0]?.name ?? "");
        })
        .catch(() => {
          // Peek is a nicety (course name + tee picker), never a gate: a bad/expired code is
          // still caught for real by joinRound itself at submit time, so a failed lookup here
          // just falls back to the free-text tee this page always had — joining must never be
          // blocked by this convenience (why-comment, brief).
          setPeekFailed(true);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [upperCode]);

  const canSubmit = upperCode.length === 6 && tee.trim() !== "";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const golfer = auth.golfer;
    // Only ever reachable in the asSelf state (the form isn't rendered otherwise), but guarded
    // anyway: a real account golfer, a complete code and a tee.
    if (!canSubmit || !golfer || golfer.namePlaceholder === true) return;

    setSubmitting(true);
    setError(undefined);
    try {
      // Accounts-only identity (spec §3): join is always as-self, resolved server-side from the
      // Bearer — the request carries no name/golferId (the server freezes the account golfer's name
      // into the join event).
      const response = await auth.withAuth((token) => joinRound({ code: upperCode, tee: tee.trim() }, token));
      // The server now echoes the round's canonical join code on JoinRoundResponse (spec
      // 2026-07-20 §2) — that's what's saved, not the typed form value: the server echoes the
      // exact stored code its lookup just matched.
      credentialStore.save(response.roundId, { token: response.token, golferId: response.golferId, name: golfer.name, joinCode: response.joinCode });
      navigate(`/round/${response.roundId}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not join the round — try again.");
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-cream p-6">
      <h1 className="text-2xl font-extrabold tracking-tight text-forest">Join by code</h1>

      <label className="flex flex-col gap-1 text-forest">
        Code
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          maxLength={6}
          className={`${inputCode} uppercase`}
        />
      </label>

      {/* courseName and playedAt are set together, from the same peek response (the effect
          above) — both are checked here (not just courseName) so TypeScript narrows playedAt to
          its required non-optional roundLabel shape without an unchecked assertion. */}
      {courseName && playedAt !== undefined && <p className="text-sm text-fairway">Joining {roundLabel({ courseName, playedAt })}</p>}

      {/* Which holes the round set out to play (spec 2026-08-02 §6) — rendered ONLY once the peek
          actually carries a selection. Absence means the whole card, a true statement about every
          round on file before this arc and every ordinary 18-hole round since, so this line has
          never appeared for one and must not start now. */}
      {holes !== undefined && <p className="text-sm text-fairway">This round plays the {holeSelectionLabel(holes)}.</p>}

      {!auth.signedIn ? (
        // The join link IS the sign-up funnel (spec §3): signing in through the stock Hosted UI
        // is how a new player joins. The returnTo carries the code back so the round trip lands
        // ready to join.
        <SignInCta
          message="Sign in to join this round — new players create their account on the way."
          returnTo={upperCode.length === 6 ? `/join?code=${upperCode}` : "/join"}
        />
      ) : isIdentityLoading ? (
        // A quiet placeholder, not a form — a submit during this window is exactly the M8 defect
        // (a silent rename of a profile that hadn't loaded yet). Nothing here can be submitted.
        <div role="status" aria-label="Loading your profile" className="flex flex-col gap-1">
          <div className={`${cardBox} p-3 text-lg text-fairway/70`}>Loading your profile…</div>
        </div>
      ) : needsName ? (
        <NamePrompt />
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-sm text-fairway">Playing as</span>
            <div className={`${cardBox} flex items-center justify-between gap-2 p-3 text-lg text-forest`}>
              <span>{auth.golfer!.name}</span>
              <Link to="/profile" className="text-sm text-forest underline decoration-fairway decoration-2">
                Change
              </Link>
            </div>
          </div>

          {peekTees ? (
            <label className="flex flex-col gap-1 text-forest">
              Tee
              <select value={tee} onChange={(event) => setTee(event.target.value)} className={`${inputBox} text-lg`}>
                {peekTees.map((peekTee) => (
                  <option key={peekTee.name} value={peekTee.name}>
                    {peekTee.name} — {teeNumbers(peekTee)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="flex flex-col gap-1">
              <label className="flex flex-col gap-1 text-forest">
                Tee
                <input value={tee} onChange={(event) => setTee(event.target.value)} className={`${inputBox} text-lg`} />
              </label>
              {/* Sibling of the <label>, not nested inside it — nesting would fold this note into
                  the label's own accessible name. */}
              {peekFailed && <span className="text-xs text-fairway/70">Could not look up this course's tees — type yours from the card.</span>}
            </div>
          )}

          {error && (
            <p role="alert" className="text-oxblood">
              {error}
            </p>
          )}

          <button type="submit" disabled={submitting || !canSubmit} className={`${btnPrimary} disabled:opacity-50`}>
            Join round
          </button>
        </form>
      )}
    </main>
  );
}

// The funnel's one required field (accounts-only identity spec §2): a placeholder golfer names
// themselves at the highest-motivation moment — a PUT of the name, nothing more. Only ever
// mounted once identity has resolved (JoinRoundPage gates it behind isIdentityLoading), so it
// can never fire a rename over a still-loading profile. On success the refetch flips the golfer
// to real (namePlaceholder cleared), which re-renders the parent straight into the join form —
// same visit, no navigation hop (controller resolution 2).
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
      await auth.refetch(); // flips auth.golfer to the real name → the join form renders
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
