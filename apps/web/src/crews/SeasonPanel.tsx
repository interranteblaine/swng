import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { CrewId, GolferId, RoundId } from "@swng/domain";
import type { GetMyRoundsResponse, SeasonStandingsResponse } from "@swng/contracts";
import { appendCountedRound, ApiError, getMyRounds, getSeasonStandings, removeCountedRound } from "../api";
import { useAuth } from "../auth/useAuth";

export interface SeasonPanelProps {
  readonly crewId: CrewId;
  readonly seasonId: string;
  // The same GET-/me-derived source ProfilePage/CrewPage's own identity chrome uses (useAuth's
  // `auth.golfer`) — undefined while identity is still loading, or for a signed-in sub with no
  // account golfer yet. With no golferId, no counted-round row can ever show a remove
  // affordance (the appendedBy match below can never be true), which is the honest outcome.
  readonly myGolferId: GolferId | undefined;
}

// appendCountedRound's own documented failure codes it can throw beyond the shared member-gate
// 403/404s (application/src/crews/appendCountedRound.ts) — never the raw server text (M9
// papercut discipline): round-already-counted's raw message names the crew/season/round's own
// internal ids, nothing a golfer acts on.
const humanizeAppendError = (caught: unknown): string => {
  if (caught instanceof ApiError && caught.code === "round-already-counted") return "Already counted for this season.";
  if (caught instanceof ApiError && caught.code === "season-closed") return "This season is closed.";
  return "Could not count that round — try again.";
};

// Head-to-head as a sentence, leader first — never the raw a/b row order.
const describeHeadToHead = (h2h: SeasonStandingsResponse["headToHead"][number], nameOf: (id: GolferId) => string): string => {
  const base =
    h2h.aWins === h2h.bWins
      ? `${nameOf(h2h.a)} and ${nameOf(h2h.b)} are tied ${h2h.aWins}–${h2h.bWins}`
      : h2h.aWins > h2h.bWins
        ? `${nameOf(h2h.a)} leads ${nameOf(h2h.b)} ${h2h.aWins}–${h2h.bWins}`
        : `${nameOf(h2h.b)} leads ${nameOf(h2h.a)} ${h2h.bWins}–${h2h.aWins}`;
  return h2h.halves > 0 ? `${base} · ${h2h.halves} halved` : base;
};

// GET /crews/{crewId}/seasons/{seasonId}/standings (architecture-realignment Task 9/11):
// standings are computed on read — this is the ONE place the web renders them. CrewPage renders
// this once a season is picked from its own list (`key={seasonId}` at that call site gives every
// season selection a fresh mount — the simplest correct reset, no seasonId-changed effect dance
// needed here).
export function SeasonPanel({ crewId, seasonId, myGolferId }: SeasonPanelProps) {
  const { withAuth } = useAuth();

  const [standings, setStandings] = useState<SeasonStandingsResponse | undefined>(undefined);
  const [standingsError, setStandingsError] = useState(false);

  // async/await + try/catch (not a .then/.catch chain) so an accidentally-unmocked test double
  // (a bare vi.fn() resolving to undefined) can never throw INSIDE a .then callback and get
  // silently swallowed by the wrong catch — the real failure mode this component cares about
  // (a rejected fetch) is caught exactly the same way either way.
  const load = useCallback(async () => {
    setStandingsError(false);
    try {
      const response = await withAuth((token) => getSeasonStandings(token, crewId, seasonId));
      setStandings(response);
    } catch {
      setStandingsError(true);
    }
  }, [withAuth, crewId, seasonId]);

  useEffect(() => {
    void load();
  }, [load]);

  const [picking, setPicking] = useState(false);
  const [myRounds, setMyRounds] = useState<GetMyRoundsResponse["rounds"] | undefined>(undefined);
  const [pickError, setPickError] = useState<string | undefined>(undefined);
  const [pendingRoundId, setPendingRoundId] = useState<RoundId | undefined>(undefined);
  const [removeError, setRemoveError] = useState<string | undefined>(undefined);

  const openPicker = () => {
    setPicking(true);
    setPickError(undefined);
    setMyRounds(undefined);
    void withAuth((token) => getMyRounds(token))
      .then((response) => setMyRounds(response.rounds))
      .catch(() => setPickError("Could not load your rounds — try again."));
  };

  const count = async (roundId: RoundId) => {
    setPendingRoundId(roundId);
    setPickError(undefined);
    try {
      await withAuth((token) => appendCountedRound(token, crewId, seasonId, { roundId }));
      await load();
    } catch (caught) {
      setPickError(humanizeAppendError(caught));
    } finally {
      setPendingRoundId(undefined);
    }
  };

  const remove = async (roundId: RoundId) => {
    setPendingRoundId(roundId);
    setRemoveError(undefined);
    try {
      await withAuth((token) => removeCountedRound(token, crewId, seasonId, roundId));
      await load();
    } catch {
      setRemoveError("Could not remove that round — try again.");
    } finally {
      setPendingRoundId(undefined);
    }
  };

  if (standingsError) {
    return <p className="text-slate-400">Could not load this season — try again.</p>;
  }
  if (!standings) {
    return <p>Loading…</p>;
  }

  // A ledger line's `name` is already server-resolved (getSeasonStandings.ts) — head-to-head
  // still only carries raw golferIds, so this is the lookup from one to the other. Every
  // golferId in headToHead is also a ledger line (both built from the same fold), so the raw id
  // fallback below is unreachable in practice (crews are members-only now: standings only ever
  // aggregate this season's own crew members).
  const nameByGolfer = new Map(standings.ledger.map((line) => [line.golferId, line.name]));
  const nameOf = (id: GolferId): string => nameByGolfer.get(id) ?? id;

  // Wins first, then points, both descending — the same standings order CrewPage's own (now
  // deleted) records table used.
  const sortedLedger = [...standings.ledger].sort((a, b) => b.wins - a.wins || b.points - a.points);

  const countedIds = new Set(standings.rounds.map((round) => round.roundId));
  const uncounted = (myRounds ?? []).filter((round) => !countedIds.has(round.roundId));

  return (
    <div className="flex flex-col gap-4 rounded-lg bg-slate-900 p-4">
      <h3 className="text-lg font-semibold">
        {standings.name}
        {standings.status === "closed" && <span className="ml-2 text-xs text-slate-500">closed</span>}
      </h3>

      {sortedLedger.length === 0 ? (
        <p className="text-slate-400">
          {standings.rounds.length === 0
            ? "Standings build as rounds are counted."
            : "No current members appear in this season's counted rounds."}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-slate-400">
                  <th className="py-1 pr-2 font-medium">Member</th>
                  <th className="py-1 pr-2 font-medium">Rounds</th>
                  <th className="py-1 pr-2 font-medium">Matches (W–L–H)</th>
                  <th className="py-1 pr-2 font-medium">Stableford pts</th>
                  <th className="py-1 font-medium">Skins</th>
                </tr>
              </thead>
              <tbody>
                {sortedLedger.map((line) => (
                  <tr key={line.golferId} className="border-t border-slate-800">
                    <td className="py-2 pr-2">{line.name}</td>
                    <td className="py-2 pr-2">{line.rounds}</td>
                    <td className="py-2 pr-2">{`${line.wins}–${line.losses}–${line.halves}`}</td>
                    <td className="py-2 pr-2">{line.points}</td>
                    <td className="py-2">{line.skins}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">From this season&apos;s counted rounds — match results, Stableford points, and skins for current members.</p>
        </>
      )}

      {standings.headToHead.length > 0 && (
        <div>
          <h4 className="text-base font-semibold">Head to head</h4>
          <ul className="flex flex-col gap-1 text-sm text-slate-300">
            {standings.headToHead.map((h2h) => (
              <li key={`${h2h.a}#${h2h.b}`}>{describeHeadToHead(h2h, nameOf)}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h4 className="text-base font-semibold">Rounds counted</h4>
        {standings.rounds.length === 0 ? (
          <p className="text-slate-400">No rounds counted yet.</p>
        ) : (
          <ul aria-label="Counted rounds" className="flex flex-col gap-2">
            {standings.rounds.map((round) => (
              <li key={round.roundId} className="flex items-center justify-between gap-2 rounded-lg bg-slate-800 p-3">
                <Link to={`/rounds/${round.roundId}/archive`} className="underline decoration-slate-600 underline-offset-2 hover:decoration-slate-400">
                  {new Date(round.finalizedAt).toLocaleDateString()}
                </Link>
                {/* Remove affordance ONLY on rows the caller themselves appended (task-11-brief.md
                    binding resolution) — mirrors removeCountedRound.ts's own not-the-appender
                    403, shown here as an absent button rather than a doomed request. */}
                {round.appendedBy === myGolferId && (
                  <button
                    type="button"
                    onClick={() => void remove(round.roundId)}
                    disabled={pendingRoundId === round.roundId}
                    className="text-xs text-red-400 underline disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {removeError && (
          <p role="alert" className="text-red-400">
            {removeError}
          </p>
        )}
      </div>

      {!picking ? (
        <button type="button" onClick={openPicker} className="self-start rounded-lg bg-slate-800 px-4 py-3 font-semibold">
          Count a round…
        </button>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg bg-slate-800 p-3">
          <div className="flex items-center justify-between">
            <span className="font-medium">Pick a round</span>
            <button type="button" onClick={() => setPicking(false)} className="text-sm text-emerald-400 underline">
              Close
            </button>
          </div>
          {myRounds === undefined ? (
            <p className="text-slate-400">Loading…</p>
          ) : uncounted.length === 0 ? (
            <p className="text-slate-400">You have no uncounted finalized rounds.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {uncounted.map((round) => (
                <li key={round.roundId}>
                  <button
                    type="button"
                    onClick={() => void count(round.roundId)}
                    disabled={pendingRoundId === round.roundId}
                    className="w-full rounded-lg bg-slate-900 p-3 text-left disabled:opacity-50"
                  >
                    {round.courseName} — {round.tee}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {pickError && (
            <p role="alert" className="text-red-400">
              {pickError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
