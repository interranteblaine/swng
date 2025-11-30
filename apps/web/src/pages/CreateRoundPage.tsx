import { useMemo, useState } from "react";
import { useCreateRound } from "../hooks/useCreateRound";

function parseParCsv(csv: string): number[] {
  return csv
    .split(/[,\s]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

const PAR_72_18 = "4,4,3,5,4,4,3,5,4,4,3,5,4,4,3,5,4,4";

export default function CreateRoundPage() {
  const [courseName, setCourseName] = useState("");
  const [parCsv, setParCsv] = useState(PAR_72_18);
  const [playerName, setPlayerName] = useState("");
  const [color, setColor] = useState("#1a73e8");

  const par = useMemo(() => parseParCsv(parCsv), [parCsv]);
  const holes = par.length;

  const createRound = useCreateRound();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!courseName.trim()) {
      alert("Course name is required");
      return;
    }
    if (par.length < 1) {
      alert("Provide at least one hole par value");
      return;
    }
    if (!playerName.trim()) {
      alert("Your player name is required");
      return;
    }

    createRound.mutate({
      courseName: courseName.trim(),
      par,
      playerName: playerName.trim(),
      color: color || undefined,
    });
  };

  return (
    <div style={{ textAlign: "left", maxWidth: 640 }}>
      <h2>Create Round</h2>

      <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Course name</span>
          <input
            type="text"
            value={courseName}
            onChange={(e) => setCourseName(e.target.value)}
            placeholder="e.g., Sunnyvale 18"
            required
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>Pars (CSV)</span>
          <textarea
            value={parCsv}
            onChange={(e) => setParCsv(e.target.value)}
            rows={3}
            placeholder="e.g., 4,3,5,4,..."
          />
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              onClick={() => setParCsv(PAR_72_18)}
              style={{ padding: "4px 8px" }}
            >
              Load 18-hole par 72
            </button>
            <small>
              Parsed holes: <b>{holes}</b>
            </small>
          </div>
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
          <button type="submit" disabled={createRound.isPending}>
            {createRound.isPending ? "Creating..." : "Create round"}
          </button>
        </div>

        {createRound.error && (
          <div style={{ color: "tomato" }}>
            {createRound.error?.message ?? "Create failed"}
          </div>
        )}
      </form>
    </div>
  );
}
