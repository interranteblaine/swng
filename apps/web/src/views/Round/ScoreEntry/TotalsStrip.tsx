import { useMemo } from "react";
import type { RoundSnapshot } from "@swng/domain";
import {
  buildScoreIndex,
  computeOutFromIndex,
  computeInFromIndex,
  computeTotalFromIndex,
  computeParThroughPlayedHoles,
  formatRelative,
  sortPlayersByTotalFromIndex,
} from "@/lib/roundCalcs";

type TotalsStripProps = {
  snapshot: RoundSnapshot;
};

export function TotalsStrip({ snapshot }: TotalsStripProps) {
  const rows = useMemo(() => {
    const index = buildScoreIndex(snapshot);
    const orderedPlayers = sortPlayersByTotalFromIndex(index, snapshot.players);

    return orderedPlayers.map((p) => {
      const out = computeOutFromIndex(index, p.playerId);
      const inn = computeInFromIndex(index, p.playerId);
      const total = computeTotalFromIndex(index, p.playerId);
      const parPlayed = computeParThroughPlayedHoles(snapshot, index, p.playerId);
      const toPar = total > 0 ? formatRelative(total - parPlayed) : "—";

      return {
        playerId: p.playerId,
        name: p.name,
        out,
        inn,
        total,
        toPar,
      };
    });
  }, [snapshot]);

  return (
    <div className="overflow-x-auto border-t border-gray-200 py-2">
      <table className="w-full border-collapse text-center text-sm">
        <thead>
          <tr className="bg-navy text-white">
            <th className="px-3 py-2 text-left font-semibold">Player</th>
            <th className="px-3 py-2 font-semibold">Out</th>
            <th className="px-3 py-2 font-semibold">In</th>
            <th className="px-3 py-2 font-semibold">Tot</th>
            <th className="px-3 py-2 font-semibold">+/-</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.playerId} className="border-b border-gray-100">
              <td className="px-3 py-2 text-left font-medium">{r.name}</td>
              <td className="px-3 py-2">{r.out || "—"}</td>
              <td className="px-3 py-2">{r.inn || "—"}</td>
              <td className="px-3 py-2">{r.total || "—"}</td>
              <td className="px-3 py-2">{r.toPar}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
