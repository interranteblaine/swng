import * as React from "react";
import { NavLink, type NavLinkProps } from "react-router-dom";
import { useSidebar } from "@/components/ui/sidebar";

export function SidebarNavLink({ onClick, ...props }: NavLinkProps) {
  const { isMobile, setOpenMobile } = useSidebar();

  const handleClick = React.useCallback(
    (e: React.MouseEvent<HTMLAnchorElement, MouseEvent>) => {
      onClick?.(e);
      if (isMobile) setOpenMobile(false);
    },
    [isMobile, onClick, setOpenMobile]
  );

  return <NavLink {...props} onClick={handleClick} />;
}
