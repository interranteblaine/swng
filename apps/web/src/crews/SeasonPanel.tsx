import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { CrewId, GolferId } from "@swng/domain";
import { formatHandicapIndex } from "@swng/domain";
import type { SeasonStandingsResponse } from "@swng/contracts";
import { closeSeason, getSeasonStandings, reopenSeason } from "../api";
import { useAuth } from "../auth/useAuth";
import { GolferLink } from "../ui/GolferLink";
import { badge, btnDangerSolid, btnQuiet, btnSecondary, cardBox } from "../ui/classes";
import { vsPar } from "../ui/vsPar";
import { headToHeadLine } from "./headToHeadLine";

export interface SeasonPanelProps {
  readonly crewId: CrewId;
  readonly seasonId: string;
  // close-season spec 2026-07-21 §2: the organizer-only Close/Reopen verbs render off the SAME
  // caller-role fact CrewPage already computes for the roster's Remove…/Make organizer…
  // affordances (crew.members.some(role === "organizer")) — threaded through rather than
  // recomputed here, since SeasonPanel has no roster of its own to derive it from.
  readonly isOrganizer: boolean;
}

// Local presentation only — arithmetic view logic over numbers the wire already computed
// (window bounds → local dates), never golf rules.
const formatWindowDate = (ms: number): string => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(ms));

// GET /crews/{crewId}/seasons/{seasonId}/standings (crew-scoreboard spec §3/§4): the season is a
// time WINDOW, and everything below is DERIVED on read from each roster member's own finalized
// rounds — no counting act, ever (spec §1: "the crew watches; members just play"). CrewPage
// renders this once a season is picked from its own list (`key={seasonId}` at that call site
// gives every season selection a fresh mount — the simplest correct reset, no seasonId-changed
// effect dance needed here).
export function SeasonPanel({ crewId, seasonId, isOrganizer }: SeasonPanelProps) {
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

  // close-season spec 2026-07-21 §2: the organizer's own verbs. Close gets a click-to-reveal
  // confirm (CrewPage's own Leave crew/Remove member/Make organizer idiom — role="dialog", a
  // btnDangerSolid Confirm + btnSecondary Cancel) carrying the EXACT teaching line the spec
  // pins; Reopen is one tap, no confirm (spec §1.3: "first-class, not an apology" — reopening
  // loses nothing, titles are a read fold that simply stop/resume appearing). Both are
  // api-then-refetch through the SAME `load()` this component already uses above — no
  // optimistic write, and the honest fallback line covers both verbs alike (no per-code text,
  // since the UI never offers a door the server would 409 in the normal case).
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [closeReopenBusy, setCloseReopenBusy] = useState(false);
  const [closeReopenError, setCloseReopenError] = useState<string | undefined>(undefined);

  const confirmClose = async () => {
    setCloseReopenBusy(true);
    setCloseReopenError(undefined);
    try {
      await withAuth((token) => closeSeason(token, crewId, seasonId));
      await load();
      setConfirmingClose(false);
    } catch {
      setCloseReopenError("Could not update the season — try again.");
    } finally {
      setCloseReopenBusy(false);
    }
  };

  const reopen = async () => {
    setCloseReopenBusy(true);
    setCloseReopenError(undefined);
    try {
      await withAuth((token) => reopenSeason(token, crewId, seasonId));
      await load();
    } catch {
      setCloseReopenError("Could not update the season — try again.");
    } finally {
      setCloseReopenBusy(false);
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
          <h3 className="text-lg font-semibold text-forest">
            {standings.name}
            {standings.status === "closed" && <span className={`ml-2 ${badge}`}>closed</span>}
          </h3>
          {/* close-season spec 2026-07-21 §2: organizer-only, never gold (btnQuiet — the panel's
              existing primary actions keep the screen's one gold). A non-organizer sees the badge
              above with no verb at all. */}
          {isOrganizer && standings.status === "open" && !confirmingClose && (
            <button type="button" onClick={() => setConfirmingClose(true)} className={btnQuiet}>
              Close season
            </button>
          )}
          {isOrganizer && standings.status === "closed" && (
            <button type="button" onClick={() => void reopen()} disabled={closeReopenBusy} className={btnQuiet}>
              {closeReopenBusy ? "Reopening…" : "Reopen"}
            </button>
          )}
        </div>
        {/* The window (crew-scoreboard spec §2/§5): local dates, mono, the anchor-date precedent
            (RecordSections.tsx's own chart anchors). Open reads as "Since {start}" — no end date
            to name yet; closed names both ends. */}
        <p className="font-mono text-xs text-fairway">
          {standings.status === "open" || standings.closedAtMs === undefined
            ? `Since ${formatWindowDate(standings.startsAtMs)}`
            : `${formatWindowDate(standings.startsAtMs)} – ${formatWindowDate(standings.closedAtMs)}`}
        </p>
      </div>

      {confirmingClose && (
        <span role="dialog" aria-label="Confirm close season" className="flex flex-col gap-2 text-sm">
          <span className="text-fairway">Closing ends the season — rounds finalized after this stay out of it, and its titles are awarded. You can reopen it later.</span>
          <span className="flex items-center gap-2">
            <button type="button" onClick={() => void confirmClose()} disabled={closeReopenBusy} className={`${btnDangerSolid} disabled:opacity-50`}>
              {closeReopenBusy ? "Closing…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmingClose(false);
                setCloseReopenError(undefined);
              }}
              disabled={closeReopenBusy}
              className={`${btnSecondary} disabled:opacity-50`}
            >
              Cancel
            </button>
          </span>
        </span>
      )}
      {closeReopenError && (
        <p role="alert" className="text-oxblood">
          {closeReopenError}
        </p>
      )}

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
