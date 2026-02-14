import { useState } from "react";
import {
  IonPage,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonFooter,
  IonButtons,
  IonBackButton,
  IonButton,
  IonIcon,
} from "@ionic/react";
import { menuOutline } from "ionicons/icons";
import { useRoundData, useRoundActions } from "../Context/useRoundContext";
import { HoleNavigator } from "./HoleNavigator";
import { ScoreEntryList } from "./ScoreEntryList";
import { TotalsStrip } from "./TotalsStrip";
import { navyToolbarStyle } from "@/components/theme";
import { OptionsMenu } from "./OptionsMenu";

export function ScoreEntryPage() {
  const { snapshot } = useRoundData();
  const { updateScore } = useRoundActions();
  const [visibleHole, setVisibleHole] = useState(1);
  const [showOptions, setShowOptions] = useState(false);

  if (!snapshot) return null;

  const par = snapshot.config.par;
  const holeCount = par.length;

  const players = snapshot.players.map((p) => ({
    playerId: p.playerId,
    name: p.name,
    color: p.color,
  }));

  const strokesByPlayer = snapshot.scores
    .filter((s) => s.holeNumber === visibleHole)
    .reduce<Record<string, number | undefined>>((acc, s) => {
      acc[s.playerId] = s.strokes;
      return acc;
    }, {});

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar style={navyToolbarStyle}>
          <IonButtons slot="start">
            <IonBackButton defaultHref="/" color="light" />
          </IonButtons>
          <IonTitle>{snapshot.config.courseName}</IonTitle>
          <IonButtons slot="end">
            <IonButton aria-label="Options" color="light" onClick={() => setShowOptions(true)}>
              <IonIcon slot="icon-only" icon={menuOutline} />
            </IonButton>
          </IonButtons>
        </IonToolbar>
        <HoleNavigator
          visibleHole={visibleHole}
          holeCount={holeCount}
          par={par}
          onChangeHole={setVisibleHole}
        />
      </IonHeader>

      <IonContent>
        <ScoreEntryList
          players={players}
          strokesByPlayer={strokesByPlayer}
          onChangeStrokes={(playerId, strokes) => {
            updateScore({ playerId, holeNumber: visibleHole, strokes });
          }}
        />
      </IonContent>

      <IonFooter>
        <TotalsStrip snapshot={snapshot} />
      </IonFooter>

      <OptionsMenu isOpen={showOptions} onClose={() => setShowOptions(false)} />
    </IonPage>
  );
}
