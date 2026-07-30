import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router";
import type { GetMyRecordResponse, ListMyCrewsResponse } from "@swng/contracts";
import type { CourseId, GolferMetrics } from "@swng/domain";
import { getCourse, getMyRecord, listMyCrews, updateMe } from "../api";
import { useAuth } from "../auth/useAuth";
import { CourseSearch } from "../courses/CourseSearch";
import { RecordSections } from "../golfers/RecordSections";
import { btnPrimary, btnQuiet, cardBox, inputBox, linkEntity } from "../ui/classes";
import { usePageTitle } from "../ui/usePageTitle";

// The record section below (RecordSections, navigation spec §6c.3) renders unconditionally, even
// before GET /me/record resolves — its `metrics` prop is REQUIRED (a shared component takes a
// real default, never an implicit fallback baked into itself), so this is that default: zeroed
// rather than absent, matching the wire's own zeroed-not-absent contract for typicalEighteen.
const ZERO_METRICS: GolferMetrics = {
  typicalEighteen: { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  averageHistory: [],
  bests: {},
  milestones: [],
};

// Name + home course (the Save button) plus the served record (the headline average, its chart,
// bests/milestones, typical 18, history) — the ProfilePage contract. **The profile is a reporting
// artifact with no inputs beyond those two fields** (spec 2026-07-29 §5): the whole "Your index"
// section — the source picker, its one-tap commit, the override box and the applyGolfer index path
// — is deleted with the index it selected between. What a golfer shoots is computed from their own
// rounds and shown below; what they play off is the number they state when they join a round.
// Since the wall (accounts-only identity spec §2) GET /me get-or-creates the caller's golfer on
// first touch (ensureGolfer), this page always edits an EXISTING golfer — updateMe is an update,
// never the create path.
export function ProfilePage() {
  usePageTitle("Your profile");
  const auth = useAuth();
  // Destructured so the record-fetch effect below lists a stable function reference as its
  // dep (withAuth's own useCallback identity, useAuth.ts) rather than the whole `auth` object,
  // which is a fresh literal every AuthProvider render (session/useRoundSession.ts's `sync`/
  // `connect` destructuring is the same precedent).
  const { withAuth } = auth;

  const [name, setName] = useState("");
  const [homeCourse, setHomeCourse] = useState<{ readonly id: CourseId; readonly name: string } | undefined>(undefined);
  const [pickingCourse, setPickingCourse] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [record, setRecord] = useState<GetMyRecordResponse | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Crews section (moved here from HomePage — spec §11a, owner ruling: a crew is a
  // grouping/competition only, so it lives on the profile, not the play surface). Same shape as
  // HomePage's own crews block before this move: undefined = signed out / not loaded (yet or
  // failed) — the list renders only from a real response. The fetch is a nicety: a transient
  // failure just leaves the section's list empty rather than blocking the "New crew" affordance,
  // which needs no data at all. Crew membership (invited in, accountable out — spec §2/§3): the
  // join-by-code input and its golfer-required alert arm are deleted whole — an invite LINK
  // (CrewJoinPage, `/crews/join`) is the one way in now, never a typed code on this page.
  const [crews, setCrews] = useState<ListMyCrewsResponse["crews"] | undefined>(undefined);

  // Seeds the form from the golfer row exactly once it's known (undefined = still
  // loading/signed out; null or a real view both count as "known") — never re-syncs after
  // that, so it can't clobber an edit in progress.
  useEffect(() => {
    if (hydrated) return;
    if (auth.golfer === undefined) return;
    setName(auth.golfer?.name ?? "");
    setHydrated(true);

    const homeCourseId = auth.golfer?.homeCourseId;
    if (homeCourseId) {
      getCourse(homeCourseId)
        .then((response) => setHomeCourse({ id: response.course.courseId, name: response.course.card.courseName }))
        .catch(() => {}); // a friendly name is a nicety — a failed lookup just leaves the picker open, never blocks the page
    }
  }, [auth.golfer, hydrated]);

  useEffect(() => {
    if (!auth.signedIn) return;
    void withAuth((token) => getMyRecord(token))
      .then(setRecord)
      .catch(() => {}); // withAuth already handles a terminal 401 (signs out); anything else just leaves the record unset
  }, [auth.signedIn, withAuth]);

  useEffect(() => {
    if (!auth.signedIn) {
      setCrews(undefined);
      return;
    }
    void withAuth((token) => listMyCrews(token))
      .then((response) => setCrews(response.crews))
      .catch(() => {}); // degrade silently — see the state's own comment
  }, [auth.signedIn, withAuth]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    setSaving(true);
    setSaved(false);
    setError(undefined);
    try {
      // Name + home only — the whole editable profile (spec 2026-07-29 §5). Apply the PUT's own
      // response in place (one request per action): no GET /me refetch.
      const response = await auth.withAuth((token) =>
        updateMe(token, {
          name: name.trim(),
          ...(homeCourse ? { homeCourseId: homeCourse.id } : {}),
        }),
      );
      auth.applyGolfer(response.golfer);
      setSaved(true);
    } catch {
      // Never the raw caught.message — a golfer revision-mismatch 409 names the golfer's raw
      // internal id/revision, matching the never-raw-server-text pattern already applied to
      // finalize (RoundPage.tsx) and game termination.
      setError("Could not save your profile — try again.");
    } finally {
      setSaving(false);
    }
  };

  if (!auth.signedIn) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 bg-cream p-6">
        <h1 className="text-2xl font-bold">Profile</h1>
        <p className="text-fairway">Sign in to see your profile and your record.</p>
      </main>
    );
  }

  const history = record?.history ?? [];

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-8 bg-cream p-6">
      <h1 className="text-2xl font-bold">Profile</h1>

      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} className={`${inputBox} text-lg`} />
        </label>

        <div className="flex flex-col gap-1">
          <span>Home course</span>
          {!pickingCourse && homeCourse ? (
            <div className={`${cardBox} flex items-center justify-between gap-2 p-3`}>
              <Link to={`/courses/${homeCourse.id}`} className={`text-forest ${linkEntity}`}>
                {homeCourse.name}
              </Link>
              <button type="button" onClick={() => setPickingCourse(true)} className={`text-sm ${btnQuiet}`}>
                Change
              </button>
            </div>
          ) : (
            <CourseSearch
              onSelect={(courseId, courseName) => {
                setHomeCourse({ id: courseId, name: courseName });
                setPickingCourse(false);
              }}
            />
          )}
        </div>

        {error && (
          <p role="alert" className="text-oxblood">
            {error}
          </p>
        )}
        {saved && !error && (
          <p role="status" className="text-forest">
            Saved.
          </p>
        )}

        <button type="submit" disabled={saving} className={`${btnPrimary} disabled:opacity-50`}>
          {saving ? "Saving…" : "Save"}
        </button>
      </form>

      {/* Crews (moved here from HomePage — spec §11a, owner ruling: a crew is a
          grouping/competition only, not part of the play surface). Crew membership (invited in,
          accountable out — spec §2/§3): the join-by-code form is gone — "New crew" plus the list
          of crews already joined is the whole section now; joining an existing crew is an
          invite-link funnel (CrewJoinPage, `/crews/join`), never typed here. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-fairway">Your crews</h2>
        {crews && crews.length > 0 && (
          <ul className="flex flex-col gap-2">
            {crews.map((crew) => (
              <li key={crew.crewId}>
                <Link to={`/crews/${crew.crewId}`} className={`${cardBox} flex items-center justify-between px-4 py-3`}>
                  <span>{crew.name}</span>
                  <span className="text-sm text-fairway">
                    {crew.memberCount} member{crew.memberCount === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <Link to="/crews/new" className={`self-start ${btnQuiet}`}>
          New crew
        </Link>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Your record</h2>

        {/* The chart/typical-18/history JSX (navigation spec §6c.3) — extracted so GolferPage
            renders the SAME thing about someone else, never a second copy. */}
        <RecordSections metrics={record?.metrics ?? ZERO_METRICS} history={history} />
      </section>
    </main>
  );
}
