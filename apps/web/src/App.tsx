import { Link, Route, Routes, Navigate } from "react-router-dom";
import "./App.css";
import HomePage from "./pages/HomePage";
import CreateRoundPage from "./pages/CreateRoundPage";
import JoinRoundPage from "./pages/JoinRoundPage";
import RoundPage from "./pages/RoundPage";

function App() {
  return (
    <div>
      <nav style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <Link to="/">Home</Link>
        <Link to="/rounds/create">Create</Link>
        <Link to="/rounds/join">Join</Link>
      </nav>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/rounds/create" element={<CreateRoundPage />} />
        <Route path="/rounds/join" element={<JoinRoundPage />} />
        <Route path="/rounds/:roundId" element={<RoundPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

export default App;
