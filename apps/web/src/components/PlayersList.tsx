import type { Player } from "@swng/domain";

type Props = {
  players: Player[];
};

export default function PlayersList({ players }: Props) {
  if (!players?.length) return <div>No players yet</div>;

  return (
    <section>
      <h3>Players</h3>
      <ul>
        {players.map((p) => (
          <li key={p.playerId}>
            <span
              style={{
                display: "inline-block",
                width: 12,
                height: 12,
                background: p.color,
                borderRadius: 2,
                marginRight: 6,
                verticalAlign: "middle",
              }}
            />
            <b>{p.name}</b> <small>({p.playerId})</small>
          </li>
        ))}
      </ul>
    </section>
  );
}
