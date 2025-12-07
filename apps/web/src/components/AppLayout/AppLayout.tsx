import { NavLink, Outlet } from "react-router-dom";
import { useCurrentRoundId } from "../../hooks/useCurrentRoundId";
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

export function AppLayout() {
  const roundId = useCurrentRoundId();

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <NavLink to="/">
                  <LandPlot size={48} />
                  <span className="text-base font-semibold">Swng</span>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <NavLink to="/rounds/create">Create Round</NavLink>
                </SidebarMenuButton>
                <SidebarMenuButton asChild>
                  <NavLink to="/rounds/join">Join Round</NavLink>
                </SidebarMenuButton>
                {roundId ? (
                  <SidebarMenuButton asChild>
                    <NavLink to={`/rounds/${roundId}`}>Round</NavLink>
                  </SidebarMenuButton>
                ) : null}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <main>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b">
          <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
            <SidebarTrigger />
            <Separator
              orientation="vertical"
              className="mx-2 data-[orientation=vertical]:h-4"
            />
            <h1 className="text-base font-medium">Create</h1>
          </div>
        </header>
        <Outlet />
      </main>
    </SidebarProvider>
  );
}
