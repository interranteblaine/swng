import {
  createBrowserRouter,
  Navigate,
  type RouteObject,
} from "react-router-dom";
import { AppLayout } from "@/components/AppLayout/AppLayout";
import { HomeView } from "@/views/Home/HomeView";
import { CreateRoundView } from "@/views/CreateRound/CreateRoundView";
import { JoinRoundView } from "@/views/JoinRound/JoinRoundView";
import { JoinDetailsView } from "@/views/JoinRound/JoinDetailsView";
import { RoundView } from "@/views/Round/RoundView";

const routes: RouteObject[] = [
  {
    path: "/rounds/:roundId",
    element: <RoundView />,
  },
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <HomeView /> },
      {
        path: "/rounds/create",
        element: <CreateRoundView />,
      },
      {
        path: "/rounds/join",
        element: <JoinRoundView />,
      },
      {
        path: "/rounds/join/details",
        element: <JoinDetailsView />,
      },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
