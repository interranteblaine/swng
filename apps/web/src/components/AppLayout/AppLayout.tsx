import { Outlet } from "react-router-dom";
import { useCurrentRoundId } from "@/hooks/useCurrentRoundId";
import { useRouteTitle } from "@/hooks/useRouteTitle";
import {
  SidebarProvider,
  SidebarTrigger,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarHeader,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { LandPlot } from "lucide-react";
import { SidebarNavLink } from "@/components/AppLayout/SidebarNavLink";

export function AppLayout() {
  const roundId = useCurrentRoundId();
  const title = useRouteTitle();

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <SidebarNavLink to="/">
                  <LandPlot />
                  <span className="text-base font-semibold">Swng</span>
                </SidebarNavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <SidebarNavLink to="/rounds/create" highlightActive>
                    Create Round
                  </SidebarNavLink>
                </SidebarMenuButton>
                <SidebarMenuButton asChild>
                  <SidebarNavLink to="/rounds/join" highlightActive>
                    Join Round
                  </SidebarNavLink>
                </SidebarMenuButton>
                {roundId ? (
                  <SidebarMenuButton asChild>
                    <SidebarNavLink to={`/rounds/${roundId}`} highlightActive>
                      Round
                    </SidebarNavLink>
                  </SidebarMenuButton>
                ) : null}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <main className="flex min-h-dvh flex-col flex-1">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b">
          <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
            <SidebarTrigger />
            <Separator
              orientation="vertical"
              className="mx-2 data-[orientation=vertical]:h-4"
            />
            <h1 className="text-base font-medium">{title}</h1>
          </div>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="w-full px-4 py-4 sm:px-6 lg:px-8">
            <Outlet />
          </div>
        </div>
      </main>
    </SidebarProvider>
  );
}
