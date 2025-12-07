import {
  createBrowserRouter,
  Navigate,
  type RouteObject,
  type UIMatch,
} from "react-router-dom";
import { AppLayout } from "@/components/AppLayout/AppLayout";
import { HomeView } from "@/views/Home/HomeView";
import { CreateRoundView } from "@/views/CreateRound/CreateRoundView";
import { JoinRoundView } from "@/views/JoinRound/JoinRoundView";
import { RoundView } from "@/views/Round/RoundView";

export type AppHandle = {
  title?: string | ((match: UIMatch) => string);
};

export type AppRouteObject = RouteObject & {
  handle?: AppHandle;
  children?: AppRouteObject[];
};

const routes: AppRouteObject[] = [
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <HomeView />, handle: { title: "Home" } },
      {
        path: "/rounds/create",
        element: <CreateRoundView />,
        handle: { title: "Create Round" },
      },
      {
        path: "/rounds/join",
        element: <JoinRoundView />,
        handle: { title: "Join Round" },
      },
      {
        path: "/rounds/:roundId",
        element: <RoundView />,
        handle: {
          title: "Current Round",
        },
      },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
