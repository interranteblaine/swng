import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { crewId as makeCrewId } from "@swng/domain";
import type { CrewSeasonView, CrewView } from "@swng/contracts";
import { ApiError, createSeason, getCrew, leaveCrew, listSeasons } from "../api";
import { useAuth } from "../auth/useAuth";
import { SeasonPanel } from "./SeasonPanel";

// A crew load can fail two honest ways the wire names (errorMapping.ts) — both get human
// copy, never the raw server text (the M7 discipline: raw messages carry internal ids).
const humanizeCrewLoadError = (caught: unknown): string => {
  if (caught instanceof ApiError && caught.code === "not-a-member") return "You're not a member of this crew.";
  if (caught instanceof ApiError && caught.code === "unknown-crew") return "This crew doesn't exist — check the link.";
  return "Could not load this crew — try again.";
};

// createSeason's own inline 1-60 bound (application/src/crews/createSeason.ts) — the ONE
// documented failure code it can throw beyond the shared member-gate 403/404s. Never the raw
// server text (M9 papercut discipline): the raw message echoes the caller's own typed name
// back in server vocabulary, not something a golfer acts on.
const humanizeCreateSeasonError = (caught: unknown): string => {
  if (caught instanceof ApiError && caught.code === "invalid-season-name") return "Season name must be 1–60 characters.";
  return "Could not create the season — try again.";
};

const humanizeLeaveError = (caught: unknown): string => {
  if (caught instanceof ApiError && caught.code === "unknown-crew") return "This crew doesn't exist — check the link.";
  return "Could not leave the crew — try again.";
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
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  // Architecture-realignment Task 11: seasons + counted rounds + standings-on-read replace the
  // old crew projection layer's "Season records" section entirely (Task 9's backend, this
  // task's web). `seasons` undefined = still loading; `seasonsError` = tried and failed —
  // same three-state split CrewPage already used for the deleted records section (papercut 12).
  const [seasons, setSeasons] = useState<readonly CrewSeasonView[] | undefined>(undefined);
  const [seasonsError, setSeasonsError] = useState(false);
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | undefined>(undefined);
  const [newSeasonName, setNewSeasonName] = useState("");
  const [creatingSeason, setCreatingSeason] = useState(false);
  const [createSeasonError, setCreateSeasonError] = useState<string | undefined>(undefined);

  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!signedIn) return;
    void withAuth((token) => getCrew(token, id))
      .then((response) => setCrew(response.crew))
      .catch((caught: unknown) => setLoadError(humanizeCrewLoadError(caught)));
    // Seasons are member-gated the SAME way (crews/membership.ts) but rendered as their own
    // section below — a failed fetch degrades that section quietly, same spirit as the deleted
    // records section's own papercut-12 fix, never compounding onto loadError (roster/join-code
    // stay usable either way).
    void withAuth((token) => listSeasons(token, id))
      .then((response) => {
        setSeasons(response.seasons);
        setSeasonsError(false);
      })
      .catch(() => setSeasonsError(true));
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

  const submitNewSeason = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = newSeasonName.trim();
    if (!trimmed || creatingSeason) return;

    setCreatingSeason(true);
    setCreateSeasonError(undefined);
    try {
      const response = await withAuth((token) => createSeason(token, id, { name: trimmed }));
      setSeasons((current) => [response.season, ...(current ?? [])]);
      setNewSeasonName("");
      setSelectedSeasonId(response.season.seasonId); // straight into the season just created
    } catch (caught) {
      setCreateSeasonError(humanizeCreateSeasonError(caught));
    } finally {
      setCreatingSeason(false);
    }
  };

  const confirmLeave = async () => {
    setLeaving(true);
    setLeaveError(undefined);
    try {
      await withAuth((token) => leaveCrew(token, id));
      navigate("/");
    } catch (caught) {
      setLeaveError(humanizeLeaveError(caught));
      setLeaving(false);
    }
  };

  // Newest createdAtMs first (task-11-brief.md: "NO order promised — sort client-side") — the
  // use case already sorts this way server-side (listSeasons.ts), but a freshly-created season
  // is prepended locally above, so this re-sort is what keeps a same-page create honest too.
  const sortedSeasons = seasons ? [...seasons].sort((a, b) => b.createdAtMs - a.createdAtMs) : [];

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-8 bg-slate-950 p-6 text-slate-100">
      <h1 className="text-2xl font-bold">{crew.name}</h1>

      {/* The round-page join-code idiom (SetupPanel's own card) — this is how account-holding
          friends get into the crew. Architecture-realignment Task 9/11 (de-ghost): a free-text
          ghost add no longer exists anywhere — the join code (here) and a claimed golfer joining
          by their own account are the only ways the roster grows now. */}
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
      </section>

      {/* Architecture-realignment Task 11: seasons + counted rounds + standings-on-read replace
          the old "Season records" ledger table entirely — a season list here, SeasonPanel does
          the standings/head-to-head/counted-rounds/count-a-round work once one is picked. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Seasons</h2>

        {seasonsError ? (
          <p className="text-slate-400">Could not load seasons right now.</p>
        ) : seasons !== undefined && sortedSeasons.length === 0 ? (
          <p className="text-slate-400">No seasons yet — start one below.</p>
        ) : (
          <ul aria-label="Seasons" className="flex flex-col gap-2">
            {sortedSeasons.map((season) => (
              <li key={season.seasonId}>
                <button
                  type="button"
                  onClick={() => setSelectedSeasonId(season.seasonId)}
                  className={`w-full rounded-lg px-4 py-3 text-left ${
                    selectedSeasonId === season.seasonId ? "bg-emerald-700" : "bg-slate-800"
                  }`}
                >
                  {season.name}
                  {season.status === "closed" && <span className="ml-2 text-xs text-slate-400">closed</span>}
                </button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={(event) => void submitNewSeason(event)} className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            New season
            <input
              value={newSeasonName}
              onChange={(event) => setNewSeasonName(event.target.value)}
              maxLength={60}
              className="rounded-lg bg-slate-800 p-3 text-lg"
            />
          </label>
          {createSeasonError && (
            <p role="alert" className="text-red-400">
              {createSeasonError}
            </p>
          )}
          <button type="submit" disabled={creatingSeason} className="self-start rounded-lg bg-slate-800 px-4 py-3 font-semibold disabled:opacity-50">
            Create season
          </button>
        </form>

        {/* key={selectedSeasonId}: a fresh mount per season selection is the simplest correct
            reset — no seasonId-changed effect dance needed inside SeasonPanel itself. */}
        {selectedSeasonId && <SeasonPanel key={selectedSeasonId} crewId={id} seasonId={selectedSeasonId} myGolferId={auth.golfer?.golferId} />}
      </section>

      {/* Architecture-realignment Task 11: "Leave crew" — the caller's own membership only,
          with a confirm step (ClaimAffordance's own click-to-reveal-Confirm/Cancel idiom, not a
          native confirm() — consistent with the rest of the app's chrome). */}
      <section className="flex flex-col gap-2">
        {!confirmingLeave ? (
          <button type="button" onClick={() => setConfirmingLeave(true)} className="self-start text-sm text-red-400 underline">
            Leave crew
          </button>
        ) : (
          <span role="dialog" aria-label="Confirm leave" className="flex items-center gap-2 text-sm">
            <span className="text-slate-300">Leave {crew.name}?</span>
            <button
              type="button"
              onClick={() => void confirmLeave()}
              disabled={leaving}
              className="rounded-md bg-red-700 px-2 py-1 font-medium text-slate-100 disabled:opacity-50"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirmingLeave(false)}
              disabled={leaving}
              className="rounded-md bg-slate-800 px-2 py-1 text-slate-300 disabled:opacity-50"
            >
              Cancel
            </button>
          </span>
        )}
        {leaveError && (
          <p role="alert" className="text-red-400">
            {leaveError}
          </p>
        )}
      </section>
    </main>
  );
}
