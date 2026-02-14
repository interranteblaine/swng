import { useState } from "react";
import { IonActionSheet } from "@ionic/react";
import { useRoundData } from "../Context/useRoundContext";
import { InviteSheet } from "./InviteSheet";
import { PlayersSheet } from "./PlayersSheet";

type OptionsMenuProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function OptionsMenu({ isOpen, onClose }: OptionsMenuProps) {
  const { snapshot } = useRoundData();
  const [showInvite, setShowInvite] = useState(false);
  const [showPlayers, setShowPlayers] = useState(false);

  const accessCode = snapshot?.config.accessCode ?? "";

  return (
    <>
      <IonActionSheet
        isOpen={isOpen}
        onDidDismiss={onClose}
        header="Options"
        buttons={[
          {
            text: "Invite players",
            handler: () => {
              setShowInvite(true);
            },
          },
          {
            text: "Players",
            handler: () => {
              setShowPlayers(true);
            },
          },
          {
            text: "Cancel",
            role: "cancel",
          },
        ]}
      />

      <InviteSheet
        isOpen={showInvite}
        onClose={() => setShowInvite(false)}
        accessCode={accessCode}
      />

      <PlayersSheet
        isOpen={showPlayers}
        onClose={() => setShowPlayers(false)}
      />
    </>
  );
}
