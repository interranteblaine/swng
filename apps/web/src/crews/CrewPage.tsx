import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { crewId as makeCrewId, golferId as makeGolferId } from "@swng/domain";
import type { GolferId } from "@swng/domain";
import type { CrewView, GetCrewRecordsResponse, StandingGameView } from "@swng/contracts";
import { addCrewMember, ApiError, getCrew, getCrewRecords, saveStandingGame } from "../api";
import { useAuth } from "../auth/useAuth";
import { StandingGameEditor } from "./StandingGameEditor";

// A crew load can fail two honest ways the wire names (errorMapping.ts) — both get human
// copy, never the raw server text (the M7 discipline: raw messages carry internal ids).
const humanizeCrewLoadError = (caught: unknown): string => {
  if (caught instanceof ApiError && caught.code === "not-a-member") return "You're not a member of this crew.";
  if (caught instanceof ApiError && caught.code === "unknown-crew") return "This crew doesn't exist — check the link.";
  return "Could not load this crew — try again.";
};

export function CrewPage() {
  const { crewId: crewIdParam } = useParams<{ crewId: string }>();
  if (!crewIdParam) return <Navigate to="/" replace />; // unreachable given the route pattern; keeps TS/runtime honest (EditCoursePage's idiom)

  return <CrewPageForId crewIdParam={crewIdParam} />;
}

function CrewPageForId({ crewIdParam }: { readonly crewIdParam: string }) {
  const id = makeCrewId(crewIdParam);
  const navigate = useNavigate();
  const auth = useAuth();
  // Stable function reference for the fetch effect (ProfilePage's own destructuring precedent).
  const { withAuth, signedIn } = auth;

  const [crew, setCrew] = useState<CrewView | undefined>(undefined);
  const [records, setRecords] = useState<GetCrewRecordsResponse | undefined>(undefined);
  // Papercut 12 (M9 hardening): a failed records fetch previously left `records` undefined
  // forever, which rendered the "Season records" heading with NOTHING underneath it — a bare
  // heading, not an honest empty/error surface. This distinguishes "still loading" (records
  // undefined, recordsError false) from "tried and failed" (recordsError true) so the section
  // can say so quietly instead.
  const [recordsError, setRecordsError] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [memberName, setMemberName] = useState("");
  const [addingMember, setAddingMember] = useState(false);
  const [memberError, setMemberError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!signedIn) return;
    void withAuth((token) => getCrew(token, id))
      .then((response) => setCrew(response.crew))
      .catch((caught: unknown) => setLoadError(humanizeCrewLoadError(caught)));
    // Records are a nicety layered on the page, not a gate on it: a failed records fetch
    // leaves the roster/join-code/preset fully usable (the JoinRoundPage peek-fallback
    // spirit), so this arm degrades to its own quiet line (below) instead of compounding onto
    // loadError.
    void withAuth((token) => getCrewRecords(token, id))
      .then((response) => {
        setRecords(response);
        setRecordsError(false);
      })
      .catch(() => setRecordsError(true));
  }, [signedIn, withAuth, id]);

  if (!signedIn) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 bg-slate-950 p-6 text-slate-100">
        <h1 className="text-2xl font-bold">Crew</h1>
        <p className="text-slate-400">Sign in to see your crew.</p>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 bg-slate-950 p-6 text-slate-100">
        <h1 className="text-2xl font-bold">Crew</h1>
        <p role="alert" className="text-red-400">
          {loadError}
        </p>
      </main>
    );
  }

  if (!crew) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 bg-slate-950 p-6 text-slate-100">
        <h1 className="text-2xl font-bold">Crew</h1>
        <p>Loading…</p>
      </main>
    );
  }

  const addMember = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = memberName.trim();
    if (!trimmed || addingMember) return;

    setAddingMember(true);
    setMemberError(undefined);
    try {
      // De-ghost (architecture-realignment Task 9): addCrewMember now takes an EXISTING account
      // golfer's golferId (the server requires a bound sub), not a free-text name — the M8
      // add-a-ghost-by-name flow is gone. This input carries the golferId for now; Task 11
      // rebuilds this into a proper member-picker.
      const response = await withAuth((token) => addCrewMember(token, id, { golferId: makeGolferId(trimmed) }));
      setCrew(response.crew);
      setMemberName("");
    } catch {
      setMemberError("Could not add the member — try again.");
    } finally {
      setAddingMember(false);
    }
  };

  const save = async (standingGame: StandingGameView) => {
    // Rethrows into StandingGameEditor's own error display — this seam only owns the wire
    // call and the crew refresh from its response.
    const response = await withAuth((token) => saveStandingGame(token, id, { standingGame }));
    setCrew(response.crew);
  };

  const playTheUsual = () => {
    if (!crew.standingGame) return;
    // Router-state hand-off (resolution 2, the EditCoursePage return precedent): CreateRoundPage
    // reads crewPreset out of location.state and renders it as its normal editable form state.
    // No crewId in the preset: round-is-a-sealed-leaf, the created round never names the crew —
    // the preset is pure client-side prefill (roster + standing game), nothing more.
    navigate("/create", { state: { crewPreset: { members: crew.members, standingGame: crew.standingGame } } });
  };

  // A ledger line can outlive its member row (projections keep history; rosters are edited) —
  // this returns undefined for a golferId with no current roster row, rather than guessing.
  const memberNameOf = (golferId: GolferId): string | undefined => crew.members.find((member) => member.golferId === golferId)?.name;

  // Head-to-head's inline prose ("Ann 5–5–2 vs Bo") has no room for a two-line breakdown —
  // "Former member" alone (never the full internal id bare) reads honestly there.
  const nameOf = (golferId: GolferId): string => memberNameOf(golferId) ?? "Former member";

  // Wins first, then points, both descending (resolution 3) — the wire's own order is the
  // store's (golferId-sorted, ledger.ts), which is not a standings order.
  const sortedLedger = records ? [...records.ledger].sort((a, b) => b.wins - a.wins || b.points - a.points) : [];
  const hasRecords = records !== undefined && (records.ledger.length > 0 || records.headToHead.length > 0);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-8 bg-slate-950 p-6 text-slate-100">
      <h1 className="text-2xl font-bold">{crew.name}</h1>

      {/* Papercut 5 (M9 hardening): always rendered now — disabled with an explainer when the
          crew has no preset yet, instead of vanishing outright, so a first-time visitor sees
          the affordance exists and knows exactly what unlocks it. */}
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={playTheUsual}
          disabled={!crew.standingGame}
          className="rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold disabled:opacity-50"
        >
          Play the usual
        </button>
        {!crew.standingGame && <p className="text-xs text-slate-500">Save a standing game first.</p>}
      </div>

      {/* The round-page join-code idiom (SetupPanel's own card) — this is how account-holding
          friends get into the crew. */}
      <div className="rounded-lg bg-slate-800 p-4 text-center">
        <p className="text-sm uppercase tracking-wide text-slate-400">Crew code</p>
        <p className="text-3xl font-bold tracking-widest">{crew.joinCode}</p>
        <p className="mt-1 text-xs text-slate-500">Friends with accounts join with this code</p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Roster</h2>
        <ul aria-label="Roster" className="flex flex-col gap-2">
          {crew.members.map((member) => (
            <li key={member.golferId} className="flex items-center gap-2 rounded-lg bg-slate-900 p-3">
              <span>{member.name}</span>
              {member.claimed && <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-emerald-400">account</span>}
            </li>
          ))}
        </ul>

        {/* Ghost-minting (papercut-legible form rules): a name is ALL it takes — the server
            mints a real, stable, claimable golfer for the holdout without an account. */}
        <form onSubmit={(event) => void addMember(event)} className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            Member name
            <input value={memberName} onChange={(event) => setMemberName(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg" />
          </label>
          {memberError && (
            <p role="alert" className="text-red-400">
              {memberError}
            </p>
          )}
          <button type="submit" disabled={addingMember} className="self-start rounded-lg bg-slate-800 px-4 py-3 font-semibold disabled:opacity-50">
            Add member
          </button>
          <p className="text-xs text-slate-500">For friends without accounts — they can claim their record later.</p>
        </form>
      </section>

      <StandingGameEditor members={crew.members} standingGame={crew.standingGame} onSave={save} />

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Season records{records ? ` — ${records.season}` : ""}</h2>
        {recordsError ? (
          <p className="text-slate-400">Could not load records right now.</p>
        ) : records === undefined ? null : !hasRecords ? (
          <p className="text-slate-400">Records build as crew rounds finalize.</p>
        ) : (
          <>
            {sortedLedger.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-slate-400">
                      <th className="py-1 pr-2 font-medium">Member</th>
                      <th className="py-1 pr-2 font-medium">Rounds</th>
                      <th className="py-1 pr-2 font-medium">W-L-H</th>
                      <th className="py-1 pr-2 font-medium">Points</th>
                      <th className="py-1 font-medium">Skins</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedLedger.map((line) => (
                      <tr key={line.golferId} className="border-t border-slate-800">
                        <td className="py-2 pr-2">
                          {/* Papercut 11 (M9 hardening): a departed member's ledger line reads
                              "Former member" + the truncated id as an honest secondary line,
                              never the bare truncated id alone (which looked like a rendering
                              bug, not a deliberate "this person left the roster" signal). */}
                          {memberNameOf(line.golferId) ?? (
                            <span className="flex flex-col">
                              <span>Former member</span>
                              <span className="text-xs text-slate-500">{line.golferId.slice(0, 8)}…</span>
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-2">{line.rounds}</td>
                        <td className="py-2 pr-2">{`${line.wins}–${line.losses}–${line.halves}`}</td>
                        <td className="py-2 pr-2">{line.points}</td>
                        <td className="py-2">{line.skins}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {records.headToHead.length > 0 && (
              <div>
                <h3 className="text-base font-semibold">Head to head</h3>
                <ul className="flex flex-col gap-1 text-sm text-slate-300">
                  {records.headToHead.map((h2h) => (
                    <li key={`${h2h.a}#${h2h.b}`}>{`${nameOf(h2h.a)} ${h2h.aWins}–${h2h.bWins}–${h2h.halves} vs ${nameOf(h2h.b)}`}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
