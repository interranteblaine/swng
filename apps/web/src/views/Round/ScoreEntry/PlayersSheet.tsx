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
  const { updatePlayer, removePlayer } = useRoundActions();

  const [editPlayer, setEditPlayer] = useState<Player | null>(null);
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
    setEditName(player.name);
    setEditTee(player.color ?? "White");
    setEditPlayer(player);
  };

  const saveEdit = () => {
    if (!editPlayer) return;
    updatePlayer({ playerId: editPlayer.playerId, name: editName.trim(), color: editTee });
    if (editPlayer.playerId === selfPlayerId) {
      setLastPlayerName(editName.trim());
      setLastTeeColor(editTee);
    }
    setEditPlayer(null);
  };

  const handleRemove = (playerId: string) => {
    removePlayer({ playerId });
  };

  return (
    <>
      {/* Players list */}
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
              const canEdit = isSelf || selfPlayerId === creatorId;
              const canRemove = isSelf || selfPlayerId === creatorId;

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
                    {canEdit && (
                      <IonButton
                        fill="clear"
                        size="small"
                        onClick={() => startEdit(player)}
                        aria-label={isSelf ? "Edit your details" : `Edit ${player.name}`}
                      >
                        <IonIcon slot="icon-only" icon={createOutline} />
                      </IonButton>
                    )}
                    {canRemove && (
                      <IonButton
                        fill="clear"
                        size="small"
                        color="danger"
                        onClick={() => handleRemove(player.playerId)}
                        aria-label={isSelf ? "Leave round" : `Remove ${player.name}`}
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

      {/* Edit player */}
      <IonModal
        isOpen={!!editPlayer}
        onDidDismiss={() => setEditPlayer(null)}
        initialBreakpoint={0.5}
        breakpoints={[0, 0.5, 0.75]}
      >
        <IonHeader>
          <IonToolbar style={navyToolbarStyle}>
            <IonTitle>Edit {editPlayer?.name}</IonTitle>
            <IonButtons slot="end">
              <IonButton color="light" onClick={() => setEditPlayer(null)}>
                Cancel
              </IonButton>
            </IonButtons>
          </IonToolbar>
        </IonHeader>

        <IonContent>
          <div className="px-4 py-3 flex flex-col gap-3">
            <IonInput
              value={editName}
              onIonInput={(e) => setEditName(e.detail.value ?? "")}
              placeholder="Player name"
              fill="outline"
              label="Name"
              labelPlacement="stacked"
            />
            <div>
              <div className="text-xs text-gray-500 mb-1 ml-1">Tee</div>
              <TeePicker value={editTee} onChange={setEditTee} />
            </div>
            <IonButton
              expand="block"
              onClick={saveEdit}
              style={{ "--background": "#3d5a80" }}
            >
              Save
            </IonButton>
          </div>
        </IonContent>
      </IonModal>
    </>
  );
}
