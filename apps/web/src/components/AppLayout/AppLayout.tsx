import { Outlet } from "react-router-dom";
import { useCurrentRoundId } from "@/hooks/useCurrentRoundId";
import { useRouteTitle } from "@/hooks/useRouteTitle";
import { SidebarNavLink } from "@/components/AppLayout/SidebarNavLink";

export function AppLayout() {
  const roundId = useCurrentRoundId();
  const title = useRouteTitle();

  return (
    <div className="flex min-h-dvh">
      <nav className="w-56 shrink-0 border-r p-4 flex flex-col gap-4">
        <SidebarNavLink to="/" className="text-base font-semibold">
          Swng
        </SidebarNavLink>
        <ul className="flex flex-col gap-1">
          <li>
            <SidebarNavLink to="/rounds/create" highlightActive>
              Create Round
            </SidebarNavLink>
          </li>
          <li>
            <SidebarNavLink to="/rounds/join" highlightActive>
              Join Round
            </SidebarNavLink>
          </li>
          {roundId ? (
            <li>
              <SidebarNavLink to={`/rounds/${roundId}`} highlightActive>
                Round
              </SidebarNavLink>
            </li>
          ) : null}
        </ul>
      </nav>
      <main className="flex min-h-dvh flex-col flex-1">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b">
          <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
            <h1 className="text-base font-medium">{title}</h1>
          </div>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="w-full px-4 py-4 sm:px-6 lg:px-8">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}
