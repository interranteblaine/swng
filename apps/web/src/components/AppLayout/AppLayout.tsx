import * as Dialog from "@radix-ui/react-dialog";
import { NavLink, Outlet } from "react-router-dom";
import { useCurrentRoundId } from "../../hooks/useCurrentRoundId";
import styles from "./AppLayout.module.css";

export function AppLayout() {
  const roundId = useCurrentRoundId();

  return (
    <div className={styles.appLayout}>
      {/* Mobile header with a single Dialog drawer */}
      <header className={styles.mobileOnly} role="banner">
        <Dialog.Root>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: 12,
            }}
          >
            <Dialog.Trigger asChild>
              <button type="button" aria-label="Open menu">
                ☰
              </button>
            </Dialog.Trigger>
            <div style={{ fontWeight: 600 }}>Swng</div>
          </div>

          <Dialog.Portal>
            <Dialog.Overlay className={styles.drawerOverlay} />
            <Dialog.Content
              className={styles.drawerContent}
              aria-label="Main navigation"
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 12,
                }}
              >
                <div style={{ fontWeight: 600 }}>Menu</div>
                <Dialog.Close asChild>
                  <button type="button" aria-label="Close menu">
                    ×
                  </button>
                </Dialog.Close>
              </div>
              <nav aria-label="Main">
                <ul style={{ listStyle: "none", padding: 0 }}>
                  <li>
                    <Dialog.Close asChild>
                      <NavLink to="/rounds/create">Create Round</NavLink>
                    </Dialog.Close>
                  </li>
                  <li>
                    <Dialog.Close asChild>
                      <NavLink to="/rounds/join">Join Round</NavLink>
                    </Dialog.Close>
                  </li>
                  {roundId ? (
                    <li>
                      <Dialog.Close asChild>
                        <NavLink to={`/rounds/${roundId}`}>Round</NavLink>
                      </Dialog.Close>
                    </li>
                  ) : null}
                </ul>
              </nav>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </header>

      {/* Persistent sidebar on ≥768px */}
      <aside
        className={styles.desktopOnly}
        aria-label="Main navigation"
        style={{ padding: 16 }}
      >
        <nav>
          <h1>Swng</h1>
          <ul style={{ listStyle: "none", padding: 0 }}>
            <li>
              <NavLink to="/rounds/create">Create Round</NavLink>
            </li>
            <li>
              <NavLink to="/rounds/join">Join Round</NavLink>
            </li>
            {roundId ? (
              <li>
                <NavLink to={`/rounds/${roundId}`}>Round</NavLink>
              </li>
            ) : null}
          </ul>
        </nav>
      </aside>

      <main style={{ flex: 1, padding: 16 }}>
        <Outlet />
      </main>
    </div>
  );
}
