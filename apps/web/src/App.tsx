import { BrowserRouter, Route, Routes } from "react-router";
import { CreateRoundPage } from "./routes/CreateRoundPage";
import { HomePage } from "./routes/HomePage";
import { JoinRoundPage } from "./routes/JoinRoundPage";
import { RoundPage } from "./routes/RoundPage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/create" element={<CreateRoundPage />} />
        <Route path="/join" element={<JoinRoundPage />} />
        <Route path="/round/:roundId" element={<RoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}
