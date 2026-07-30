import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { CrewId, GolferId } from "@swng/domain";
import { formatOverPar } from "@swng/domain";
import type { SeasonStandingsResponse } from "@swng/contracts";
import { getSeasonStandings, updateSeason } from "../api";
import { useAuth } from "../auth/useAuth";
import { dayCollisionChecker, roundLabel } from "../roundLabel";
import { GolferLink } from "../ui/GolferLink";
import { badge, btnQuiet, cardBox, inputBox } from "../ui/classes";
import { headToHeadLine } from "./headToHeadLine";

export interface SeasonPanelProps {
  readonly crewId: CrewId;
  readonly seasonId: string;
  // The organizer-only season-editing affordance (spec 2026-07-22 "the season is the record"
  // §2: editing the end date IS the whole lifecycle now — no close/reopen verb renders off this
  // anymore) — threaded through from CrewPage the same way the roster's own Remove…/Make
  // organizer… affordances are, since SeasonPanel has no roster of its own to derive it from.
  readonly isOrganizer: boolean;
}

// Local presentation only — plain "YYYY-MM-DD" strings split into month/day/year (NEVER a
// `new Date` local-time conversion — a date-only string like "2026-01-01" parsed as local time
// can roll to the PRIOR calendar day west of UTC, the exact artifact class spec 2026-07-22 §5
// calls out). The whole window is ONE function (not a per-date helper) because the year-once
// decision depends on BOTH ends: spec §5 pins "Jan 1 – Dec 31, 2026" — the year stated ONCE, at
// the very end, when both dates share a year. A cross-year window (the "wide dates" all-time
// board the spec's own "Want an all-time board? Give it wide dates." line makes first-class)
// would be ambiguous with a single trailing year, so both ends carry their own year instead —
// "Jan 1, 2020 – Dec 31, 2030", the same idiom the index chart uses for cross-year date anchors
// (2026-07-21-index-chart-polish-design.md).
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const formatWindowRange = (startIso: string, endIso: string): string => {
  const [startYear, startMonth, startDay] = startIso.split("-").map(Number);
  const [endYear, endMonth, endDay] = endIso.split("-").map(Number);
  const start = `${MONTH_NAMES[startMonth! - 1]} ${startDay}`;
  const end = `${MONTH_NAMES[endMonth! - 1]} ${endDay}`;
  return startYear === endYear ? `${start} – ${end}, ${endYear}` : `${start}, ${startYear} – ${end}, ${endYear}`;
};

// Live vs. Final (spec 2026-07-22 §1/§5): a derived label, nothing more — no stored `status`, no
// interaction beyond editing the dates themselves. Today's UTC date as "YYYY-MM-DD" — a plain
// STRING compare against `endsAt` (also "YYYY-MM-DD"), never a `new Date` local conversion. This
// is a date-string compare, not a golf compute — it lives web-side, outside the compute fence.
const todayUtcIso = (): string => new Date().toISOString().slice(0, 10);

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

  // Spec 2026-07-22 §2: editing the end date IS the whole lifecycle — an organizer-only Edit
  // (the roster-row edit idiom: SetupPanel.tsx's mid-round basis correction) swaps the header
  // for name + two date inputs + Save/Cancel. Save PUTs, then re-runs `load` (the SAME fetch the
  // initial mount uses) rather than trusting the response shape locally — one source of truth
  // for "what this season currently says."
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editStartsAt, setEditStartsAt] = useState("");
  const [editEndsAt, setEditEndsAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | undefined>(undefined);

  const startEdit = () => {
    if (!standings) return;
    setEditName(standings.name);
    setEditStartsAt(standings.startsAt);
    setEditEndsAt(standings.endsAt);
    setEditError(undefined);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditError(undefined);
  };

  const saveEdit = async () => {
    const trimmed = editName.trim();
    if (!trimmed || !editStartsAt || !editEndsAt || saving) return;
    setSaving(true);
    setEditError(undefined);
    try {
      await withAuth((token) => updateSeason(token, crewId, seasonId, { name: trimmed, startsAt: editStartsAt, endsAt: editEndsAt }));
      setEditing(false);
      await load();
    } catch {
      // Never a raw generic Error's message — createSeason's own copy-honesty discipline;
      // invalid-season-window is the one documented failure beyond the shared organizer/
      // not-found guards, but a golfer acts on all of them the same way: fix the dates, retry.
      setEditError("Could not update this season — try again.");
    } finally {
      setSaving(false);
    }
  };

  if (standingsError) {
    return <p className="text-fairway">Could not load this season — try again.</p>;
  }
  if (!standings) {
    return <p className="text-forest">Loading…</p>;
  }

  // Live vs. Final (spec §1/§5): derived, never stored — today's UTC date past the season's own
  // `endsAt` means the window is frozen by time itself.
  const isFinal = todayUtcIso() > standings.endsAt;

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
  // The canonical designation (spec 2026-07-22): each shared round renders as course + date, tee
  // time appended only to disambiguate two rounds that share course and day — the ONE shared
  // dayCollisionChecker, over exactly the rounds this list renders.
  const roundCollidesOnDay = dayCollisionChecker(standings.rounds);

  // The head-to-head strokes line (spec 2026-07-29 §6): comparing two crew-mates who have never
  // necessarily played together is the SAME rule a round applies at join (resolveStrokes,
  // packages/domain/src/scoring/strokeBasis.ts — strokes are the non-negative difference from
  // the lowest in the field), applied here to the board's own season averages instead of a
  // round's stated numbers. A subtraction of two already-SERVED numbers is not a golf result, so
  // this stays a component computation, not a @swng/domain export (the compute fence exempts
  // it). It is NOT a promise about what an actual round will produce — the round resolves from
  // what each player states THAT day, against their own career average, and either may state
  // something else entirely — which is exactly why the copy says "if you played tomorrow" rather
  // than naming the season.
  //
  // One line, not all C(n,2) pairs (a 12-member crew has 66) — the CLOSEST pair by average,
  // among members who both have one. Sorted ascending by average first (never assumed from wire
  // order — this is an internal lookup, not the visible table's own served-order row list) so
  // the minimum gap is always between some adjacent pair in that sorted list; scanning it once
  // finds the closest pair without checking every one of the C(n,2) pairs. A golfer who shoots
  // BETTER than par has a negative average, and the plain subtraction below is sign-agnostic —
  // it still finds the true minimum gap and still names the higher (worse) side. On a tie
  // between two gaps (e.g. averages 0/5/10, both adjacent gaps 5), the strict `<` below never
  // replaces an already-found pair with an equally-close one, so the FIRST pair encountered in
  // ascending order wins — deterministic, not incidental, and pinned by a test.
  //
  // Season averages are already whole numbers (averageOfValues rounds the mean before this ever
  // sees it), so the difference of any two is already an integer — there is no second rounding
  // rule to invent here. `resolveStrokes`' own halving is a rule for a 9-hole ROUND; this
  // comparison is over a season, with no single round's hole count to halve by.
  // `.filter` already returns a fresh array, so sorting it in place here never touches
  // `standings.scoreboard`'s own served order (still rendered untouched by the table above).
  const rankedByAverage = standings.scoreboard
    .filter((row): row is typeof row & { average: number } => row.average !== undefined)
    .sort((a, b) => a.average - b.average);
  let closestPair: { lower: string; higher: string; strokes: number } | undefined;
  for (let i = 0; i + 1 < rankedByAverage.length; i++) {
    const lower = rankedByAverage[i]!;
    const higher = rankedByAverage[i + 1]!;
    const strokes = higher.average - lower.average; // non-negative: rankedByAverage is ascending
    if (closestPair === undefined || strokes < closestPair.strokes) {
      closestPair = { lower: lower.name, higher: higher.name, strokes };
    }
  }
  // A tied closest pair is a real, interesting answer — not suppressed, and not "X gets 0" (a
  // nonsensical sentence once strokes are a non-negative count: nobody has ever "gotten" zero).
  // Its own sentence in the same register, naming both and the fact that neither gives strokes —
  // "plays level" mirrors dots.ts's own strokesSummary idiom for the identical zero-strokes case.
  const strokesHeadline =
    closestPair === undefined
      ? undefined
      : closestPair.strokes === 0
        ? `If you played tomorrow, ${closestPair.lower} and ${closestPair.higher} play level — nobody gets strokes.`
        : `If you played tomorrow, ${closestPair.higher} gets ${closestPair.strokes}.`;

  return (
    <div className={`${cardBox} flex flex-col gap-4 p-4`}>
      <div className="flex flex-col gap-1">
        {editing ? (
          <span className="flex flex-col gap-2">
            <input
              aria-label="Season name"
              className={`${inputBox} text-lg`}
              value={editName}
              maxLength={60}
              onChange={(event) => setEditName(event.target.value)}
            />
            <span className="flex gap-2">
              <label className="flex flex-1 flex-col gap-1 text-forest">
                Starts
                <input
                  type="date"
                  aria-label="Season starts"
                  value={editStartsAt}
                  onChange={(event) => setEditStartsAt(event.target.value)}
                  required
                  className={inputBox}
                />
              </label>
              <label className="flex flex-1 flex-col gap-1 text-forest">
                Ends
                <input
                  type="date"
                  aria-label="Season ends"
                  value={editEndsAt}
                  onChange={(event) => setEditEndsAt(event.target.value)}
                  required
                  className={inputBox}
                />
              </label>
            </span>
            <span className="flex items-center gap-2">
              <button type="button" className={btnQuiet} disabled={saving || !editName.trim()} onClick={() => void saveEdit()}>
                Save
              </button>
              <button type="button" className={btnQuiet} disabled={saving} onClick={cancelEdit}>
                Cancel
              </button>
            </span>
            {editError && (
              <p role="alert" className="text-oxblood">
                {editError}
              </p>
            )}
          </span>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-lg font-semibold text-forest">{standings.name}</h3>
              {isOrganizer && (
                <button type="button" className={`${btnQuiet} text-sm`} onClick={startEdit}>
                  Edit
                </button>
              )}
            </div>
            {/* The window (spec 2026-07-22 §1/§5): both dates are now REQUIRED and always
                visible — no more "Since {start}" open-ended reading; a season always names both
                ends. Beside it, a derived Live/Final marker (never stored, never interactive) —
                a Live season shows no marker; the dates already say it's current. */}
            <p className="font-mono text-xs text-fairway">
              {formatWindowRange(standings.startsAt, standings.endsAt)}
              {isFinal && <span className={`${badge} ml-2`}>Final</span>}
            </p>
          </>
        )}
      </div>

      {/* The scoreboard leads (crew-scoreboard spec §5) — one row per CURRENT roster member,
          `rounds: 0` included, served order (crewScoreboard's own total order — never re-sorted
          here). Rounds · Average · Spread · Best (spec 2026-07-29 §6): once every round collapses
          to one number in one unit, a golfer's record is a DISTRIBUTION, so the board describes it —
          average is level, spread is consistency, best is ceiling. Every signed cell renders through
          `formatOverPar`, the ONE vs-par renderer (spec §4) — a dash where the underlying stat
          hasn't built up yet.
          Spec 2026-07-22 §5: a VISIBLE `<h4>Standings` heading (this IS the real board — it
          serves both crew scenarios, played-together and remote — the missing heading was the
          owner's own field report), aria-label to match. */}
      <div>
        <h4 className="text-base font-semibold text-forest">Standings</h4>
        <div className="overflow-x-auto">
          <table aria-label="Standings" className="w-full text-left text-sm">
            <thead>
              <tr className="font-mono text-fairway">
                <th className="py-1 pr-2 font-medium">Golfer</th>
                <th className="py-1 pr-2 font-medium">Rounds</th>
                <th className="py-1 pr-2 font-medium">Average</th>
                <th className="py-1 pr-2 font-medium">Spread</th>
                <th className="py-1 font-medium">Best 18</th>
              </tr>
            </thead>
            <tbody>
              {standings.scoreboard.map((row) => (
                <tr key={row.golferId} className="border-t border-hairline text-forest">
                  <td className="py-2 pr-2">
                    <GolferLink golferId={row.golferId} name={row.name} />
                  </td>
                  <td className="py-2 pr-2 font-mono tabular-nums">{row.rounds}</td>
                  <td className="py-2 pr-2 font-mono tabular-nums">{row.average !== undefined ? formatOverPar(row.average) : "—"}</td>
                  {/* A spread is a magnitude, never signed — "±4.2" is the whole notation, so it
                      deliberately does NOT go through formatOverPar. */}
                  <td className="py-2 pr-2 font-mono tabular-nums">{row.spread !== undefined ? `±${row.spread.toFixed(1)}` : "—"}</td>
                  <td className="py-2 font-mono tabular-nums">{row.best18 ? `${row.best18.gross} (${formatOverPar(row.best18.toPar)})` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="font-serif text-xs text-fairway">
          Average — score minus par over this season&apos;s rounds, a nine counting double · Spread — how much those rounds vary; builds at 5 rounds · Best 18 —
          lowest gross, fully holed out.
        </p>
        {scoreboardEmpty && <p className="text-fairway">Rounds appear here automatically when members finalize them.</p>}
        {strokesHeadline && <p className="text-forest">{strokesHeadline}</p>}
      </div>

      {/* Spec 2026-07-22 §5: a VISIBLE `<h4>Games together` heading — the game ledger, renamed
          from an unlabeled "Season standings" table, keeps its own footnote and match/Stableford/
          skins columns. Its empty state never implies the standings above are missing. */}
      <div>
        <h4 className="text-base font-semibold text-forest">Games together</h4>
        {standings.ledger.length === 0 ? (
          <p className="text-fairway">
            {standings.rounds.length === 0
              ? "Appears when members play a round together."
              : // Two truths, one honest sentence (papercut 9's distinction, widened): shared
                // rounds exist but the roster-filtered ledger is empty either because the
                // contributors have since left the roster, OR because the shared rounds carried
                // no games between current members at all (e.g. a solo gameless round). Says
                // "games," not "standings" — the word "standings" is now the sibling section's
                // name above, and this is the GAMES ledger; never a false claim that members
                // are missing.
                "No games between current members in these rounds yet — matches, points, and skins show up here."}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table aria-label="Games together" className="w-full text-left text-sm">
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
      </div>

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
                  {roundLabel({ courseName: round.courseName, createdAt: round.createdAt }, { withTime: roundCollidesOnDay(round) })}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
