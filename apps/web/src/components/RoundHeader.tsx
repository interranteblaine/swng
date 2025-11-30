import type { RoundSnapshot } from "@swng/domain";

type Props = {
  snapshot: RoundSnapshot;
};

export default function RoundHeader({ snapshot }: Props) {
  const { config, state } = snapshot;
  return (
    <header style={{ display: "grid", gap: 8 }}>
      <h2>Round {config.roundId}</h2>
      <div>
        Course: <b>{config.courseName}</b> • Holes: <b>{config.holes}</b> •
        Access Code: <code>{config.accessCode}</code>
      </div>
      <div>
        Status: <b>{state.status === null ? "Not started" : state.status}</b> •
        Current hole: <b>{state.currentHole}</b>
      </div>
    </header>
  );
}
