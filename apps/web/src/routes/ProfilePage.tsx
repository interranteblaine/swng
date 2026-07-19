import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router";
import type { GetMyRecordResponse, ListMyCrewsResponse } from "@swng/contracts";
import type { CourseId, IndexSource } from "@swng/domain";
import { formatHandicapIndex, resolveIndex } from "@swng/domain";
import { getCourse, getMyRecord, listMyCrews, updateMe } from "../api";
import { useAuth } from "../auth/useAuth";
import { CourseSearch } from "../courses/CourseSearch";
import { btnPrimary, cardBox, inputBox } from "../ui/classes";

// "Your index over time" (metrics-projection-grows spec, papercut 17's follow-on) — a
// dependency-free inline SVG (no chart lib needed: two plain polylines are enough to show
// swng drifting under/over WHS). `points` is the served metrics projection's own `indexHistory`
// (domain/golfer/metrics.ts's golferMetrics) — one point per round, oldest → newest, each
// carrying the golfer's swng/WHS index AS OF that round; this component only renders it, it
// never derives index math (SVG coordinate placement is presentation, not golf compute). Below
// INDEX_HISTORY_MIN_ROUNDS rounds the chart is GATED, not drawn — a 1-3 point sparkline is noise,
// not a trend (the exact defect this redesign replaces: the OLD page plotted an unlabeled
// score-differential line from round one).
const INDEX_HISTORY_MIN_ROUNDS = 8;

function IndexOverTime({
  points,
  roundsPlayed,
}: {
  readonly points: GetMyRecordResponse["metrics"]["indexHistory"];
  readonly roundsPlayed: number;
}) {
  if (roundsPlayed < INDEX_HISTORY_MIN_ROUNDS) {
    return (
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">Your index over time</h3>
        <p className="text-sm text-fairway">
          {`Your index history shows up at ${INDEX_HISTORY_MIN_ROUNDS} rounds — you've played ${roundsPlayed}. Keep going.`}
        </p>
      </div>
    );
  }

  const width = 280;
  const height = 96;
  const n = points.length;
  const values = points.flatMap((point) => [point.swngIndex, point.whsIndex].filter((value): value is number => value !== undefined));
  const min = Math.min(...values);
  const max = Math.max(...values);

  // The SAME point index maps to the same x whichever series it belongs to, so the two lines
  // stay comparable; a LOWER index sits LOWER on screen (improving play trends the line down).
  const pointsFor = (key: "swngIndex" | "whsIndex"): readonly { readonly x: number; readonly y: number }[] =>
    points
      .map((point, i) => ({ i, value: point[key] }))
      .filter((entry): entry is { i: number; value: number } => entry.value !== undefined)
      .map(({ i, value }) => ({
        x: n <= 1 ? 0 : (i / (n - 1)) * width,
        y: max === min ? height / 2 : height - ((value - min) / (max - min)) * height,
      }));
  const asLine = (pts: readonly { readonly x: number; readonly y: number }[]) => pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  const swngPts = pointsFor("swngIndex");
  const whsPts = pointsFor("whsIndex");
  const swngLine = asLine(swngPts);
  const whsLine = asLine(whsPts);
  const latestSwng = [...points].reverse().find((point) => point.swngIndex !== undefined)?.swngIndex;
  const latestWhs = [...points].reverse().find((point) => point.whsIndex !== undefined)?.whsIndex;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-base font-semibold">Your index over time</h3>
        <span className="text-xs text-fairway/70">
          your last {n} round{n === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex items-center gap-3 text-xs text-fairway">
        <span>● swng</span>
        <span>○ WHS</span>
      </div>
      <svg
        data-testid="index-chart"
        role="img"
        aria-label="Your index over time"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className={cardBox}
      >
        {swngLine && (
          <polyline data-testid="index-line-swng" aria-label="swng index" points={swngLine} fill="none" stroke="currentColor" strokeWidth={2} className="text-forest" />
        )}
        {whsLine && (
          <polyline
            data-testid="index-line-whs"
            aria-label="WHS index"
            points={whsLine}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeDasharray="3 3"
            className="text-fairway"
          />
        )}
        {/* Per-round markers (● swng filled, ○ WHS hollow) so a single-vertex series stays visible:
            a lone point — e.g. one rated round among unrated play — draws no line, but its dot shows. */}
        {swngPts.map((p, i) => (
          <circle key={`s${i}`} data-testid="index-dot-swng" cx={p.x} cy={p.y} r={2.5} fill="currentColor" className="text-forest" />
        ))}
        {whsPts.map((p, i) => (
          <circle key={`w${i}`} data-testid="index-dot-whs" cx={p.x} cy={p.y} r={2.5} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-fairway" />
        ))}
      </svg>
      <p className="text-sm text-fairway">
        swng {latestSwng !== undefined ? formatHandicapIndex(latestSwng) : "—"} · WHS {latestWhs !== undefined ? formatHandicapIndex(latestWhs) : "—"}
      </p>
    </div>
  );
}

// Local presentation-only helpers for the record section below — arithmetic view logic over
// numbers the wire already computed (ags − par; a literal join of already-summed typicalEighteen
// buckets), never golf rules, so no `@swng/domain` compute import is warranted (the ESLint
// compute fence stays clean).
const vsPar = (ags: number, par: number): string => {
  const d = ags - par;
  return d === 0 ? "E" : d > 0 ? `+${d}` : `${d}`;
};

const ZERO_TYPICAL_EIGHTEEN: GetMyRecordResponse["metrics"]["typicalEighteen"] = { eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0 };

// "Your typical 18" (metrics.typicalEighteen — always present, zeroed rather than absent below
// any bootstrap): the career scoring shape normalized to one 18-hole round, so a golfer who
// mostly plays 9s isn't shown a deflated total.
const describeTypicalEighteen = (typical: GetMyRecordResponse["metrics"]["typicalEighteen"]): string => {
  const eaglePrefix = typical.eagles > 0 ? `${typical.eagles} eagle+ · ` : "";
  return `In a typical 18: ${eaglePrefix}${typical.birdies} birdies · ${typical.pars} pars · ${typical.bogeys} bogeys · ${typical.doublePlus} double+`;
};

// The two adoptable computed sources shown beneath "Your index" (index-source model spec §6) —
// each a labeled data point read straight off GET /me/record's metrics, with a one-tap "Use this"
// that COMMITS the golfer's index SOURCE (`{kind}`) in one PUT /me (index-source one-tap spec §2),
// NOT a value copied into a box: adopting swng/whs puts you ON that live source, so the number
// tracks and can never drift, and the tap itself saves (no staged selection, no separate Save, no
// revert). Table-driven so adding a source is adding a row, never a new branch; `valueOf` pulls the
// number (or undefined → renders "—", no button) and `useLabel` is the button's accessible name
// (both buttons share the visible "Use this" text, so distinct aria-labels keep them individually
// addressable). `description` is the model's own gloss: the swng index counts every round; the WHS
// index is the strict rated-only official number.
const INDEX_SOURCES: readonly { readonly kind: "swng" | "whs"; readonly label: string; readonly description: string; readonly useLabel: string; readonly valueOf: (record: GetMyRecordResponse | undefined) => number | undefined }[] = [
  { kind: "swng", label: "swng index", description: "from all your rounds", useLabel: "Use swng index", valueOf: (record) => record?.metrics?.swngIndex?.value },
  { kind: "whs", label: "WHS index", description: "rated rounds, official rules", useLabel: "Use WHS index", valueOf: (record) => record?.metrics?.whsIndex?.value },
];

// Name + home course (the Save button) plus the computed record (index, bootstrap explainer,
// index-over-time chart, typical 18, history) — the ProfilePage contract. The index a golfer is
// on is a source they choose (index-source model spec §3), resolved live; picking a source COMMITS it on the tap
// in its own PUT /me (index-source one-tap spec §2 — toggles commit, text fields Save), so the
// name/home Save no longer carries indexSource. Since the wall (accounts-only identity spec §2)
// GET /me get-or-creates the caller's golfer on first touch (ensureGolfer), this page always edits
// an EXISTING golfer — updateMe is an update, never the create path.
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
  // The override text buffer (not a staged source): editing it stages nothing; "Use this number"
  // commits it. Text-entry state only — the golfer's active index source is auth.golfer.indexSource,
  // the committed truth (index-source one-tap spec §2), never mirrored here.
  const [declaredDraft, setDeclaredDraft] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | undefined>(undefined);
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
    // Seed the override buffer once from the committed source (its declared value if the golfer is
    // on a declared source, else empty) — a text field's initial contents, not a staged source.
    const source = auth.golfer?.indexSource ?? { kind: "swng" as const };
    setDeclaredDraft(source.kind === "declared" ? String(source.value) : "");
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

  // The active source is the COMMITTED one — auth.golfer.indexSource — resolved live. No pending
  // copy: tapping a source SAVES it (commit, below), so there is nothing to stage or revert.
  const activeSource = auth.golfer?.indexSource ?? { kind: "swng" as const };
  const resolved = resolveIndex(activeSource, record?.metrics ?? {});

  // One tap commits (index-source one-tap spec §2): one PUT /me carrying just the picked source,
  // then apply the PUT's OWN response to auth in place — no GET /me refetch. auth.golfer is updated
  // only on success, so a failed commit leaves the prior source active (no optimism to roll back).
  const commit = async (source: IndexSource) => {
    setCommitting(true);
    setCommitError(undefined);
    try {
      const response = await withAuth((token) => updateMe(token, { indexSource: source }));
      auth.applyGolfer(response.golfer); // one request: the PUT's own response updates the client
      setDeclaredDraft(source.kind === "declared" ? String(source.value) : "");
    } catch {
      setCommitError("Couldn't save your index — try again."); // active source unchanged (applied only on success)
    } finally {
      setCommitting(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    setSaving(true);
    setSaved(false);
    setError(undefined);
    try {
      // Name + home only — the index source commits on its own tap now (index-source one-tap spec
      // §2), so it is NOT in this body. Apply the PUT's own response in place (one request per
      // action): no GET /me refetch, same as commit above.
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
        <p className="text-fairway">Sign in to see your profile and swng index.</p>
      </main>
    );
  }

  // "Your index" (index-source model spec §3/§6) — one active number, ALWAYS shown with its
  // source, resolved live above (`resolved`) from `activeSource` (the COMMITTED source) + the
  // metrics. A declared override reads "your own"; a whs source reads "your WHS index"; swng reads
  // "from all your rounds". There is no hidden precedence — whatever the committed source resolves
  // to is what's shown, and adopting a computed source tracks it because it's resolved, never copied.
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
              <span>{homeCourse.name}</span>
              <button type="button" onClick={() => setPickingCourse(true)} className="text-sm text-forest underline decoration-fairway">
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

        {/* Your index (index-source model spec §3/§6, one-tap-commit spec §2): ONE number the golfer
            owns, always on the screen with its source, resolved live from the COMMITTED source
            (activeSource) — never a value the system picks off-screen, never a copy that can drift.
            The active value + where it came from sits at the top; the two computed sources (swng by
            default, WHS as a reference) sit beneath with a one-tap "Use this" that COMMITS that
            source in one request and marks the active one "in use" — no staged selection, no separate
            Save, no revert; the override is the plain "type your own" input with its own "Use this
            number" commit. Deliberately NO divergence threshold, no "you should change this" prose, no
            auto-write — just the numbers, resolved fresh, and the golfer decides. */}
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Your index</h2>

          {resolved.value !== undefined ? (
            <p className="flex items-baseline gap-2">
              <span className="text-3xl font-bold">{formatHandicapIndex(resolved.value)}</span>
              {/* The source phrasing IS the legibility — the golfer always sees WHICH number they're
                  on: "your own" (declared), "your WHS index" (whs), or "from all your rounds" (swng). */}
              <span className="text-sm text-fairway">
                {resolved.kind === "declared" ? "your own" : resolved.kind === "whs" ? "your WHS index" : "from all your rounds"}
              </span>
            </p>
          ) : (
            // A computed source with no data yet resolves to undefined (first-class, not 0) — the
            // reason names the source the golfer is on so the "—" is legible, never a bare blank.
            <p className="text-sm text-fairway">
              {resolved.kind === "whs"
                ? "No WHS index yet — play a few rated rounds, or pick another source below."
                : "No index yet — play a few rounds and swng will compute one, or set your own below."}
            </p>
          )}

          {/* Each source row: "Use this" COMMITS that source in one tap (index-source one-tap spec
              §2) — no staged selection, no separate Save, no revert. The active row (activeSource,
              the committed truth) shows "in use" and no button. */}
          <div className="flex flex-col gap-2" aria-label="Index sources">
            {INDEX_SOURCES.map((source) => {
              const value = source.valueOf(record);
              const active = activeSource.kind === source.kind;
              return (
                <div key={source.label} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-fairway">
                    {source.label} · {value !== undefined ? formatHandicapIndex(value) : "—"}
                    <span className="block text-xs text-fairway/70">{source.description}</span>
                  </span>
                  {active ? (
                    <span className="shrink-0 text-xs text-forest">in use</span>
                  ) : (
                    value !== undefined && (
                      <button
                        type="button"
                        aria-label={source.useLabel}
                        disabled={committing}
                        onClick={() => void commit({ kind: source.kind })}
                        className="shrink-0 text-forest underline decoration-fairway disabled:opacity-50"
                      >
                        Use this
                      </button>
                    )
                  )}
                </div>
              );
            })}
          </div>

          {/* The override: a plain text buffer (declaredDraft) that stages nothing — "Use this
              number" is its own commit tap, consistent with the rows above. */}
          <label className="flex flex-col gap-1">
            Your own number
            <input value={declaredDraft} onChange={(event) => setDeclaredDraft(event.target.value)} inputMode="decimal" className={`${inputBox} text-lg`} />
          </label>
          {(() => {
            const parsed = declaredDraft.trim() === "" ? undefined : Number.parseFloat(declaredDraft.trim());
            const valid = parsed !== undefined && Number.isFinite(parsed);
            const declaredActive = activeSource.kind === "declared";
            return (
              <div className="flex items-center justify-between gap-2 text-sm">
                {declaredActive && <span className="text-xs text-forest">your own number — in use</span>}
                {valid && (
                  <button
                    type="button"
                    disabled={committing}
                    onClick={() => void commit({ kind: "declared", value: parsed })}
                    className="ml-auto shrink-0 text-forest underline decoration-fairway disabled:opacity-50"
                  >
                    Use this number
                  </button>
                )}
              </div>
            );
          })()}
          {commitError && (
            <p role="alert" className="text-sm text-oxblood">
              {commitError}
            </p>
          )}
        </section>

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

        <Link to="/crews/new" className="self-start text-forest underline decoration-fairway">
          New crew
        </Link>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Your record</h2>

        <IndexOverTime points={record?.metrics.indexHistory ?? []} roundsPlayed={record?.history.length ?? 0} />

        <p className="text-sm text-fairway tabular-nums">{describeTypicalEighteen(record?.metrics.typicalEighteen ?? ZERO_TYPICAL_EIGHTEEN)}</p>

        <div>
          <h3 className="text-base font-semibold">History</h3>
          {history.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {history.map((line) => (
                <li key={line.roundId}>
                  {/* Projection-realignment Task 6: every history line opens its own
                      ArchivedRoundPage — the "open one finalized round" half of this task,
                      reached from the "list my rounds" half already rendered here. Score-first
                      (metrics-projection-grows spec): the score leads, course/tee follow — a
                      golfer scans results, not metadata. `vsPar`/differential are presentation
                      only, no domain compute import. */}
                  <Link to={`/rounds/${line.roundId}/archive`} className={`${cardBox} block px-3 py-2 text-sm text-fairway underline decoration-fairway tabular-nums`}>
                    {line.courseName} · {line.tee}
                    {line.ags !== undefined && ` · ${line.ags} (${vsPar(line.ags, line.par)})`}
                    {line.holes === 9 && " · 9 holes"}
                    {line.differential !== undefined && ` · ${line.differential.toFixed(1)}`}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-fairway">No rounds yet.</p>
          )}
        </div>
      </section>
    </main>
  );
}
