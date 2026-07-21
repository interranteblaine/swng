import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { CrewId, GolferId, RoundId } from "@swng/domain";
import { formatHandicapIndex } from "@swng/domain";
import type { GetMyRoundsResponse, SeasonStandingsResponse } from "@swng/contracts";
import { appendCountedRound, ApiError, getMyRounds, getSeasonStandings, removeCountedRound } from "../api";
import { useAuth } from "../auth/useAuth";
import { GolferLink } from "../ui/GolferLink";
import { badge, btnSecondary, cardBox } from "../ui/classes";
import { headToHeadLine } from "./headToHeadLine";

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
    return <p className="text-fairway">Could not load this season — try again.</p>;
  }
  if (!standings) {
    return <p className="text-forest">Loading…</p>;
  }

  // A ledger line's `name` is already server-resolved (getSeasonStandings.ts) — head-to-head
  // still only carries raw golferIds, so this is the lookup from one to the other. Every
  // golferId in headToHead is also a ledger line (both built from the same fold), so the raw id
  // fallback below is unreachable in practice (crews are members-only now: standings only ever
  // aggregate this season's own crew members).
  const nameByGolfer = new Map(standings.ledger.map((line) => [line.golferId, line.name]));
  const nameOf = (id: GolferId): string => nameByGolfer.get(id) ?? id;

  // Standings order is served, not computed here (domain-boundary arc precedent: the web renders
  // no golf result) — aggregateSeason (packages/domain/src/crew/ledger.ts) ranks the ledger wins
  // desc, then points desc, then golferId asc, and this component renders it exactly as served.

  const countedIds = new Set(standings.rounds.map((round) => round.roundId));
  const uncounted = (myRounds ?? []).filter((round) => !countedIds.has(round.roundId));

  return (
    <div className={`${cardBox} flex flex-col gap-4 p-4`}>
      <h3 className="text-lg font-semibold text-forest">
        {standings.name}
        {standings.status === "closed" && <span className={`ml-2 ${badge}`}>closed</span>}
      </h3>

      {standings.ledger.length === 0 ? (
        <p className="text-fairway">
          {standings.rounds.length === 0
            ? "Standings build as rounds are counted."
            : "No current members appear in this season's counted rounds."}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="font-mono text-fairway">
                  <th className="py-1 pr-2 font-medium">Member</th>
                  <th className="py-1 pr-2 font-medium">Rounds</th>
                  <th className="py-1 pr-2 font-medium">Matches (W–L–H)</th>
                  <th className="py-1 pr-2 font-medium">Stableford pts</th>
                  <th className="py-1 font-medium">Skins</th>
                </tr>
              </thead>
              <tbody>
                {standings.ledger.map((line) => (
                  <tr key={line.golferId} className="border-t border-hairline text-forest">
                    <td className="py-2 pr-2">
                      <GolferLink golferId={line.golferId} name={line.name} />
                    </td>
                    <td className="py-2 pr-2 font-mono tabular-nums">{line.rounds}</td>
                    <td className="py-2 pr-2 font-mono tabular-nums">{`${line.wins}–${line.losses}–${line.halves}`}</td>
                    <td className="py-2 pr-2 font-mono tabular-nums">{line.points}</td>
                    <td className="py-2 font-mono tabular-nums">{line.skins}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="font-serif text-xs text-fairway">From this season&apos;s counted rounds — match results, Stableford points, and skins for current members.</p>
        </>
      )}

      {standings.headToHead.length > 0 && (
        <div>
          <h4 className="text-base font-semibold text-forest">Head to head</h4>
          <ul aria-label="Head to head" className="flex flex-col gap-1 text-sm text-fairway">
            {standings.headToHead.map((h2h) => (
              <li key={`${h2h.a}#${h2h.b}`}>{headToHeadLine(h2h, nameOf)}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Partner records (analytics read-folds spec 2026-07-21 §5): four-ball pairs, both current
          roster members — an empty list renders NOTHING (the ledger's own empty-state discipline,
          no footnote into an empty state). */}
      {standings.partners.length > 0 && (
        <div>
          <h4 className="text-base font-semibold text-forest">Partners — four-ball</h4>
          <ul className="flex flex-col gap-1 text-sm text-fairway">
            {standings.partners.map((pair) => (
              <li key={`${pair.a}#${pair.b}`}>
                {pair.nameA} & {pair.nameB} — {pair.wins}–{pair.losses}
                {pair.halves > 0 && ` · ${pair.halves} halved`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Season superlatives (analytics read-folds spec 2026-07-21 §5): lowest net average (ties
          share the entry, `golfers` naming all of them) and most improved (biggest swng-index drop
          first) — each superlative is independently absent when nobody qualifies, and the WHOLE
          block renders NOTHING when both are absent (no empty-state footnote). `from`/`to` are raw
          swng index values — rendered through `formatHandicapIndex` (never a bare signed number),
          same as every other index on screen. */}
      {(standings.superlatives.lowestNet ?? standings.superlatives.mostImproved) && (
        <div>
          <h4 className="text-base font-semibold text-forest">Season superlatives</h4>
          <ul className="flex flex-col gap-1 text-sm text-fairway">
            {standings.superlatives.lowestNet && (
              <li>
                Lowest net average — {standings.superlatives.lowestNet.golfers.map((golfer) => golfer.name).join(" & ")} ·{" "}
                {standings.superlatives.lowestNet.average.toFixed(1)} ({standings.superlatives.lowestNet.rounds} rounds
                {standings.superlatives.lowestNet.holes === 9 ? " · 9 holes" : ""})
              </li>
            )}
            {standings.superlatives.mostImproved?.map((entry) => (
              <li key={entry.golferId}>
                Most improved — {entry.name} · {formatHandicapIndex(entry.from)} → {formatHandicapIndex(entry.to)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h4 className="text-base font-semibold text-forest">Rounds counted</h4>
        {standings.rounds.length === 0 ? (
          <p className="text-fairway">No rounds counted yet.</p>
        ) : (
          <ul aria-label="Counted rounds" className="flex flex-col gap-2">
            {standings.rounds.map((round) => (
              <li key={round.roundId} className={`${cardBox} flex items-center justify-between gap-2 p-3`}>
                <Link to={`/rounds/${round.roundId}`} className="font-mono text-forest underline decoration-fairway">
                  {new Date(round.finalizedAt).toLocaleDateString()}
                </Link>
                {/* Remove affordance ONLY on rows the caller themselves appended (task-11-brief.md
                    binding resolution) — mirrors removeCountedRound.ts's own not-the-appender
                    403, shown here as an absent button rather than a doomed request. */}
                {round.appendedBy === myGolferId && (
                  <button type="button" onClick={() => void remove(round.roundId)} disabled={pendingRoundId === round.roundId} className="text-xs text-oxblood underline disabled:opacity-50">
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {removeError && (
          <p role="alert" className="text-oxblood">
            {removeError}
          </p>
        )}
      </div>

      {!picking ? (
        <button type="button" onClick={openPicker} className={`${btnSecondary} self-start`}>
          Count a round…
        </button>
      ) : (
        <div className={`${cardBox} flex flex-col gap-2 p-3`}>
          <div className="flex items-center justify-between">
            <span className="font-medium text-forest">Pick a round</span>
            <button type="button" onClick={() => setPicking(false)} className="text-sm text-forest underline decoration-fairway">
              Close
            </button>
          </div>
          {myRounds === undefined ? (
            <p className="text-fairway">Loading…</p>
          ) : uncounted.length === 0 ? (
            <p className="text-fairway">You have no uncounted finalized rounds.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {uncounted.map((round) => (
                <li key={round.roundId}>
                  <button
                    type="button"
                    onClick={() => void count(round.roundId)}
                    disabled={pendingRoundId === round.roundId}
                    className={`${cardBox} w-full p-3 text-left disabled:opacity-50`}
                  >
                    <span className="text-forest">{round.courseName}</span> <span className="font-mono text-fairway">— {round.tee}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {pickError && (
            <p role="alert" className="text-oxblood">
              {pickError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
