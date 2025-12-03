import { useMemo } from "react";
import { useRoundData } from "../Context/useRoundContext";
import {
  buildScoreIndex,
  computeInFromIndex,
  computeOutFromIndex,
  computeTotalFromIndex,
  computeParTotal,
  formatRelative,
  sortPlayersByTotalFromIndex,
} from "../../../lib/roundCalcs";

export function TotalsTab() {
  const { snapshot } = useRoundData();

  const rows = useMemo(() => {
    if (!snapshot) return [];

    const index = buildScoreIndex(snapshot);
    const coursePar = computeParTotal(snapshot);
    const orderedPlayers = sortPlayersByTotalFromIndex(index, snapshot.players);

    return orderedPlayers.map((p) => {
      const out = computeOutFromIndex(index, p.playerId);
      const inn = computeInFromIndex(index, p.playerId);
      const total = computeTotalFromIndex(index, p.playerId);
      const vsPar = formatRelative(total - coursePar);
      const color = (p as { color?: string | null }).color ?? undefined;

      return {
        playerId: p.playerId,
        name: p.name,
        color,
        out,
        inn,
        total,
        vsPar,
      };
    });
  }, [snapshot]);

  return (
    <section id="panel-totals" role="tabpanel" aria-labelledby="tab-totals">
      <header>
        <h3>Totals</h3>
        <p>Summary scores for all players.</p>
      </header>

      <section aria-label="Player totals">
        <table>
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Out</th>
              <th scope="col">In</th>
              <th scope="col">Total</th>
              <th scope="col">Vs Par</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.playerId}>
                <th scope="row">
                  <span>{r.name}</span>
                  <br />
                  <span>{r.color ?? "—"}</span>
                </th>
                <td>{r.out || "—"}</td>
                <td>{r.inn || "—"}</td>
                <td>{r.total || "—"}</td>
                <td>{r.total ? r.vsPar : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </section>
  );
}
