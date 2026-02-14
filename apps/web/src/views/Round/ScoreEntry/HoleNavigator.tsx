import { IonToolbar, IonButton, IonIcon } from "@ionic/react";
import { chevronBack, chevronForward } from "ionicons/icons";

type HoleNavigatorProps = {
  visibleHole: number;
  holeCount: number;
  par: number[];
  onChangeHole: (hole: number) => void;
};

export function HoleNavigator({
  visibleHole,
  holeCount,
  par,
  onChangeHole,
}: HoleNavigatorProps) {
  const canPrev = visibleHole > 1;
  const canNext = visibleHole < holeCount;
  const visiblePar = par[visibleHole - 1];

  return (
    <IonToolbar style={{ "--background": "#ffffff", "--border-color": "#e5e7eb" }}>
      <div className="flex flex-col items-center py-1">
        <div className="flex w-full items-center justify-center gap-1">
          <IonButton
            fill="clear"
            disabled={!canPrev}
            onClick={() => onChangeHole(visibleHole - 1)}
            aria-label="Previous hole"
          >
            <IonIcon slot="icon-only" icon={chevronBack} />
          </IonButton>

          <span className="text-2xl font-bold text-gray-900">
            Hole {visibleHole}
          </span>

          <IonButton
            fill="clear"
            disabled={!canNext}
            onClick={() => onChangeHole(visibleHole + 1)}
            aria-label="Next hole"
          >
            <IonIcon slot="icon-only" icon={chevronForward} />
          </IonButton>
        </div>

        <div className="mt-0.5 text-sm text-gray-500">
          Par {visiblePar} &middot; HCP —
        </div>
      </div>
    </IonToolbar>
  );
}
