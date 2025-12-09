import { useCallback } from "react";
import { NavLink, type NavLinkProps } from "react-router-dom";
import { useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

type SidebarNavLinkProps = NavLinkProps & {
  highlightActive?: boolean;
};

export function SidebarNavLink({
  onClick,
  className,
  highlightActive = false,
  ...props
}: SidebarNavLinkProps) {
  const { isMobile, setOpenMobile } = useSidebar();

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement, MouseEvent>) => {
      onClick?.(e);
      if (isMobile) setOpenMobile(false);
    },
    [isMobile, onClick, setOpenMobile]
  );

  const activeClasses = highlightActive
    ? "aria-[current=page]:font-semibold"
    : undefined;

  return (
    <NavLink
      {...props}
      onClick={handleClick}
      className={cn(activeClasses, className)}
    />
  );
}
