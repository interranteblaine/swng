import { BrowserRouter, Link, Outlet, Route, Routes, useLocation } from "react-router";
import { SignInButton } from "./auth/SignInButton";
import { AuthProvider, useAuth } from "./auth/useAuth";
import { AddCoursePage } from "./courses/AddCoursePage";
import { CoursePage } from "./courses/CoursePage";
import { CoursesHubPage } from "./courses/CoursesHubPage";
import { EditCoursePage } from "./courses/EditCoursePage";
import { CrewCreatePage } from "./crews/CrewCreatePage";
import { CrewPage } from "./crews/CrewPage";
import { GolferPage } from "./golfers/GolferPage";
import { ArchivedRoundPage } from "./round/ArchivedRoundPage";
import { AuthCallbackPage } from "./routes/AuthCallbackPage";
import { CreateRoundPage } from "./routes/CreateRoundPage";
import { CrewJoinPage } from "./routes/CrewJoinPage";
import { HomePage } from "./routes/HomePage";
import { JoinRoundPage } from "./routes/JoinRoundPage";
import { NotFoundPage } from "./routes/NotFoundPage";
import { ProfilePage } from "./routes/ProfilePage";
import { RoundPage } from "./routes/RoundPage";
import { linkEntity } from "./ui/classes";
import { ScrollToTop } from "./ui/ScrollToTop";
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
    <div className="flex items-center gap-3">
      <Link to="/profile" className={`font-mono text-xs text-fairway ${linkEntity}`}>
        {displayName}
      </Link>
      <button type="button" onClick={() => auth.signOut()} className="font-mono text-xs text-fairway">
        Sign out
      </button>
    </div>
  );
}

// One header, over an <Outlet/>, shared by every route except AuthCallbackPage (below) — the
// second instance of "a page needs the identity chrome" is what earns this its own component
// (engineering-conventions §0), rather than every page hand-rolling its own header row.
function Layout() {
  const { signedIn } = useAuth();
  const { pathname } = useLocation();
  // The signed-out home IS the landing page (brand reskin spec §3): no app header — the hero's
  // first word is the wordmark. Every other route, signed out or in, keeps the chrome (e2e
  // relies on the compact Sign in existing on signed-out inner pages like /join).
  if (!signedIn && pathname === "/") return <Outlet />;
  return (
    <div className="min-h-screen bg-cream">
      <header className="flex items-center justify-between gap-4 border-b-[1.5px] border-forest px-4 py-3 text-forest">
        <Link to="/" className="text-lg font-extrabold tracking-tight text-forest">
          swng
        </Link>
        {/* Navigation Task 3: the header's one new destination — shown signed in AND signed out
            (course reads are public). Small uppercase forest text, not gold (the brand rule:
            gold stays the one primary action per screen). */}
        <nav className="flex items-center gap-3">
          <Link to="/courses" className="text-xs font-semibold tracking-widest text-forest uppercase">
            Courses
          </Link>
          <AuthChrome />
        </nav>
      </header>
      <Outlet />
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <ScrollToTop />
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/create" element={<CreateRoundPage />} />
            {/* Navigation Task 3: /courses is the hub — a static segment, ranked ahead of the
                dynamic /courses/:courseId below by react-router itself regardless of declaration
                order, but placed here too for the same readability reason /courses/new (right
                below) and /crews/new already are. */}
            <Route path="/courses" element={<CoursesHubPage />} />
            {/* /courses/new is a static segment, ranked ahead of the dynamic /courses/:courseId
                below by react-router itself regardless of declaration order — kept here too for
                the same readability reason /crews/new sits ahead of /crews/:crewId. */}
            <Route path="/courses/new" element={<AddCoursePage />} />
            <Route path="/courses/:courseId" element={<CoursePage />} />
            <Route path="/courses/:courseId/edit" element={<EditCoursePage />} />
            {/* Navigation Task 4: any player's record, read-only — inside Layout (the golfer
                Bearer, via useAuth's withAuth, only exists signed in; the header chrome is exactly
                what a signed-in golfer expects browsing from a link off a scorecard/crew page). */}
            <Route path="/golfers/:golferId" element={<GolferPage />} />
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
            {/* A real 404 — LAST inside the Layout route group, so it only catches paths none of
                the routes above matched. Keeps the header/chrome (Layout), unlike the two bare
                transitional routes below it (AuthCallbackPage/WatchPage), which are outside
                Layout for their own reasons. */}
            <Route path="*" element={<NotFoundPage />} />
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
