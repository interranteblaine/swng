import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { applyStandingGame } from "@swng/domain";
import type { CourseId, CrewId, GolferId } from "@swng/domain";
import type { CourseView, CrewMemberView, GameConfigInput, StandingGameView, StartRoundRequest, StartRoundResponse } from "@swng/contracts";
import { addGame, ApiError, createRound, getCourse, updateMe } from "../api";
import { useAuth } from "../auth/useAuth";
import { CourseSearch } from "../courses/CourseSearch";
import { CourseSummaryCard } from "../courses/CourseSummaryCard";
import { describeStandingGame } from "../crews/standingGamePreview";
import { credentialStore } from "../identity";

// CrewPage's "Play the usual" hand-off (M8 Task 6): everything this page needs to pre-fill
// Saturday — the crew tag for the request, the full roster to seat, and the preset to seed
// course/tee/games from. Carried whole in router state (the EditCoursePage return precedent)
// so nothing has to be re-fetched before the one remaining tap.
interface CrewPresetState {
  readonly crewId: CrewId;
  readonly members: readonly CrewMemberView[];
  readonly standingGame: StandingGameView;
}

interface LocationState {
  // AddCoursePage's own success navigation (M6 Task 5's "Add a course" hand-off) — a course
  // just added should land here already selected, not force the golfer to search for the
  // thing they just typed in.
  readonly courseId?: CourseId;
  // EditCoursePage's own success hand-off (M7 Task 7, M-i): the refreshed CourseView, straight
  // off addTeeSet's own response — no re-fetch needed here, unlike AddCoursePage's courseId
  // hand-off above, because EditCoursePage already holds the full, current CourseView.
  readonly refreshedCourse?: CourseView;
  // CrewPage's "Play the usual" hand-off — see CrewPresetState above.
  readonly crewPreset?: CrewPresetState;
}

// One crew member's editable seat on the round being created — tee/courseHandicap are the raw
// input strings (parsed at submit, same treatment as the host's own courseHandicap field).
interface CrewPlayerRow {
  readonly golferId: GolferId;
  readonly name: string;
  readonly tee: string;
  readonly courseHandicap: string;
}

export function CreateRoundPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();
  // auth.golfer is three-state: undefined-while-signed-in is the GET /me loading window itself
  // (isIdentityLoading) — the free-text field must NEVER render there, because typing into it
  // and submitting would fire PUT /me with the typed text over a profile that may already be
  // real once the fetch lands (a silent rename). null is signed-in-with-no-profile-yet (free
  // text, same as signed out, until PUT /me mints one at submit time below). A real GolferView
  // is asSelf: the "Playing as <name>" line replaces the free-text field entirely.
  const isIdentityLoading = auth.signedIn && auth.golfer === undefined;
  const asSelf = auth.signedIn && Boolean(auth.golfer);

  const [courseView, setCourseView] = useState<CourseView | undefined>(undefined);
  const [tee, setTee] = useState<string>("");
  const [courseError, setCourseError] = useState<string | undefined>(undefined);
  const [name, setName] = useState("");
  const [courseHandicap, setCourseHandicap] = useState("0");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // The crew prefill (all empty/undefined outside the play-the-usual flow): crewId tags the
  // request; crewRows is the editable roster selection (ALL members, self included — the self
  // row renders as the "Playing as" block's twin below and can't be removed); presetGames is
  // the preset's game list, filtered against the CURRENT selection at render time.
  const [crewId, setCrewId] = useState<CrewId | undefined>(undefined);
  const [crewMembers, setCrewMembers] = useState<readonly CrewMemberView[]>([]);
  const [crewRows, setCrewRows] = useState<readonly CrewPlayerRow[]>([]);
  const [presetGames, setPresetGames] = useState<readonly GameConfigInput[]>([]);

  // `preferredTee` (the standing game's own) wins when it names a tee on the fetched card —
  // otherwise the first tee, exactly as before this parameter existed.
  const selectCourse = (courseId: CourseId, preferredTee?: string) => {
    setCourseError(undefined);
    getCourse(courseId)
      .then((response) => {
        setCourseView(response.course);
        // Tee always tracks the newly chosen card's own tee sets, never a stale name from a
        // previously selected course.
        const teeSets = response.course.card.teeSets;
        setTee(preferredTee && teeSets.some((t) => t.name === preferredTee) ? preferredTee : (teeSets[0]?.name ?? ""));
      })
      .catch((caught: unknown) => {
        setCourseView(undefined);
        setCourseError(caught instanceof ApiError ? caught.message : "Could not load that course — try again.");
      });
  };

  // M-i: the ONE place this page's held courseView gets replaced by a revision it didn't
  // itself fetch — CourseSummaryCard's own verify-409 re-fetch calls this directly (wired via
  // the onCourseRefreshed prop below); the edit-flow's return hand-off (the effect below)
  // calls it too. Both existed before Task 7 closed this gap: only the verify-409 site kept
  // CourseSummaryCard's OWN local state current, never this page's — a mid-setup revision
  // race could freeze the stale (internally consistent) card (papercuts.md #3's "M-i").
  // `tee` tracks along: a revision keeps its tee NAME unchanged (course.ts's addTeeSet — same
  // name is what makes it a revision), so the current selection survives if it still names a
  // tee on the refreshed card; only a first-arrival (the edit-flow's `refreshedCourse` landing
  // before any tee was ever selected) falls back to the card's first tee, same as selectCourse.
  const handleCourseRefreshed = (refreshed: CourseView) => {
    setCourseView(refreshed);
    setTee((current) => (refreshed.card.teeSets.some((t) => t.name === current) ? current : (refreshed.card.teeSets[0]?.name ?? "")));
  };

  // Fires once per navigation INTO this page (location.key is a fresh id react-router mints
  // per history entry) — not on every render, and not keyed off `location.state` itself
  // (a plain object literal from AddCoursePage's navigate() call would otherwise be a "new"
  // dependency on every render and re-fetch forever).
  useEffect(() => {
    const state = location.state as LocationState | null;
    // CrewPage's "Play the usual" hand-off: seat the whole crew (self included — the submit
    // path splits self out as the host), seed the preset's games, and pull the preset's own
    // course/tee. Player tees prefill from the preset (free text if it has none — resolution 1);
    // course handicaps prefill 0, all editable below.
    if (state?.crewPreset) {
      const preset = state.crewPreset;
      setCrewId(preset.crewId);
      setCrewMembers(preset.members);
      setCrewRows(preset.members.map((member) => ({ golferId: member.golferId, name: member.name, tee: preset.standingGame.tee ?? "", courseHandicap: "0" })));
      setPresetGames(preset.standingGame.games);
      if (preset.standingGame.courseId) selectCourse(preset.standingGame.courseId, preset.standingGame.tee);
      return;
    }
    // EditCoursePage's own hand-off (M-i, the edit flow's onCourseRefreshed call site) takes
    // priority: it already carries the full, current CourseView, so there's nothing to fetch.
    if (state?.refreshedCourse) {
      handleCourseRefreshed(state.refreshedCourse);
      return;
    }
    if (state?.courseId) selectCourse(state.courseId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above: keyed by the router's own per-navigation identity, not by `state`'s object identity
  }, [location.key]);

  const selfGolferId = auth.golfer?.golferId;
  const otherRows = crewRows.filter((row) => row.golferId !== selfGolferId);

  // The domain export is the ONE implementation of the survival rule (a game survives iff
  // EVERY golferId it references is present, preset order kept) — recomputed against the
  // CURRENT roster selection on every render, so removing a player reactively drops the games
  // that referenced them. The identity round-trip below (Set.has over the returned references)
  // recovers the wire GameConfigInput type without re-implementing the filter or rebuilding
  // configs per kind: applyStandingGame returns the very same objects it was given.
  const presentGolferIds = new Set<GolferId>(crewRows.map((row) => row.golferId));
  const survivingSet = new Set<unknown>(applyStandingGame({ games: presetGames }, presentGolferIds));
  const survivingGames: readonly GameConfigInput[] = presetGames.filter((game) => survivingSet.has(game));

  const crewNameFor = (golferId: GolferId): string => crewMembers.find((member) => member.golferId === golferId)?.name ?? golferId;

  const updateCrewRow = (golferId: GolferId, patch: Partial<Pick<CrewPlayerRow, "tee" | "courseHandicap">>) => {
    setCrewRows((rows) => rows.map((row) => (row.golferId === golferId ? { ...row, ...patch } : row)));
  };

  const removeCrewPlayer = (golferId: GolferId) => {
    setCrewRows((rows) => rows.filter((row) => row.golferId !== golferId));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedHandicap = Number.parseInt(courseHandicap, 10);
    // Playing as yourself always has a name (auth.golfer.name) — only the free-text path needs
    // one typed. Everything else (course/tee/handicap) is required either way. isIdentityLoading
    // blocks submission outright — the button is already disabled during this window, but this
    // guard covers any other way the form could submit (e.g. Enter in a text field).
    if (!courseView || !tee || !Number.isInteger(parsedHandicap) || isIdentityLoading || (!asSelf && !name.trim())) return;

    // The crew rows (play-the-usual): every OTHER member rides StartRound's players[] with
    // their stable golferId — same per-row requirements as the host's own fields (a blank tee
    // or non-integer handicap holds the tap, exactly like the host guard above).
    const players = otherRows.map((row) => ({
      name: row.name,
      tee: row.tee.trim(),
      courseHandicap: Number.parseInt(row.courseHandicap, 10),
      golferId: row.golferId,
    }));
    if (players.some((player) => !player.tee || !Number.isInteger(player.courseHandicap))) return;
    const crewFields: Pick<StartRoundRequest, "crewId" | "players"> = {
      ...(crewId !== undefined ? { crewId } : {}),
      ...(players.length > 0 ? { players } : {}),
    };

    setSubmitting(true);
    setError(undefined);
    try {
      // courseView.card VERBATIM — exactly the fetched CourseCard, not reconstructed —
      // because a round freezes this whole snapshot (brief: "the freeze source swap is THE
      // change").
      let response: StartRoundResponse;
      let savedName: string;
      if (asSelf) {
        // Playing as an existing account golfer: golferId + Bearer ride along, host.name is
        // the account's own name (never a stale local `name` field — there isn't one to go
        // stale, the input was replaced).
        const golfer = auth.golfer!;
        savedName = golfer.name;
        response = await auth.withAuth((token) =>
          createRound({ card: courseView.card, host: { name: golfer.name, tee, courseHandicap: parsedHandicap }, golferId: golfer.golferId, ...crewFields }, token),
        );
      } else if (auth.signedIn) {
        // Signed in with NO golfer yet: the typed name first creates the account's golfer (PUT
        // /me), THEN the round is created as-self with the golferId that mints — strictly in
        // this order (assert-call-order is part of this milestone's own headline behavior:
        // "zero claiming" only holds if the round is created AS the right golfer from the
        // start).
        const trimmed = name.trim();
        savedName = trimmed;
        response = await auth.withAuth(async (token) => {
          const created = await updateMe(token, { name: trimmed });
          return createRound({ card: courseView.card, host: { name: trimmed, tee, courseHandicap: parsedHandicap }, golferId: created.golfer.golferId, ...crewFields }, token);
        });
      } else {
        // Signed out: byte-identical to before this milestone — no golferId, no Bearer (and
        // outside the crew flow crewFields is empty, so this stays byte-identical there too).
        const trimmed = name.trim();
        savedName = trimmed;
        response = await createRound({ card: courseView.card, host: { name: trimmed, tee, courseHandicap: parsedHandicap }, ...crewFields });
      }
      credentialStore.save(response.roundId, { token: response.token, golferId: response.golferId, name: savedName, joinCode: response.joinCode });

      // "Games arrive without retyping" (resolution 2): StartRound carries no games field on
      // the wire, and addGame is the ONE way games enter a round — so the preset's surviving
      // games are seeded right here, with the create response's own participant token, before
      // navigating. Per-game failures are tolerated deliberately: the round already EXISTS, so
      // stranding the golfer on this page (where a re-submit would mint a SECOND round) is
      // strictly worse than landing in the round with a game missing — SetupPanel can re-add it.
      for (const game of survivingGames) {
        try {
          await addGame(response.roundId, response.token, game);
        } catch {
          // re-addable in SetupPanel — see the loop's own comment
        }
      }

      navigate(`/round/${response.roundId}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not create the round — try again.");
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-slate-950 p-6 text-slate-100">
      <h1 className="text-2xl font-bold">Start a round</h1>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {courseView ? (
          <CourseSummaryCard
            course={courseView}
            selectedTee={tee}
            onSelectTee={setTee}
            onChangeCourse={() => setCourseView(undefined)}
            onCourseRefreshed={handleCourseRefreshed}
          />
        ) : (
          <CourseSearch onSelect={(courseId) => selectCourse(courseId)} />
        )}
        {courseError && (
          <p role="alert" className="text-red-400">
            {courseError}
          </p>
        )}

        {isIdentityLoading ? (
          // A quiet placeholder, not the free-text field — see isIdentityLoading's own comment
          // above for why the input must not appear here. Deliberately NOT "Playing as" (that
          // label is reserved for the asSelf branch below, once a real name is known).
          <div role="status" aria-label="Loading your profile" className="flex flex-col gap-1">
            <div className="rounded-lg bg-slate-800 p-3 text-lg text-slate-500">Loading your profile…</div>
          </div>
        ) : asSelf ? (
          <div className="flex flex-col gap-1">
            <span className="text-sm text-slate-400">Playing as</span>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-800 p-3 text-lg">
              <span>{auth.golfer!.name}</span>
              <Link to="/profile" className="text-sm text-emerald-400 underline">
                Change
              </Link>
            </div>
          </div>
        ) : (
          <label className="flex flex-col gap-1">
            Your name
            <input value={name} onChange={(event) => setName(event.target.value)} className="rounded-lg bg-slate-800 p-3 text-lg" />
          </label>
        )}

        <label className="flex flex-col gap-1">
          Course handicap
          <input
            type="number"
            step={1}
            value={courseHandicap}
            onChange={(event) => setCourseHandicap(event.target.value)}
            className="rounded-lg bg-slate-800 p-3 text-lg"
          />
        </label>

        {crewId && (
          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">Players</h2>
            <ul className="flex flex-col gap-2">
              {crewRows.map((row) =>
                row.golferId === selfGolferId ? (
                  // The host — already covered by "Playing as" + the tee/handicap fields above;
                  // duplicating editable fields here would leave two competing controls.
                  <li key={row.golferId} className="rounded-lg bg-slate-900 p-3 text-slate-400">
                    {row.name} — you (details above)
                  </li>
                ) : (
                  <li key={row.golferId} className="flex flex-col gap-2 rounded-lg bg-slate-900 p-3">
                    <span className="flex items-center justify-between gap-2">
                      <span>{row.name}</span>
                      <button type="button" aria-label={`Remove ${row.name}`} onClick={() => removeCrewPlayer(row.golferId)} className="text-sm text-red-400 underline">
                        Remove
                      </button>
                    </span>
                    <span className="flex gap-2">
                      <label className="flex flex-1 flex-col gap-1 text-sm text-slate-400">
                        Tee
                        <input
                          aria-label={`Tee for ${row.name}`}
                          value={row.tee}
                          onChange={(event) => updateCrewRow(row.golferId, { tee: event.target.value })}
                          className="rounded-lg bg-slate-800 p-2 text-base text-slate-100"
                        />
                      </label>
                      <label className="flex w-28 flex-col gap-1 text-sm text-slate-400">
                        Course handicap
                        <input
                          aria-label={`Course handicap for ${row.name}`}
                          type="number"
                          step={1}
                          value={row.courseHandicap}
                          onChange={(event) => updateCrewRow(row.golferId, { courseHandicap: event.target.value })}
                          className="rounded-lg bg-slate-800 p-2 text-base text-slate-100"
                        />
                      </label>
                    </span>
                  </li>
                ),
              )}
            </ul>

            <h2 className="text-lg font-semibold">Games</h2>
            {survivingGames.length > 0 ? (
              <ul className="flex flex-col gap-1 text-sm text-slate-300">
                {survivingGames.map((game, index) => (
                  <li key={index}>{describeStandingGame(game, crewNameFor)}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-400">No games from the standing game — add games once the round starts.</p>
            )}
            {presetGames.length > survivingGames.length && (
              // The domain's own drop rule, said plainly (crew.ts's applyStandingGame): a game
              // missing any of its players is left out whole, never renumbered onto whoever's left.
              <p className="text-xs text-slate-500">Games that reference someone who isn&apos;t playing are left out.</p>
            )}
          </section>
        )}

        {error && (
          <p role="alert" className="text-red-400">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || !courseView || isIdentityLoading}
          className="rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold disabled:opacity-50"
        >
          Create round
        </button>
      </form>
    </main>
  );
}
