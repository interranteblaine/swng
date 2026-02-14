import {
  IonToolbar,
  IonButtons,
  IonButton,
  IonIcon,
  IonSelect,
  IonSelectOption,
} from "@ionic/react";
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
    <IonToolbar>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "4px 0",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            width: "100%",
            justifyContent: "center",
          }}
        >
          <IonButtons>
            <IonButton
              disabled={!canPrev}
              onClick={() => onChangeHole(visibleHole - 1)}
              aria-label="Previous hole"
            >
              <IonIcon slot="icon-only" icon={chevronBack} />
            </IonButton>
          </IonButtons>

          <IonSelect
            interface="popover"
            value={visibleHole}
            onIonChange={(e) => onChangeHole(e.detail.value as number)}
            aria-label="Select hole"
            style={{ maxWidth: 120, textAlign: "center" }}
          >
            {Array.from({ length: holeCount }, (_, i) => (
              <IonSelectOption key={i + 1} value={i + 1}>
                Hole {i + 1}
              </IonSelectOption>
            ))}
          </IonSelect>

          <IonButtons>
            <IonButton
              disabled={!canNext}
              onClick={() => onChangeHole(visibleHole + 1)}
              aria-label="Next hole"
            >
              <IonIcon slot="icon-only" icon={chevronForward} />
            </IonButton>
          </IonButtons>
        </div>

        <div
          style={{
            fontSize: "0.85rem",
            color: "var(--ion-color-medium)",
            marginTop: 2,
          }}
        >
          Par {visiblePar} &middot; HCP —
        </div>
      </div>
    </IonToolbar>
  );
}
