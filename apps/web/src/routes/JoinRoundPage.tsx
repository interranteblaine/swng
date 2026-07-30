import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { PeekRoundResponse } from "@swng/contracts";
import { ApiError, getMyRecord, joinRound, peekRound, updateMe } from "../api";
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

// The peek's per-tee shape — name plus the numbers the tee picker shows (teeNumbers). Nothing
// here feeds the strokes field any more: what a player states is a fact about THEM, not about the
// course (spec 2026-07-29 §2), so no course number converts it.
type PeekTee = PeekRoundResponse["teeSets"][number];

export function JoinRoundPage() {
  usePageTitle("Join a round");
  const navigate = useNavigate();
  const auth = useAuth();
  // Destructured so the record-fetch effect below lists a stable function reference as its dep
  // (withAuth's own useCallback identity, useAuth.ts) rather than the whole `auth` object — the
  // ProfilePage/CreateRoundPage precedent.
  const { withAuth } = auth;
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
  // What the golfer normally shoots relative to par (spec 2026-07-29 §2): the ONE number they
  // state, in the unit they already speak on the first tee.
  // Pre-filled from the golfer's own average (spec 2026-07-29 §2c): what they normally shoot is
  // exactly the number this field asks for, so the one they can already read on their profile lands
  // here as a starting point they can type over. BLANK when there is no average — a brand-new
  // golfer, or one whose every round contains a pickup — with no floor and no fallback chain: one
  // finished round is better evidence than a guess, and a guess in this field becomes a claim in
  // the round's log. Seeded ONCE, and only while the field is still untouched, so a pre-fill
  // arriving after the golfer has typed can never overwrite what they typed.
  const [overPar, setOverPar] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const [courseName, setCourseName] = useState<string | undefined>(undefined);
  // The round-created wall time from the peek — feeds roundLabel so the join-link framing carries
  // the SAME designation (course + date) as home/archive/watch (accounts-only identity spec §5).
  const [createdAt, setCreatedAt] = useState<number | undefined>(undefined);
  // The peek's full tee sets (name + par + rating/slope), not just names — the picker shows each
  // tee's rating/slope via teeNumbers.
  const [peekTees, setPeekTees] = useState<readonly PeekTee[] | undefined>(undefined);
  // Only ever true after a peek actually rejected — gates the fallback NOTE (not the fallback
  // input itself, which is simply whatever renders whenever peekTees is absent).
  const [peekFailed, setPeekFailed] = useState(false);

  // joinRoundRequestSchema expects the canonical uppercase 6-char form — uppercase here so a
  // golfer typing lowercase never hits a validation error on something this trivial to fix.
  const upperCode = code.trim().toUpperCase();

  // GET /me/record purely for the pre-fill above — the average is served, never computed here
  // (the compute fence: `averageOf` is deliberately not re-exported to the client). A failed fetch
  // just leaves the field blank, which is the honest no-average state anyway.
  useEffect(() => {
    if (!auth.signedIn) return;
    let ignore = false;
    void withAuth((token) => getMyRecord(token))
      .then((record) => {
        if (ignore) return;
        const average = record.metrics.average;
        if (average !== undefined) setOverPar((current) => (current === "" ? String(average) : current));
      })
      .catch(() => {}); // withAuth already handles a terminal 401; anything else leaves the field blank
    return () => {
      ignore = true;
    };
  }, [auth.signedIn, withAuth]);

  useEffect(() => {
    setCourseName(undefined);
    setCreatedAt(undefined);
    setPeekTees(undefined);
    setPeekFailed(false);
    if (upperCode.length !== 6) return undefined; // peek only once the code looks complete

    const timer = setTimeout(() => {
      peekRound(upperCode)
        .then((response) => {
          setCourseName(response.courseName);
          setCreatedAt(response.createdAt);
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

  const parsedOverPar = Number.parseInt(overPar, 10);
  const canSubmit = upperCode.length === 6 && tee.trim() !== "" && Number.isInteger(parsedOverPar);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const golfer = auth.golfer;
    // Only ever reachable in the asSelf state (the form isn't rendered otherwise), but guarded
    // anyway: a real account golfer, a complete code, a tee and a stated number.
    if (!canSubmit || !golfer || golfer.namePlaceholder === true) return;

    setSubmitting(true);
    setError(undefined);
    try {
      // Accounts-only identity (spec §3): join is always as-self, resolved server-side from the
      // Bearer — the request carries no name/golferId (the server freezes the account golfer's name
      // into the join event).
      const response = await auth.withAuth((token) =>
        joinRound({ code: upperCode, tee: tee.trim(), basis: { kind: "normally-shoots", overPar: parsedOverPar } }, token),
      );
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

      {courseName && <p className="text-sm text-fairway">Joining {roundLabel({ courseName, createdAt })}</p>}

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

          {/* ONE number, in the unit everyone already uses on the first tee (spec 2026-07-29 §2/§9,
              wording verbatim). No conversion and no derivation note: the number a player states IS
              the number strokes come from, and the strokes themselves fall out of the whole field
              once everyone has stated theirs — they are never a per-player declaration. The hint is
              a SIBLING of the <label> (not nested), which would fold it into the label's own
              accessible name. */}
          <div className="flex flex-col gap-1">
            <label className="flex flex-col gap-1 text-forest">
              What do you normally shoot, relative to par?
              <input
                type="number"
                step={1}
                inputMode="numeric"
                value={overPar}
                onChange={(event) => setOverPar(event.target.value)}
                className={`${inputBox} text-lg`}
              />
            </label>
            <span className="text-xs text-fairway/70">Over par for a normal round — 18 holes. Under par? Use a minus.</span>
          </div>

          {error && (
            <p role="alert" className="text-oxblood">
              {error}
            </p>
          )}

          {/* Disabled until the number is there: a blank field is not a claim, so submitting one
              must be visibly impossible rather than a silently dead button. */}
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
