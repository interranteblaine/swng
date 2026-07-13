import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router";
import type { GetMyRecordResponse } from "@swng/contracts";
import type { CourseId, GolferRoundLine } from "@swng/domain";
import { effectiveIndex } from "@swng/domain";
import { getCourse, getMyRecord, updateMe } from "../api";
import { useAuth } from "../auth/useAuth";
import { CourseSearch } from "../courses/CourseSearch";

// Last 20 differentials, oldest -> newest (left to right) — `history` itself arrives
// newest-first (GetMyRecordResponse's own doc comment), so this takes the newest 20 then
// reverses, rather than re-deriving an order the wire type already promises.
const trendPoints = (history: readonly GolferRoundLine[]): readonly number[] =>
  history
    .map((line) => line.differential)
    .filter((d): d is number => d !== undefined)
    .slice(0, 20)
    .reverse();

// A dependency-free inline SVG (brief: "no chart lib") — a plain polyline is enough to show a
// trend; nothing here is precise enough (or needs to be) to warrant an axis/tooltip library.
function IndexTrend({ history }: { readonly history: readonly GolferRoundLine[] }) {
  const points = trendPoints(history);
  if (points.length < 2) return null; // nothing to trend with 0-1 posted differentials

  const width = 280;
  const height = 72;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1; // every point identical: avoid a divide-by-zero flatline crash
  const coords = points
    .map((value, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = height - ((value - min) / span) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg role="img" aria-label="Index trend" viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="rounded-lg bg-slate-900 text-emerald-400">
      <polyline points={coords} fill="none" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}

type DistributionKey = keyof GolferRoundLine["distribution"];
const DISTRIBUTION_ROWS: readonly { readonly key: DistributionKey; readonly label: string }[] = [
  { key: "eagles", label: "Eagle or better" },
  { key: "birdies", label: "Birdie" },
  { key: "pars", label: "Par" },
  { key: "bogeys", label: "Bogey" },
  { key: "doublePlus", label: "Double bogey+" },
];

// Summed across the WHOLE history (not just the trend's last-20 window) — a career scoring
// profile, not a recent-form snapshot.
function DistributionBars({ history }: { readonly history: readonly GolferRoundLine[] }) {
  const totals = history.reduce<Record<DistributionKey, number>>(
    (acc, line) => {
      for (const row of DISTRIBUTION_ROWS) acc[row.key] += line.distribution[row.key];
      return acc;
    },
    { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 },
  );
  const max = Math.max(1, ...DISTRIBUTION_ROWS.map((row) => totals[row.key]));

  return (
    <ul aria-label="Scoring distribution" className="flex flex-col gap-1">
      {DISTRIBUTION_ROWS.map((row) => (
        <li key={row.key} className="flex items-center gap-2 text-sm text-slate-300">
          <span className="w-32 shrink-0 text-slate-400">{row.label}</span>
          <span className="h-3 min-w-[2px] rounded bg-emerald-700" style={{ width: `${(totals[row.key] / max) * 100}%` }} />
          <span>{totals[row.key]}</span>
        </li>
      ))}
    </ul>
  );
}

// Name + home course + declared index (PUT /me), the computed record (index, bootstrap
// explainer, trend, distribution, history) — brief's full ProfilePage contract. GET /me never
// creates (controller amendment 1): this page's first Save IS the create path for a
// brand-new sub, via updateMe.
export function ProfilePage() {
  const auth = useAuth();
  // Destructured so the record-fetch effect below lists a stable function reference as its
  // dep (withAuth's own useCallback identity, useAuth.ts) rather than the whole `auth` object,
  // which is a fresh literal every AuthProvider render (session/useRoundSession.ts's `sync`/
  // `connect` destructuring is the same precedent).
  const { withAuth } = auth;

  const [name, setName] = useState("");
  const [homeCourse, setHomeCourse] = useState<{ readonly id: CourseId; readonly name: string } | undefined>(undefined);
  const [pickingCourse, setPickingCourse] = useState(false);
  const [declared, setDeclared] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [record, setRecord] = useState<GetMyRecordResponse | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Seeds the form from the golfer row exactly once it's known (undefined = still
  // loading/signed out; null or a real view both count as "known") — never re-syncs after
  // that, so it can't clobber an edit in progress.
  useEffect(() => {
    if (hydrated) return;
    if (auth.golfer === undefined) return;
    setName(auth.golfer?.name ?? "");
    setDeclared(auth.golfer?.declared !== undefined ? String(auth.golfer.declared) : "");
    setHydrated(true);

    const homeCourseId = auth.golfer?.homeCourseId;
    if (homeCourseId) {
      getCourse(homeCourseId)
        .then((response) => setHomeCourse({ id: response.course.courseId, name: response.course.name }))
        .catch(() => {}); // a friendly name is a nicety — a failed lookup just leaves the picker open, never blocks the page
    }
  }, [auth.golfer, hydrated]);

  useEffect(() => {
    if (!auth.signedIn) return;
    void withAuth((token) => getMyRecord(token))
      .then(setRecord)
      .catch(() => {}); // withAuth already handles a terminal 401 (signs out); anything else just leaves the record unset
  }, [auth.signedIn, withAuth]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedDeclared = declared.trim();
    const parsedDeclared = trimmedDeclared === "" ? undefined : Number.parseFloat(trimmedDeclared);
    if (trimmedDeclared !== "" && !Number.isFinite(parsedDeclared)) return;

    setSaving(true);
    setSaved(false);
    setError(undefined);
    try {
      await auth.withAuth((token) =>
        updateMe(token, {
          name: name.trim(),
          ...(homeCourse ? { homeCourseId: homeCourse.id } : {}),
          ...(parsedDeclared !== undefined ? { declared: parsedDeclared } : {}),
        }),
      );
      await auth.refetch(); // the header chrome and this page both read auth.golfer — refresh it now, not on next remount
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
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 bg-slate-950 p-6 text-slate-100">
        <h1 className="text-2xl font-bold">Profile</h1>
        <p className="text-slate-400">Sign in to see your profile and swng Index.</p>
      </main>
    );
  }

  const effective = effectiveIndex({ declared: auth.golfer?.declared, official: auth.golfer?.official, computed: record?.index?.value });
  const history = record?.history ?? [];

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-8 bg-slate-950 p-6 text-slate-100">
      <h1 className="text-2xl font-bold">Profile</h1>

      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg" />
        </label>

        <div className="flex flex-col gap-1">
          <span>Home course</span>
          {!pickingCourse && homeCourse ? (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-800 p-3">
              <span>{homeCourse.name}</span>
              <button type="button" onClick={() => setPickingCourse(true)} className="text-sm text-emerald-400 underline">
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

        <label className="flex flex-col gap-1">
          Declared index
          <input value={declared} onChange={(event) => setDeclared(event.target.value)} inputMode="decimal" className="rounded-lg bg-slate-800 p-3 text-lg" />
        </label>

        {error && (
          <p role="alert" className="text-red-400">
            {error}
          </p>
        )}
        {saved && !error && (
          <p role="status" className="text-emerald-400">
            Saved.
          </p>
        )}

        <button type="submit" disabled={saving} className="rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold disabled:opacity-50">
          {saving ? "Saving…" : "Save"}
        </button>
      </form>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Your record</h2>

        {record?.index ? (
          <p>
            swng Index <strong>{record.index.value.toFixed(1)}</strong>
            <span className="text-slate-400"> — from {record.index.differentialsUsed} differential{record.index.differentialsUsed === 1 ? "" : "s"}</span>
          </p>
        ) : (
          <p className="text-slate-400">computes after 3 posted 18-hole-equivalent differentials</p>
        )}

        <p className="text-sm text-slate-400">Effective index: {effective ? `${effective.value.toFixed(1)} (${effective.source})` : "not yet set"}</p>

        <IndexTrend history={history} />
        <DistributionBars history={history} />

        <div>
          <h3 className="text-base font-semibold">History</h3>
          {history.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {history.map((line) => (
                <li key={line.roundId} className="text-sm text-slate-300">
                  {/* Projection-realignment Task 6: every history line opens its own
                      ArchivedRoundPage — the "open one finalized round" half of this task,
                      reached from the "list my rounds" half already rendered here. */}
                  <Link to={`/rounds/${line.roundId}/archive`} className="underline decoration-slate-600 underline-offset-2 hover:decoration-slate-400">
                    {line.courseName} — {line.tee} — AGS {line.ags ?? "—"} — differential {line.differential !== undefined ? line.differential.toFixed(1) : "—"}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-slate-400">No rounds yet.</p>
          )}
        </div>
      </section>
    </main>
  );
}
