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
    <div style={{ overflowX: "auto", padding: "8px 0", borderTop: "1px solid var(--ion-border-color, #c8c7cc)" }}>
      <table
        style={{
          width: "100%",
          fontSize: "0.8rem",
          borderCollapse: "collapse",
          textAlign: "center",
        }}
      >
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "4px 8px" }}>Player</th>
            <th style={{ padding: "4px 8px" }}>Out</th>
            <th style={{ padding: "4px 8px" }}>In</th>
            <th style={{ padding: "4px 8px" }}>Tot</th>
            <th style={{ padding: "4px 8px" }}>+/-</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.playerId}>
              <td style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500 }}>
                {r.name}
              </td>
              <td style={{ padding: "4px 8px" }}>{r.out || "—"}</td>
              <td style={{ padding: "4px 8px" }}>{r.inn || "—"}</td>
              <td style={{ padding: "4px 8px" }}>{r.total || "—"}</td>
              <td style={{ padding: "4px 8px" }}>{r.toPar}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
