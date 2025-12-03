type PlayerRowProps = {
  playerId: string;
  name: string;
  color: string; // tee color
  isArchived: boolean;
  teeOptions: string[];
  onSubmit: (
    playerId: string,
    fields: { name?: string; color?: string }
  ) => void;
};

function PlayerRow({
  playerId,
  name,
  color,
  isArchived,
  teeOptions,
  onSubmit,
}: PlayerRowProps) {
  return (
    <li>
      <form
        aria-label={`Edit ${name}`}
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);

          const rawName = fd.get("name");
          const rawColor = fd.get("color");

          const next = {
            name:
              typeof rawName === "string" && rawName.trim().length > 0
                ? rawName
                : undefined,
            color:
              typeof rawColor === "string" && rawColor.trim().length > 0
                ? rawColor
                : undefined,
          };

          onSubmit(playerId, next);
        }}
      >
        <div>
          <label htmlFor={`player-${playerId}-name`}>Name</label>
          <input
            id={`player-${playerId}-name`}
            name="name"
            type="text"
            defaultValue={name}
            disabled={isArchived}
          />
        </div>

        <div>
          <label htmlFor={`player-${playerId}-tee`}>Tee</label>
          <select
            id={`player-${playerId}-tee`}
            name="color"
            defaultValue={color}
            disabled={isArchived}
          >
            {teeOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>

        <div>
          <button type="submit" disabled={isArchived}>
            Save
          </button>
        </div>
      </form>
    </li>
  );
}

type PlayersSectionProps = {
  players: { playerId: string; name: string; color: string }[];
  isArchived: boolean;
  teeOptions: string[];
  onUpdatePlayer: (
    playerId: string,
    fields: { name?: string; color?: string }
  ) => void;
};

export function PlayersSection({
  players,
  isArchived,
  teeOptions,
  onUpdatePlayer,
}: PlayersSectionProps) {
  return (
    <section aria-label="Players">
      <h4>Players</h4>

      {isArchived && (
        <p>This round is archived. Player details cannot be edited.</p>
      )}

      <ul>
        {players.map((p) => (
          <PlayerRow
            key={p.playerId}
            playerId={p.playerId}
            name={p.name}
            color={p.color}
            isArchived={isArchived}
            teeOptions={teeOptions}
            onSubmit={onUpdatePlayer}
          />
        ))}
      </ul>
    </section>
  );
}
