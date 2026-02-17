import { RouterProvider } from "react-router-dom";
import { IonApp } from "@ionic/react";
import { router } from "./routes";

function App() {
  return (
    <IonApp>
      <RouterProvider router={router} />
    </IonApp>
  );
}

export default App;
