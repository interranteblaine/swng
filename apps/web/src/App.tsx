import { BrowserRouter, Link, Outlet, Route, Routes } from "react-router";
import { SignInButton } from "./auth/SignInButton";
import { AuthProvider, useAuth } from "./auth/useAuth";
import { AddCoursePage } from "./courses/AddCoursePage";
import { EditCoursePage } from "./courses/EditCoursePage";
import { CrewCreatePage } from "./crews/CrewCreatePage";
import { CrewPage } from "./crews/CrewPage";
import { ArchivedRoundPage } from "./round/ArchivedRoundPage";
import { AuthCallbackPage } from "./routes/AuthCallbackPage";
import { CreateRoundPage } from "./routes/CreateRoundPage";
import { CrewJoinPage } from "./routes/CrewJoinPage";
import { HomePage } from "./routes/HomePage";
import { JoinRoundPage } from "./routes/JoinRoundPage";
import { ProfilePage } from "./routes/ProfilePage";
import { RoundPage } from "./routes/RoundPage";
import { WatchPage } from "./watch/WatchPage";

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
            <Route path="/courses/:courseId/edit" element={<EditCoursePage />} />
            <Route path="/crews/new" element={<CrewCreatePage />} />
            {/* Crew membership (invited in, accountable out — spec §2): the invite funnel — a
                static segment, ranked ahead of the dynamic /crews/:crewId below by react-router
                itself regardless of declaration order, but placed here too for the same
                readability reason /crews/new already is. */}
            <Route path="/crews/join" element={<CrewJoinPage />} />
            <Route path="/crews/:crewId" element={<CrewPage />} />
            <Route path="/join" element={<JoinRoundPage />} />
            <Route path="/round/:roundId" element={<RoundPage />} />
            {/* Projection-realignment Task 6: INSIDE Layout, unlike /watch/:roundId below —
                this route needs the golfer Bearer (useAuth's withAuth), which only exists
                signed in, and the header chrome is exactly what a signed-in golfer expects
                browsing from their own Profile. */}
            <Route path="/rounds/:roundId/archive" element={<ArchivedRoundPage />} />
            <Route path="/profile" element={<ProfilePage />} />
          </Route>
          {/* Outside Layout on purpose: mid-redirect from the Hosted UI is a bare transitional
              screen (a centered "Signing you in..."/error state), not a page that needs the
              app chrome — and there's no signed-in identity to show in a header yet anyway. */}
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          {/* Outside Layout too (M9 Task 3, share): "No sign-in, no chrome that invites edits"
              (the brief) — AuthChrome's sign-in/sign-out links have no place on a read-only
              spectator page, and there's nothing here for them to act on anyway (WatchPage
              never touches auth at all). */}
          <Route path="/watch/:roundId" element={<WatchPage />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
