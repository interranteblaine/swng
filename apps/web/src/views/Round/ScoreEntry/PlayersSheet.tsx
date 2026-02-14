import { useState } from "react";
import {
  IonModal,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButtons,
  IonButton,
  IonList,
  IonItem,
  IonLabel,
  IonInput,
  IonIcon,
} from "@ionic/react";
import { createOutline, trashOutline } from "ionicons/icons";
import type { Player } from "@swng/domain";
import { useRoundData, useRoundActions } from "../Context/useRoundContext";
import { getSelfPlayerId } from "@/lib/session";
import { navyToolbarStyle } from "@/components/theme";
import { teeBadgeClasses } from "@/components/teeBadges";
import { TeePicker } from "@/components/TeePicker";
import { setLastPlayerName, setLastTeeColor } from "@/lib/playerPrefs";

type PlayersSheetProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function PlayersSheet({ isOpen, onClose }: PlayersSheetProps) {
  const { snapshot } = useRoundData();
  const { updatePlayer } = useRoundActions();

  const [editingPlayerId, setEditingPlayerId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editTee, setEditTee] = useState("White");

  if (!snapshot) return null;

  const roundId = snapshot.config.roundId;
  const selfPlayerId = getSelfPlayerId(roundId);
  const sortedPlayers = [...snapshot.players].sort(
    (a, b) => a.joinedAt.localeCompare(b.joinedAt)
  );
  const creatorId = sortedPlayers[0]?.playerId;

  const startEdit = (player: Player) => {
    setEditingPlayerId(player.playerId);
    setEditName(player.name);
    setEditTee(player.color ?? "White");
  };

  const saveEdit = () => {
    if (!editingPlayerId) return;
    updatePlayer({ playerId: editingPlayerId, name: editName.trim(), color: editTee });
    if (editingPlayerId === selfPlayerId) {
      setLastPlayerName(editName.trim());
      setLastTeeColor(editTee);
    }
    setEditingPlayerId(null);
  };

  const cancelEdit = () => {
    setEditingPlayerId(null);
  };

  const handleRemove = (playerId: string) => {
    console.warn("Remove player not yet implemented", playerId);
  };

  return (
    <IonModal
      isOpen={isOpen}
      onDidDismiss={onClose}
      initialBreakpoint={0.5}
      breakpoints={[0, 0.5, 0.75]}
    >
      <IonHeader>
        <IonToolbar style={navyToolbarStyle}>
          <IonTitle>Players</IonTitle>
          <IonButtons slot="end">
            <IonButton color="light" onClick={onClose}>
              Done
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>

      <IonContent>
        <IonList>
          {sortedPlayers.map((player) => {
            const isSelf = player.playerId === selfPlayerId;
            const isCreator = player.playerId === creatorId;
            const isEditing = editingPlayerId === player.playerId;

            if (isEditing) {
              return (
                <IonItem key={player.playerId}>
                  <div className="w-full py-2 flex flex-col gap-2">
                    <IonInput
                      value={editName}
                      onIonInput={(e) => setEditName(e.detail.value ?? "")}
                      placeholder="Player name"
                    />
                    <TeePicker value={editTee} onChange={setEditTee} />
                    <div className="flex gap-2 justify-end">
                      <IonButton size="small" fill="outline" onClick={cancelEdit}
                        style={{ "--color": "#3d5a80", "--border-color": "#3d5a80" }}
                      >
                        Cancel
                      </IonButton>
                      <IonButton size="small" onClick={saveEdit}
                        style={{ "--background": "#3d5a80" }}
                      >
                        Save
                      </IonButton>
                    </div>
                  </div>
                </IonItem>
              );
            }

            return (
              <IonItem key={player.playerId}>
                <IonLabel>
                  <h2 className="text-base font-semibold">
                    {player.name}
                    {isSelf && (
                      <span className="text-xs text-gray-400 ml-1">(you)</span>
                    )}
                    {isCreator && (
                      <span className="text-xs text-gray-400 ml-1">creator</span>
                    )}
                  </h2>
                  <p>
                    <span
                      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
                        teeBadgeClasses[player.color ?? ""] ?? "bg-gray-500 text-white"
                      }`}
                    >
                      {player.color ?? "\u2014"}
                    </span>
                  </p>
                </IonLabel>
                <div slot="end" className="flex gap-1">
                  {isSelf && (
                    <IonButton
                      fill="clear"
                      size="small"
                      onClick={() => startEdit(player)}
                      aria-label="Edit your details"
                    >
                      <IonIcon slot="icon-only" icon={createOutline} />
                    </IonButton>
                  )}
                  {selfPlayerId === creatorId && !isSelf && (
                    <IonButton
                      fill="clear"
                      size="small"
                      color="danger"
                      onClick={() => handleRemove(player.playerId)}
                      aria-label={`Remove ${player.name}`}
                    >
                      <IonIcon slot="icon-only" icon={trashOutline} />
                    </IonButton>
                  )}
                </div>
              </IonItem>
            );
          })}
        </IonList>
      </IonContent>
    </IonModal>
  );
}
