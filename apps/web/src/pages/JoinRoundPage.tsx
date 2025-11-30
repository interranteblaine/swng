import { useState } from "react";
import { useJoinRound } from "../hooks/useJoinRound";

export default function JoinRoundPage() {
  const [accessCode, setAccessCode] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [color, setColor] = useState("#1a73e8");

  const join = useJoinRound();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!accessCode.trim()) {
      alert("Access code is required");
      return;
    }
    if (!playerName.trim()) {
      alert("Player name is required");
      return;
    }

    join.mutate({
      accessCode: accessCode.trim(),
      playerName: playerName.trim(),
      color: color || undefined,
    });
  };

  return (
    <div style={{ textAlign: "left", maxWidth: 640 }}>
      <h2>Join Round</h2>

      <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Access code</span>
          <input
            type="text"
            value={accessCode}
            onChange={(e) => setAccessCode(e.target.value)}
            placeholder="Enter access code"
            required
          />
        </label>

        <fieldset style={{ border: "1px solid #444", padding: 12 }}>
          <legend>Your player</legend>
          <label style={{ display: "grid", gap: 6 }}>
            <span>Name</span>
            <input
              type="text"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              placeholder="e.g., Alice"
              required
            />
          </label>

          <label style={{ display: "grid", gap: 6, marginTop: 8 }}>
            <span>Color (optional)</span>
            <input
              type="text"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              placeholder="#RRGGBB or any CSS color"
            />
          </label>
        </fieldset>

        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit" disabled={join.isPending}>
            {join.isPending ? "Joining..." : "Join round"}
          </button>
        </div>

        {join.error && (
          <div style={{ color: "tomato" }}>
            {join.error?.message ?? "Join failed"}
          </div>
        )}
      </form>
    </div>
  );
}
