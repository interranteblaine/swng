import { useState } from "react";
import {
  IonModal,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButtons,
  IonButton,
} from "@ionic/react";
import { navyToolbarStyle } from "@/components/theme";

type InviteSheetProps = {
  isOpen: boolean;
  onClose: () => void;
  accessCode: string;
};

export function InviteSheet({ isOpen, onClose, accessCode }: InviteSheetProps) {
  const [copied, setCopied] = useState(false);

  const shareUrl = `${window.location.origin}/rounds/join?code=${encodeURIComponent(accessCode)}`;

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Join my golf round on Swng",
          text: `Use code ${accessCode} to join my round`,
          url: shareUrl,
        });
      } catch {
        // user cancelled or share failed
      }
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(accessCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  };

  return (
    <IonModal
      isOpen={isOpen}
      onDidDismiss={onClose}
      initialBreakpoint={0.4}
      breakpoints={[0, 0.4, 0.6]}
    >
      <IonHeader>
        <IonToolbar style={navyToolbarStyle}>
          <IonTitle>Invite Players</IonTitle>
          <IonButtons slot="end">
            <IonButton color="light" onClick={onClose}>
              Done
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>

      <IonContent className="ion-padding">
        <div className="flex flex-col items-center gap-4 py-4">
          <p className="text-sm text-gray-500">Share this code with other players</p>
          <span className="text-4xl font-mono font-bold tracking-widest text-gray-900">
            {accessCode}
          </span>

          <div className="flex flex-col gap-2 w-full max-w-xs mt-4">
            {typeof navigator.share === "function" && (
              <IonButton
                expand="block"
                style={{ "--background": "#3d5a80" }}
                onClick={() => void handleShare()}
              >
                Share invite link
              </IonButton>
            )}
            <IonButton
              expand="block"
              fill="outline"
              style={{ "--color": "#3d5a80", "--border-color": "#3d5a80" }}
              onClick={() => void handleCopy()}
            >
              {copied ? "Copied!" : "Copy round code"}
            </IonButton>
          </div>
        </div>
      </IonContent>
    </IonModal>
  );
}
