type PlayHeaderProps = {
  visibleHole: number;
  currentHole: number;
  par: number[];
  onChangeCurrentHole: (hole: number) => void;
};

export function PlayHeader({
  visibleHole,
  currentHole,
  par,
  onChangeCurrentHole,
}: PlayHeaderProps) {
  const holeCount = par.length;
  const visiblePar = par[visibleHole - 1];

  return (
    <header>
      <p>
        Viewing:
        <span>Hole </span>
        <strong id="play-visible-hole">{visibleHole}</strong>
        <span> · Par </span>
        <strong id="play-visible-par">{visiblePar}</strong>
      </p>

      <div>
        <label htmlFor="current-hole-select">Current hole</label>
        <select
          id="current-hole-select"
          name="currentHole"
          value={currentHole}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (!Number.isNaN(next) && next !== currentHole) {
              onChangeCurrentHole(next);
            }
          }}
        >
          {Array.from({ length: holeCount }, (_, i) => {
            const hole = i + 1;
            return (
              <option key={hole} value={hole}>
                {hole}
              </option>
            );
          })}
        </select>
      </div>
    </header>
  );
}
