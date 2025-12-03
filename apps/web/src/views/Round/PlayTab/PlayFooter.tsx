type PlayFooterProps = {
  visibleHole: number;
  currentHole: number;
  holeCount: number;
  onPrevHole: () => void;
  onNextHole: () => void;
  onGoToCurrent: () => void;
};

export function PlayFooter({
  visibleHole,
  currentHole,
  holeCount,
  onPrevHole,
  onNextHole,
  onGoToCurrent,
}: PlayFooterProps) {
  const canPrev = visibleHole > 1;
  const canNext = visibleHole < holeCount;
  const canGoCurrent = visibleHole !== currentHole;

  return (
    <footer aria-label="Hole navigation">
      <button
        type="button"
        id="play-prev-hole"
        disabled={!canPrev}
        onClick={onPrevHole}
      >
        Previous
      </button>
      <button
        type="button"
        id="play-next-hole"
        disabled={!canNext}
        onClick={onNextHole}
      >
        Next
      </button>
      <button
        type="button"
        id="play-go-current"
        disabled={!canGoCurrent}
        onClick={onGoToCurrent}
      >
        Go to current
      </button>
    </footer>
  );
}
