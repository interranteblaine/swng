type PlayerView = {
  playerId: string;
  name: string;
  color?: string | null;
};

type PlayPlayerListProps = {
  players: PlayerView[];
  visibleHole: number;
  strokesByPlayer: Record<string, number | undefined>;
  onChangeStrokes: (playerId: string, strokes: number | undefined) => void;
};

const MAX_STROKES = 12;

export function PlayPlayerList({
  players,
  visibleHole,
  strokesByPlayer,
  onChangeStrokes,
}: PlayPlayerListProps) {
  return (
    <section aria-label="Scores for visible hole">
      <ul>
        {players.map((p) => {
          const selectId = `player-${p.playerId}-hole-${visibleHole}-strokes`;
          const value =
            strokesByPlayer[p.playerId] === undefined
              ? ""
              : String(strokesByPlayer[p.playerId]);

          return (
            <li key={p.playerId}>
              <div>
                <p>
                  <strong>{p.name}</strong>
                </p>
                <p>
                  Tee / color:
                  <span>{p.color ?? "—"}</span>
                </p>
              </div>

              <div>
                <label htmlFor={selectId}>Strokes</label>
                <select
                  id={selectId}
                  name={selectId}
                  value={value}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "") {
                      onChangeStrokes(p.playerId, undefined);
                      return;
                    }
                    const n = Number(v);
                    if (!Number.isNaN(n)) {
                      onChangeStrokes(p.playerId, n);
                    }
                  }}
                >
                  <option value="">–</option>
                  {Array.from({ length: MAX_STROKES }, (_, i) => {
                    const n = i + 1;
                    return (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    );
                  })}
                </select>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
