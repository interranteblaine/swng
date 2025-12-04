type PlayHeaderProps = {
  visibleHole: number;
  par: number[];
  onPrevHole: () => void;
  onNextHole: () => void;
};

export function PlayHeader({
  visibleHole,
  par,
  onPrevHole,
  onNextHole,
}: PlayHeaderProps) {
  const holeCount = par.length;
  const visiblePar = par[visibleHole - 1];
  const canPrev = visibleHole > 1;
  const canNext = visibleHole < holeCount;

  return (
    <header>
      <p role="status" aria-live="polite">
        Viewing:
        <span>Hole </span>
        <strong id="play-visible-hole">{visibleHole}</strong>
        <span> · Par </span>
        <strong id="play-visible-par">{visiblePar}</strong>
      </p>

      <div role="group" aria-label="Hole controls">
        <button
          type="button"
          id="play-prev-hole"
          disabled={!canPrev}
          onClick={onPrevHole}
          aria-label="Previous hole"
        >
          Previous
        </button>
        <button
          type="button"
          id="play-next-hole"
          disabled={!canNext}
          onClick={onNextHole}
          aria-label="Next hole"
        >
          Next
        </button>
      </div>
    </header>
  );
}
