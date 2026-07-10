import { BrowserRouter, Link, Outlet, Route, Routes } from "react-router";
import { SignInButton } from "./auth/SignInButton";
import { AuthProvider, useAuth } from "./auth/useAuth";
import { AddCoursePage } from "./courses/AddCoursePage";
import { AuthCallbackPage } from "./routes/AuthCallbackPage";
import { CreateRoundPage } from "./routes/CreateRoundPage";
import { HomePage } from "./routes/HomePage";
import { JoinRoundPage } from "./routes/JoinRoundPage";
import { ProfilePage } from "./routes/ProfilePage";
import { RoundPage } from "./routes/RoundPage";

// The signed-in half of the header's identity chrome (brief: "Signed-in chrome: name in the
// header, links to /profile") — SignInButton.tsx is exactly the OTHER (signed-out) half; this
// composition is the only place both halves meet, so it lives here rather than in a third
// component neither owns. Controller amendment 1: `golfer` can be null (signed in, no row
// yet) — the display name falls back to the ID token's own email localpart in that case.
function AuthChrome() {
  const auth = useAuth();
  if (!auth.signedIn) return <SignInButton />;

  const displayName = auth.golfer?.name ?? auth.email?.split("@")[0] ?? "Signed in";
  return (
    <div className="flex items-center gap-3 text-sm">
      <Link to="/profile" className="font-medium text-emerald-400 underline">
        {displayName}
      </Link>
      <button type="button" onClick={() => auth.signOut()} className="text-slate-400">
        Sign out
      </button>
    </div>
  );
}

// One header, over an <Outlet/>, shared by every route except AuthCallbackPage (below) — the
// second instance of "a page needs the identity chrome" is what earns this its own component
// (engineering-conventions §0), rather than every page hand-rolling its own header row.
function Layout() {
  return (
    <div className="min-h-screen bg-slate-950">
      <header className="flex items-center justify-between gap-4 border-b border-slate-800 px-4 py-3 text-slate-100">
        <Link to="/" className="text-lg font-bold">
          swng
        </Link>
        <AuthChrome />
      </header>
      <Outlet />
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/create" element={<CreateRoundPage />} />
            <Route path="/courses/new" element={<AddCoursePage />} />
            <Route path="/join" element={<JoinRoundPage />} />
            <Route path="/round/:roundId" element={<RoundPage />} />
            <Route path="/profile" element={<ProfilePage />} />
          </Route>
          {/* Outside Layout on purpose: mid-redirect from the Hosted UI is a bare transitional
              screen (a centered "Signing you in..."/error state), not a page that needs the
              app chrome — and there's no signed-in identity to show in a header yet anyway. */}
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
