import { useMemo, useState } from "react";
import type { Player } from "@swng/domain";
import { useUpdateScore } from "../hooks/useUpdateScore";

type Props = {
  roundId: string;
  players: Player[];
  currentHole: number;
};

export default function UpdateScoreForm({
  roundId,
  players,
  currentHole,
}: Props) {
  const updateScore = useUpdateScore(roundId);

  const [playerId, setPlayerId] = useState<string>("");
  const [holeNumber, setHoleNumber] = useState<number>(currentHole);
  const [strokes, setStrokes] = useState<number>(3);

  const playerOptions = useMemo(() => {
    return players.map((p) => (
      <option key={p.playerId} value={p.playerId}>
        {p.name}
      </option>
    ));
  }, [players]);

  const onSubmit: React.FormEventHandler = (e) => {
    e.preventDefault();
    if (!playerId) return;
    if (holeNumber <= 0 || strokes <= 0) return;

    updateScore.mutate({ playerId, holeNumber, strokes });
  };

  return (
    <section style={{ display: "grid", gap: 12 }}>
      <h3>Update Score</h3>
      <form onSubmit={onSubmit} style={{ display: "flex", gap: 8 }}>
        <select
          value={playerId}
          onChange={(e) => setPlayerId(e.target.value)}
          required
        >
          <option value="" disabled>
            Select player
          </option>
          {playerOptions}
        </select>
        <input
          type="number"
          min={1}
          value={holeNumber}
          onChange={(e) => setHoleNumber(parseInt(e.target.value, 10) || 1)}
          placeholder="Hole #"
          style={{ width: 100 }}
        />
        <input
          type="number"
          min={1}
          value={strokes}
          onChange={(e) => setStrokes(parseInt(e.target.value, 10) || 1)}
          placeholder="Strokes"
          style={{ width: 100 }}
        />
        <button type="submit" disabled={updateScore.isPending}>
          {updateScore.isPending ? "Saving..." : "Save score"}
        </button>
      </form>
      {updateScore.error && (
        <div style={{ color: "tomato" }}>
          {updateScore.error?.message ?? "Update score failed"}
        </div>
      )}
    </section>
  );
}
