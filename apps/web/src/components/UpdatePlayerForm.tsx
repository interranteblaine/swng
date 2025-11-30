import { useState } from "react";
import type { Player } from "@swng/domain";
import { useUpdatePlayer } from "../hooks/useUpdatePlayer";

type Props = {
  roundId: string;
  players: Player[];
};

export default function UpdatePlayerForm({ roundId, players }: Props) {
  const updatePlayer = useUpdatePlayer(roundId);

  const [playerId, setPlayerId] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [color, setColor] = useState<string>("");

  const onSubmit: React.FormEventHandler = (e) => {
    e.preventDefault();
    if (!playerId) return;
    if (!name && !color) return;

    updatePlayer.mutate({
      playerId,
      name: name || undefined,
      color: color || undefined,
    });
  };

  return (
    <section style={{ display: "grid", gap: 12 }}>
      <h3>Update Player</h3>
      <form
        onSubmit={onSubmit}
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
      >
        <select
          value={playerId}
          onChange={(e) => setPlayerId(e.target.value)}
          required
        >
          <option value="" disabled>
            Select player
          </option>
          {players.map((p) => (
            <option key={p.playerId} value={p.playerId}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New name"
        />
        <input
          type="text"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          placeholder="New color"
        />
        <button type="submit" disabled={updatePlayer.isPending}>
          {updatePlayer.isPending ? "Saving..." : "Save player"}
        </button>
      </form>
      {updatePlayer.error && (
        <div style={{ color: "tomato" }}>
          {updatePlayer.error?.message ?? "Update player failed"}
        </div>
      )}
    </section>
  );
}
