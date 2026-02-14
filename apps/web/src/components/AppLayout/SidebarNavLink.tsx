import { NavLink, type NavLinkProps } from "react-router-dom";

type SidebarNavLinkProps = NavLinkProps & {
  highlightActive?: boolean;
};

export function SidebarNavLink({
  className,
  highlightActive = false,
  ...props
}: SidebarNavLinkProps) {
  const activeClasses = highlightActive
    ? "aria-[current=page]:font-semibold"
    : undefined;

  const combined = [activeClasses, className].filter(Boolean).join(" ") || undefined;

  return <NavLink {...props} className={combined} />;
}
