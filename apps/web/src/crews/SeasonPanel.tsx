import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { CrewId, GolferId } from "@swng/domain";
import { formatHandicapIndex } from "@swng/domain";
import type { SeasonStandingsResponse } from "@swng/contracts";
import { getSeasonStandings } from "../api";
import { useAuth } from "../auth/useAuth";
import { GolferLink } from "../ui/GolferLink";
import { cardBox } from "../ui/classes";
import { vsPar } from "../ui/vsPar";
import { headToHeadLine } from "./headToHeadLine";

export interface SeasonPanelProps {
  readonly crewId: CrewId;
  readonly seasonId: string;
  // Reserved for the organizer-only season-editing affordance (spec 2026-07-22 "the season is
  // the record" §2: editing the end date IS the whole lifecycle now — no close/reopen verb
  // renders off this anymore) — threaded through from CrewPage the same way the roster's own
  // Remove…/Make organizer… affordances are, since SeasonPanel has no roster of its own to
  // derive it from.
  readonly isOrganizer: boolean;
}

// Local presentation only — a plain "YYYY-MM-DD" string split into "Jan 1, 2026" (NEVER a
// `new Date` local-time conversion — a date-only string like "2026-01-01" parsed as local time
// can roll to the PRIOR calendar day west of UTC, the exact artifact class spec 2026-07-22 §5
// calls out).
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const formatWindowDate = (isoDate: string): string => {
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${MONTH_NAMES[month! - 1]} ${day}, ${year}`;
};

// GET /crews/{crewId}/seasons/{seasonId}/standings (crew-scoreboard spec §3/§4): the season is a
// time WINDOW, and everything below is DERIVED on read from each roster member's own finalized
// rounds — no counting act, ever (spec §1: "the crew watches; members just play"). CrewPage
// renders this once a season is picked from its own list (`key={seasonId}` at that call site
// gives every season selection a fresh mount — the simplest correct reset, no seasonId-changed
// effect dance needed here).
export function SeasonPanel({ crewId, seasonId }: SeasonPanelProps) {
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

  // Every row/list below renders exactly what the wire served — no client-side sort, no
  // re-derivation of golf math (domain-boundary arc precedent: the web renders no golf result).
  // aggregateSeason (packages/domain/src/crew/ledger.ts) ranks the ledger; crewScoreboard
  // (packages/domain/src/crew/scoreboard.ts) ranks the scoreboard — both server-side, both
  // rendered here in SERVED order.

  const scoreboardEmpty = standings.scoreboard.every((row) => row.rounds === 0);

  return (
    <div className={`${cardBox} flex flex-col gap-4 p-4`}>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-lg font-semibold text-forest">{standings.name}</h3>
        </div>
        {/* The window (spec 2026-07-22 §1/§5): both dates are now REQUIRED and always visible —
            no more "Since {start}" open-ended reading; a season always names both ends. */}
        <p className="font-mono text-xs text-fairway">
          {formatWindowDate(standings.startsAt)} – {formatWindowDate(standings.endsAt)}
        </p>
      </div>

      {/* The scoreboard leads (crew-scoreboard spec §5) — one row per CURRENT roster member,
          `rounds: 0` included, served order (crewScoreboard's own total order — never re-sorted
          here). Every cell renders through the shared signed-number presentation discipline
          (vsPar/formatHandicapIndex) — a dash where the underlying stat hasn't built up yet. */}
      <div className="overflow-x-auto">
        <table aria-label="Scoreboard" className="w-full text-left text-sm">
          <thead>
            <tr className="font-mono text-fairway">
              <th className="py-1 pr-2 font-medium">Golfer</th>
              <th className="py-1 pr-2 font-medium">Rounds</th>
              <th className="py-1 pr-2 font-medium">Best 18</th>
              <th className="py-1 pr-2 font-medium">Net/18</th>
              <th className="py-1 font-medium">Index</th>
            </tr>
          </thead>
          <tbody>
            {standings.scoreboard.map((row) => (
              <tr key={row.golferId} className="border-t border-hairline text-forest">
                <td className="py-2 pr-2">
                  <GolferLink golferId={row.golferId} name={row.name} />
                </td>
                <td className="py-2 pr-2 font-mono tabular-nums">{row.rounds}</td>
                <td className="py-2 pr-2 font-mono tabular-nums">{row.best18 ? `${row.best18.gross} (${vsPar(row.best18.toPar, 0)})` : "—"}</td>
                <td className="py-2 pr-2 font-mono tabular-nums">{row.netPer18 !== undefined ? vsPar(row.netPer18, 0) : "—"}</td>
                <td className="py-2 font-mono tabular-nums">
                  {row.index !== undefined
                    ? `${formatHandicapIndex(row.index)}${row.indexDelta !== undefined ? ` (${row.indexDelta >= 0 ? "+" : "−"}${Math.abs(row.indexDelta).toFixed(1)})` : ""}`
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="font-serif text-xs text-fairway">
        Best 18 — lowest gross, fully holed out · Net/18 — net vs par per 18 holes, from adjusted scores; builds at 3 rounds · Index — swng index, with change over this
        season.
      </p>
      {scoreboardEmpty && <p className="text-fairway">Rounds appear here automatically when members finalize them.</p>}

      {standings.ledger.length === 0 ? (
        <p className="text-fairway">
          {standings.rounds.length === 0
            ? "Standings build automatically once members play together."
            : // Two truths, one honest sentence (papercut 9's distinction, widened): shared rounds
              // exist but the roster-filtered ledger is empty either because the contributors have
              // since left the roster, OR because the shared rounds carried no games between
              // current members at all (e.g. a solo gameless round) — both read as "no standings
              // yet," never a false claim that members are missing.
              "No standings from these rounds yet — standings build from games between current members."}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table aria-label="Season standings" className="w-full text-left text-sm">
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
          <p className="font-serif text-xs text-fairway">From this season&apos;s shared rounds — match results, Stableford points, and skins for current members.</p>
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

      {/* "Played together" (crew-scoreboard spec §3b/§5): a DERIVED list of shared rounds, newest
          first — links preserved, no per-round Remove (there is nothing to remove; a round is
          "together" for exactly as long as >=2 current members' own lines say so). */}
      <div>
        <h4 className="text-base font-semibold text-forest">Played together</h4>
        {standings.rounds.length === 0 ? (
          <p className="text-fairway">No rounds played together yet.</p>
        ) : (
          <ul aria-label="Played together" className="flex flex-col gap-2">
            {standings.rounds.map((round) => (
              <li key={round.roundId} className={`${cardBox} flex items-center justify-between gap-2 p-3`}>
                <Link to={`/rounds/${round.roundId}`} className="font-mono text-forest underline decoration-fairway">
                  {new Date(round.finalizedAt).toLocaleDateString()}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
