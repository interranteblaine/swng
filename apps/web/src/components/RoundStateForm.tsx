import { useState } from "react";
import type { RoundState, RoundStatus } from "@swng/domain";
import { usePatchRoundState } from "../hooks/usePatchRoundState";

type Props = {
  roundId: string;
  state: RoundState;
};

export default function RoundStateForm({ roundId, state }: Props) {
  const patch = usePatchRoundState(roundId);

  const [currentHole, setCurrentHole] = useState(state.currentHole);
  const [status, setStatus] = useState<RoundStatus | null | undefined>(
    state.status
  );

  const onSubmit: React.FormEventHandler = (e) => {
    e.preventDefault();
    patch.mutate({
      currentHole,
      status,
    });
  };

  return (
    <section style={{ display: "grid", gap: 12 }}>
      <h3>Round State</h3>
      <form
        onSubmit={onSubmit}
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
      >
        <input
          type="number"
          min={1}
          value={currentHole}
          onChange={(e) => setCurrentHole(parseInt(e.target.value, 10))}
          placeholder="Current hole"
          style={{ width: 160 }}
        />
        <select
          value={status === null ? "__null__" : status ?? "__undefined__"}
          onChange={(e) => {
            const val = e.target.value;
            if (val === "__null__") setStatus(null);
            else if (val === "__undefined__") setStatus(undefined);
            else setStatus(val as RoundStatus);
          }}
        >
          <option value="__undefined__">(no change)</option>
          <option value="__null__">Not started</option>
          <option value="IN_PROGRESS">In Progress</option>
          <option value="COMPLETED">Completed</option>
        </select>
        <button type="submit" disabled={patch.isPending}>
          {patch.isPending ? "Saving..." : "Save"}
        </button>
      </form>
      {patch.error && (
        <div style={{ color: "tomato" }}>
          {patch.error.message ?? "Failed to update state"}
        </div>
      )}
    </section>
  );
}
