import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router";
import type { GetMyRecordResponse, ListMyCrewsResponse } from "@swng/contracts";
import type { CourseId, GolferRoundLine, IndexSource } from "@swng/domain";
import { resolveIndex } from "@swng/domain";
import { getCourse, getMyRecord, listMyCrews, updateMe } from "../api";
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

// The two adoptable computed sources shown beneath "Your index" (index-source model spec §6) —
// each a labeled data point read straight off GET /me/record's metrics, with a one-tap "Use this"
// that sets the golfer's index SOURCE (`{kind}`), NOT a value copied into a box: adopting swng/whs
// puts you ON that live source, so the number tracks and can never drift (spec §2, the anti-drift
// fix). Table-driven so adding a source is adding a row, never a new branch; `valueOf` pulls the
// number (or undefined → renders "—", no button) and `useLabel` is the button's accessible name
// (both buttons share the visible "Use this" text, so distinct aria-labels keep them individually
// addressable). `description` is the model's own gloss: the swng index counts every round; the WHS
// index is the strict rated-only official number.
const INDEX_SOURCES: readonly { readonly kind: "swng" | "whs"; readonly label: string; readonly description: string; readonly useLabel: string; readonly valueOf: (record: GetMyRecordResponse | undefined) => number | undefined }[] = [
  { kind: "swng", label: "swng index", description: "from all your rounds", useLabel: "Use swng index", valueOf: (record) => record?.metrics?.swngIndex?.value },
  { kind: "whs", label: "WHS index", description: "rated rounds, official rules", useLabel: "Use WHS index", valueOf: (record) => record?.metrics?.whsIndex?.value },
];

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

// Name + home course + index SOURCE (PUT /me), the computed record (index, bootstrap explainer,
// trend, distribution, history) — the ProfilePage contract. The index a golfer is on is a source
// they choose (index-source model spec §3), resolved live; Save persists the CHOICE, never a
// computed value. Since the wall (accounts-only identity spec §2) GET /me get-or-creates the
// caller's golfer on first touch (ensureGolfer), this page always edits an EXISTING golfer — Save
// (updateMe) is an update, never the create path.
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
  // The chosen COMPUTED source (swng/whs) — which live source the golfer is on when they haven't
  // asserted their own number. `declared` is the override text: non-empty ⟺ a declared source
  // wins (index-source model spec §3/§6). Together they are the golfer's IndexSource, resolved live.
  const [computedChoice, setComputedChoice] = useState<"swng" | "whs">("swng");
  const [declared, setDeclared] = useState("");
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
    // Hydrate the source: a whs source arms the whs computed choice; a declared source fills the
    // override; swng (or a null/absent golfer) is the default. Never a copied computed VALUE.
    const source = auth.golfer?.indexSource ?? { kind: "swng" as const };
    setComputedChoice(source.kind === "whs" ? "whs" : "swng");
    setDeclared(source.kind === "declared" ? String(source.value) : "");
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

  // The golfer's chosen index source (index-source model spec §3): a non-empty, finite override
  // is a declared assertion; otherwise the armed computed source (swng/whs). This IS what Save
  // persists and what the active-value paragraph resolves — one source, one place, no drift.
  const parsedOverride = declared.trim() === "" ? undefined : Number.parseFloat(declared.trim());
  const pendingSource: IndexSource =
    parsedOverride !== undefined && Number.isFinite(parsedOverride) ? { kind: "declared", value: parsedOverride } : { kind: computedChoice };
  const resolved = resolveIndex(pendingSource, record?.metrics ?? {});

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    setSaving(true);
    setSaved(false);
    setError(undefined);
    try {
      await auth.withAuth((token) =>
        updateMe(token, {
          name: name.trim(),
          ...(homeCourse ? { homeCourseId: homeCourse.id } : {}),
          indexSource: pendingSource,
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
        <p className="text-slate-400">Sign in to see your profile and swng index.</p>
      </main>
    );
  }

  // "Your index" (index-source model spec §3/§6) — one active number, ALWAYS shown with its
  // source, resolved live above (`resolved`) from `pendingSource` + the metrics. A declared
  // override reads "your own"; a whs source reads "your WHS index"; swng reads "from all your
  // rounds". There is no hidden precedence — whatever the chosen source resolves to is what's
  // shown, and adopting a computed source tracks it because it's resolved, never copied.
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

        {/* Your index (index-source model spec §3/§6): ONE number the golfer owns, always on the
            screen with its source, resolved live from the chosen SOURCE — never a value the system
            picks off-screen, never a copy that can drift. The active value + where it came from sits
            at the top; the two computed sources (swng by default, WHS as a reference) sit beneath
            with a one-tap "Use this" that sets the SOURCE (not a copied value) and marks the active
            one "in use"; the override is the plain "type your own" input. Deliberately NO divergence
            threshold, no "you should change this" prose, no auto-write — just the numbers, resolved
            fresh, and the golfer decides. */}
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Your index</h2>

          {resolved.value !== undefined ? (
            <p className="flex items-baseline gap-2">
              <span className="text-3xl font-bold">{resolved.value.toFixed(1)}</span>
              {/* The source phrasing IS the legibility — the golfer always sees WHICH number they're
                  on: "your own" (declared), "your WHS index" (whs), or "from all your rounds" (swng). */}
              <span className="text-sm text-slate-400">
                {resolved.kind === "declared" ? "your own" : resolved.kind === "whs" ? "your WHS index" : "from all your rounds"}
              </span>
            </p>
          ) : (
            // A computed source with no data yet resolves to undefined (first-class, not 0) — the
            // reason names the source the golfer is on so the "—" is legible, never a bare blank.
            <p className="text-sm text-slate-400">
              {resolved.kind === "whs"
                ? "No WHS index yet — play a few rated rounds, or pick another source below."
                : "No index yet — play a few rounds and swng will compute one, or set your own below."}
            </p>
          )}

          <div className="flex flex-col gap-2" aria-label="Index sources">
            {INDEX_SOURCES.map((source) => {
              const value = source.valueOf(record);
              // Active ⟺ no override typed AND this is the armed computed choice — the "in use"
              // marker, and the one row that shows no "Use this" button.
              const active = declared.trim() === "" && computedChoice === source.kind;
              return (
                <div key={source.label} className="flex items-center justify-between gap-2 text-sm">
                  {/* Label · value on the outer span's own direct text nodes (so a query for
                      "swng index · 9.4" reads one node), with the model's gloss on a nested line. A
                      source with no data reads "—" and offers no button. */}
                  <span className="text-slate-300">
                    {source.label} · {value !== undefined ? value : "—"}
                    <span className="block text-xs text-slate-500">{source.description}</span>
                  </span>
                  {active ? (
                    <span className="shrink-0 text-xs text-emerald-400">in use</span>
                  ) : (
                    value !== undefined && (
                      <button
                        type="button"
                        aria-label={source.useLabel}
                        // Sets the SOURCE (not a copied value) and clears any override — this is the
                        // anti-drift fix: on WHS, the shown number IS the live WHS metric, resolved.
                        onClick={() => {
                          setComputedChoice(source.kind);
                          setDeclared("");
                        }}
                        className="shrink-0 text-emerald-400 underline"
                      >
                        Use this
                      </button>
                    )
                  )}
                </div>
              );
            })}
          </div>

          <label className="flex flex-col gap-1">
            Your own number
            <input value={declared} onChange={(event) => setDeclared(event.target.value)} inputMode="decimal" className="rounded-lg bg-slate-800 p-3 text-lg" />
          </label>
        </section>

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

      {/* Crews (moved here from HomePage — spec §11a, owner ruling: a crew is a
          grouping/competition only, not part of the play surface). Crew membership (invited in,
          accountable out — spec §2/§3): the join-by-code form is gone — "New crew" plus the list
          of crews already joined is the whole section now; joining an existing crew is an
          invite-link funnel (CrewJoinPage, `/crews/join`), never typed here. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-slate-300">Your crews</h2>
        {crews && crews.length > 0 && (
          <ul className="flex flex-col gap-2">
            {crews.map((crew) => (
              <li key={crew.crewId}>
                <Link to={`/crews/${crew.crewId}`} className="flex items-center justify-between rounded-lg bg-slate-800 px-4 py-3">
                  <span>{crew.name}</span>
                  <span className="text-sm text-slate-400">
                    {crew.memberCount} member{crew.memberCount === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <Link to="/crews/new" className="self-start text-emerald-400 underline">
          New crew
        </Link>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Your record</h2>

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
