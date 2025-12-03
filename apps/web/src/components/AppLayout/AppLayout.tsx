import { NavLink, Outlet } from "react-router-dom";
import { useCurrentRoundId } from "../../hooks/useCurrentRoundId";

export function AppLayout() {
  const roundId = useCurrentRoundId();

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <aside aria-label="Main navigation" style={{ padding: 16 }}>
        <nav>
          <h1>Swng</h1>
          <ul style={{ listStyle: "none", padding: 0 }}>
            <li>
              <NavLink to="/rounds/create">Create Round</NavLink>
            </li>
            <li>
              <NavLink to="/rounds/join">Join Round</NavLink>
            </li>
            <li>
              {roundId ? (
                <NavLink to={`/rounds/${roundId}`}>Round</NavLink>
              ) : (
                <span aria-disabled="true">Round</span>
              )}
            </li>
          </ul>
        </nav>
      </aside>

      <main style={{ flex: 1, padding: 16 }}>
        <Outlet />
      </main>
    </div>
  );
}
