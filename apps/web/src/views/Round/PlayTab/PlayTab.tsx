import { useState } from "react";
import { PlayFooter } from "./PlayFooter";
import { PlayHeader } from "./PlayHeader";
import { PlayPlayerList } from "./PlayPlayerList";
import { useRoundData, useRoundActions } from "../Context/useRoundContext";

export function PlayTab() {
  const { snapshot } = useRoundData();
  const { patchRoundState, updateScore } = useRoundActions();
  const [visibleHole, setVisibleHole] = useState(1);

  const par = snapshot?.config.par ?? [];
  const currentHole = snapshot?.state.currentHole ?? 1;
  const holeCount = par.length;

  const players = (snapshot?.players ?? []).map((p) => ({
    playerId: p.playerId,
    name: p.name,
    color: (p as { color?: string | null }).color ?? undefined,
  }));

  const strokesByPlayer = (snapshot?.scores ?? [])
    .filter((s) => s.holeNumber === visibleHole)
    .reduce<Record<string, number | undefined>>((acc, s) => {
      acc[s.playerId] = s.strokes;
      return acc;
    }, {});

  return (
    <section id="panel-play" role="tabpanel" aria-labelledby="tab-play">
      <PlayHeader
        visibleHole={visibleHole}
        currentHole={currentHole}
        par={par}
        onChangeCurrentHole={(next) => patchRoundState({ currentHole: next })}
      />
      <PlayPlayerList
        players={players}
        visibleHole={visibleHole}
        strokesByPlayer={strokesByPlayer}
        onChangeStrokes={(playerId, strokes) => {
          if (typeof strokes === "number") {
            updateScore({ playerId, holeNumber: visibleHole, strokes });
          }
        }}
      />
      <PlayFooter
        visibleHole={visibleHole}
        currentHole={currentHole}
        holeCount={holeCount}
        onPrevHole={() => setVisibleHole((h) => Math.max(1, h - 1))}
        onNextHole={() => setVisibleHole((h) => Math.min(holeCount, h + 1))}
        onGoToCurrent={() => setVisibleHole(currentHole)}
      />
    </section>
  );
}
