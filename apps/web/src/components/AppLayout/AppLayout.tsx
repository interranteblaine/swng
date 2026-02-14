import { IonPage } from "@ionic/react";
import { Outlet } from "react-router-dom";

export function AppLayout() {
  return (
    <IonPage>
      <Outlet />
    </IonPage>
  );
}
