import { Link } from "react-router";
import { usePageTitle } from "../ui/usePageTitle";

// The `path="*"` catch-all inside App.tsx's Layout route group (LAST, so every real route above
// it wins first) — a real 404 rather than a silent blank Outlet. The home link wears the app's
// quiet secondary text treatment (AuthCallbackPage's own "Back to swng" idiom), never gold fill —
// this is a dead end, not the screen's primary action.
export function NotFoundPage() {
  usePageTitle("Not found");
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-cream p-6 text-center">
      <h1 className="text-2xl font-bold text-forest">This page doesn&apos;t exist.</h1>
      <Link to="/" className="text-forest underline decoration-fairway decoration-2">
        Back to swng
      </Link>
    </main>
  );
}
