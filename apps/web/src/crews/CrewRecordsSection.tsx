import { useCallback, useEffect, useState } from "react";
import type { CrewId, GolferId } from "@swng/domain";
import type { CrewRecordsResponse } from "@swng/contracts";
import { getCrewRecords } from "../api";
import { useAuth } from "../auth/useAuth";
import { GolferLink } from "../ui/GolferLink";
import { cardBox } from "../ui/classes";
import { headToHeadLine } from "./headToHeadLine";

// Season names are FREE TEXT (docs/architecture.md's own examples include "Summer Cup"; the
// crewSeason e2e fixture season is "The Golden Dozen") — the "'{yy}" form is a CONVENTION that
// applies only when the name IS a year, never merely ends in two digits ("Summer Cup 2025" is
// not "2025" — whole-branch review, 2026-07-21, Finding 2). Applies iff the whole name is a
// 4-digit year; otherwise the season's own name renders verbatim beside the golfer name.
const seasonTitleSuffix = (seasonName: string): string => (/^\d{4}$/.test(seasonName) ? ` '${seasonName.slice(-2)}` : ` — ${seasonName}`);

// GET /crews/{crewId}/records (analytics read-folds spec 2026-07-21 §5): "All-time" — every
// counted round across every season, deduped by roundId, folded once. CrewPage renders this
// below the season list; unlike SeasonPanel (mounted `key={seasonId}` per season selection),
// this section has exactly one `crewId` prop and fetches once on mount. Assumes it's rendered
// only inside CrewPage's own signed-in tree (no `signedIn` check of its own — the SeasonPanel
// precedent: withAuth's own failure is what an unauthenticated call surfaces as).
export function CrewRecordsSection({ crewId }: { readonly crewId: CrewId }) {
  const { withAuth } = useAuth();
  const [records, setRecords] = useState<CrewRecordsResponse | undefined>(undefined);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const response = await withAuth((token) => getCrewRecords(token, crewId));
      setRecords(response);
    } catch {
      setError(true);
    }
  }, [withAuth, crewId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Renders nothing while loading (brief) — the honest fallback line only for a real failure,
  // never a raw error (M9 discipline).
  if (error) {
    return <p className="text-fairway">Records aren't available right now.</p>;
  }
  if (!records) return null;

  // Same name-resolution + sort idiom as SeasonPanel's own standings table — the all-time ledger
  // is the SAME SeasonStandingLine shape, so it reads identically.
  const nameByGolfer = new Map(records.ledger.map((line) => [line.golferId, line.name]));
  const nameOf = (id: GolferId): string => nameByGolfer.get(id) ?? id;
  const sortedLedger = [...records.ledger].sort((a, b) => b.wins - a.wins || b.points - a.points);

  return (
    <div className={`${cardBox} flex flex-col gap-4 p-4`}>
      <h3 className="text-lg font-semibold text-forest">All-time</h3>

      {sortedLedger.length === 0 ? (
        // Same two-truths distinction SeasonPanel's own empty-ledger copy draws (papercut 9):
        // never counted vs. counted-but-nobody-on-the-current-roster read differently.
        <p className="text-fairway">{records.rounds === 0 ? "No rounds counted yet." : "No current members appear in these counted rounds."}</p>
      ) : (
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
              {sortedLedger.map((line) => (
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
      )}

      {records.headToHead.length > 0 && (
        <div>
          <h4 className="text-base font-semibold text-forest">Head to head</h4>
          <ul aria-label="Head to head" className="flex flex-col gap-1 text-sm text-fairway">
            {records.headToHead.map((h2h) => (
              <li key={`${h2h.a}#${h2h.b}`}>{headToHeadLine(h2h, nameOf)}</li>
            ))}
          </ul>
        </div>
      )}

      {records.partners.length > 0 && (
        <div>
          <h4 className="text-base font-semibold text-forest">Partners — four-ball</h4>
          <ul className="flex flex-col gap-1 text-sm text-fairway">
            {records.partners.map((pair) => (
              <li key={`${pair.a}#${pair.b}`}>
                {pair.nameA} & {pair.nameB} — {pair.wins}–{pair.losses}
                {pair.halves > 0 && ` · ${pair.halves} halved`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Season titles (spec §5): each CLOSED season's Stableford points leader(s), rendered
          "{names} '{yy}" per season when the season's own name IS a year ("2024" → '24), else
          "{names} — {season name}" verbatim (seasonTitleSuffix above) — joined "·". Renders
          nothing when no season has closed with a title yet. */}
      {records.titles.length > 0 && (
        <p className="text-sm text-fairway">
          Stableford titles — {records.titles.map((title) => `${title.golfers.map((golfer) => golfer.name).join(" & ")}${seasonTitleSuffix(title.name)}`).join(" · ")}
        </p>
      )}
    </div>
  );
}
