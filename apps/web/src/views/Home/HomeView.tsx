import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButton,
} from "@ionic/react";
import { useNavigate } from "react-router-dom";
import { navyToolbarStyle } from "@/components/theme";
import { useCurrentRoundId } from "@/hooks/useCurrentRoundId";

export function HomeView() {
  const navigate = useNavigate();
  const currentRoundId = useCurrentRoundId();

  return (
    <>
      <IonHeader>
        <IonToolbar style={navyToolbarStyle}>
          <IonTitle>Swng</IonTitle>
        </IonToolbar>
      </IonHeader>

      <IonContent>
        <div className="flex flex-col items-center justify-center px-6 py-16 gap-8">
          <h2 className="text-xl font-semibold">Welcome to Swng</h2>
          <p className="text-gray-500">Create a new round or join one.</p>

          <div className="flex flex-col gap-3 w-full max-w-xs">
            <IonButton
              expand="block"
              style={{ "--background": "#3d5a80" }}
              onClick={() => void navigate("/rounds/create")}
            >
              Create a round
            </IonButton>
            <IonButton
              expand="block"
              fill="outline"
              style={{ "--color": "#3d5a80", "--border-color": "#3d5a80" }}
              onClick={() => void navigate("/rounds/join")}
            >
              Join a round
            </IonButton>
          </div>

          {currentRoundId && (
            <div className="w-full max-w-xs rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-gray-600 mb-3">You have an active round</p>
              <IonButton
                expand="block"
                style={{ "--background": "#3d5a80" }}
                onClick={() => void navigate(`/rounds/${currentRoundId}`)}
              >
                Resume round
              </IonButton>
            </div>
          )}
        </div>
      </IonContent>
    </>
  );
}
