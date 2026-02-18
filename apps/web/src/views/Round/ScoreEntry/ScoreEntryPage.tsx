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
import { InviteSheet } from "./InviteSheet";
import { PlayersSheet } from "./PlayersSheet";

export function ScoreEntryPage() {
  const { snapshot } = useRoundData();
  const { updateScore } = useRoundActions();
  const [visibleHole, setVisibleHole] = useState(1);
  const [showOptions, setShowOptions] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showPlayers, setShowPlayers] = useState(false);

  if (!snapshot) return null;

  const sortedHoles = [...snapshot.config.course.teeSets[0].holes].sort(
    (a, b) => a.holeNumber - b.holeNumber
  );
  const par = sortedHoles.map((h) => h.par);
  const handicapIndex = sortedHoles.map((h) => h.handicapIndex);
  const holeCount = snapshot.config.course.holeCount;

  const { teeSets } = snapshot.config.course;
  const players = snapshot.players.map((p) => {
    const color = p.color?.toLowerCase();
    const teeSet = color
      ? teeSets.find((ts) => ts.name.toLowerCase() === color)
      : undefined;
    const hole = teeSet?.holes.find((h) => h.holeNumber === visibleHole);
    return {
      playerId: p.playerId,
      name: p.name,
      color: p.color,
      yardage: hole?.yardage,
    };
  });

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
          <IonTitle>{snapshot.config.course.name}</IonTitle>
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
          handicapIndex={handicapIndex}
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

      <OptionsMenu
        isOpen={showOptions}
        onClose={() => setShowOptions(false)}
        onShowInvite={() => setShowInvite(true)}
        onShowPlayers={() => setShowPlayers(true)}
      />

      <InviteSheet
        isOpen={showInvite}
        onClose={() => setShowInvite(false)}
        accessCode={snapshot.config.accessCode}
      />

      <PlayersSheet
        isOpen={showPlayers}
        onClose={() => setShowPlayers(false)}
      />
    </IonPage>
  );
}
