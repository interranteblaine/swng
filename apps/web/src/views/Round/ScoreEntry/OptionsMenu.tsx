import { IonActionSheet } from "@ionic/react";

type OptionsMenuProps = {
  isOpen: boolean;
  onClose: () => void;
  onShowInvite: () => void;
  onShowPlayers: () => void;
};

export function OptionsMenu({ isOpen, onClose, onShowInvite, onShowPlayers }: OptionsMenuProps) {
  return (
    <IonActionSheet
      isOpen={isOpen}
      onDidDismiss={onClose}
      header="Options"
      buttons={[
        {
          text: "Invite players",
          handler: () => {
            onShowInvite();
          },
        },
        {
          text: "Players",
          handler: () => {
            onShowPlayers();
          },
        },
        {
          text: "Cancel",
          role: "cancel",
        },
      ]}
    />
  );
}
