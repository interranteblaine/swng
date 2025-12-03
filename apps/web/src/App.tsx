import { Route, Routes, Navigate } from "react-router-dom";
import { AppLayout } from "./components/AppLayout/AppLayout";
import { HomeView } from "./views/Home/HomeView";
import { CreateRoundView } from "./views/CreateRound/CreateRoundView";
import { JoinRoundView } from "./views/JoinRound/JoinRoundView";
import { RoundView } from "./views/Round/RoundView";
import "./App.css";

function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<HomeView />} />
        <Route path="/rounds/create" element={<CreateRoundView />} />
        <Route path="/rounds/join" element={<JoinRoundView />} />
        <Route path="/rounds/:roundId" element={<RoundView />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default App;
