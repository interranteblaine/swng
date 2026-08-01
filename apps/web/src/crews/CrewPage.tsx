import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { crewId as makeCrewId } from "@swng/domain";
import type { GolferId } from "@swng/domain";
import type { CrewSeasonView, CrewView } from "@swng/contracts";
import { ApiError, createSeason, getCrew, leaveCrew, listSeasons, mintCrewInvite, removeCrewMember, transferOrganizer, updateCrew } from "../api";
import { useAuth } from "../auth/useAuth";
import { CopiedLinkLine } from "../ui/CopiedLinkLine";
import { GolferLink } from "../ui/GolferLink";
import { badge, btnDanger, btnDangerSolid, btnPrimary, btnQuiet, btnQuietDanger, btnSecondary, cardBox, inputBox } from "../ui/classes";
import { usePageTitle } from "../ui/usePageTitle";
import { SeasonPanel } from "./SeasonPanel";

// A crew load can fail two honest ways the wire names (errorMapping.ts) — both get human
// copy, never the raw server text (the M7 discipline: raw messages carry internal ids). This is
// about the CALLER's own membership — a distinct surface from humanizeMemberActionError below,
// which is about a named TARGET (the reviewer forward-flag, task-C-T3-brief.md): an organizer
// acting on a member who vanished in a race is still a member themselves, so they must never see
// this "you're not a member" copy for their own action's failure.
const humanizeCrewLoadError = (caught: unknown): string => {
  if (caught instanceof ApiError && caught.code === "not-a-member") return "You're not a member of this crew.";
  if (caught instanceof ApiError && caught.code === "unknown-crew") return "This crew doesn't exist — check the link.";
  return "Could not load this crew — try again.";
};

// createSeason's own inline 1-60 bound (application/src/crews/createSeason.ts) — the ONE
// documented failure code it can throw beyond the shared member-gate 403/404s. Never the raw
// server text (M9 papercut discipline): the raw message echoes the caller's own typed name
// back in server vocabulary, not something a golfer acts on.
const humanizeCreateSeasonError = (caught: unknown): string => {
  if (caught instanceof ApiError && caught.code === "invalid-season-name") return "Season name must be 1–60 characters.";
  return "Could not create the season — try again.";
};

// Crew membership (invited in, accountable out — spec §1): the organizer cannot leave —
// organizer-must-transfer names the way out (leaveCrew.ts's own doc comment), so this copy does
// too, rather than a dead-end "try again". The button itself is hidden for the organizer below
// (confirmLeave never fires for them in the normal case); this arm is defensive-only, for a role
// that changed underneath a stale render.
const humanizeLeaveError = (caught: unknown): string => {
  if (caught instanceof ApiError && caught.code === "unknown-crew") return "This crew doesn't exist — check the link.";
  if (caught instanceof ApiError && caught.code === "organizer-must-transfer") {
    return "You're the organizer — make someone else the organizer first, then you can leave.";
  }
  return "Could not leave the crew — try again.";
};

// Spec 2026-07-22 "the season is the record" §2: the crew name is editable — organizer-only,
// mirroring humanizeCreateSeasonError's own "one documented failure code, plus the shared
// member-gate 403/404s" shape.
const humanizeUpdateCrewNameError = (caught: unknown): string => {
  if (caught instanceof ApiError && caught.code === "invalid-crew-name") return "Crew name must be 1–60 characters.";
  if (caught instanceof ApiError && caught.code === "not-organizer") return "You're no longer the organizer — reload the page to see who is.";
  if (caught instanceof ApiError && caught.code === "unknown-crew") return "This crew doesn't exist — check the link.";
  return "Could not rename the crew — try again.";
};

// Crew membership (invited in, accountable out — spec §2): mint failures are about the CALLER's
// own membership (any member may invite — mintCrewInvite.ts), so this reuses the SAME
// "not-a-member" copy humanizeCrewLoadError uses — no forward-flag risk here, unlike remove/
// transfer below, since there is no separate "target" this call could name.
const humanizeInviteError = (caught: unknown): string => {
  if (caught instanceof ApiError && caught.code === "not-a-member") return "You're not a member of this crew.";
  if (caught instanceof ApiError && caught.code === "unknown-crew") return "This crew doesn't exist — check the link.";
  return "Could not create an invite link — try again.";
};

// Crew membership (invited in, accountable out — spec §1): remove/transfer's own error surface —
// DELIBERATELY separate from humanizeCrewLoadError above (the reviewer forward-flag,
// task-C-T3-brief.md). Both actions are organizer-gated by requireCrewMember FIRST (the caller
// IS a member, or they'd never see these buttons render), so a "not-a-member" here can only ever
// name the TARGET — removeMember/transferOrganizer's own "golferId isn't on this roster" guard
// (domain/crew/crew.ts), most likely a race where the target left between page-load and this
// click. "You're not a member of this crew" would misaddress the organizer, who plainly is one —
// this copy names the target's own vanished standing instead. not-organizer covers the caller's
// role itself changing underneath them (e.g. a transfer from another tab).
const humanizeMemberActionError = (caught: unknown, verb: "remove that member" | "make them organizer"): string => {
  if (caught instanceof ApiError && caught.code === "not-a-member") return "That member isn't in this crew anymore.";
  if (caught instanceof ApiError && caught.code === "not-organizer") return "You're no longer the organizer — reload the page to see who is.";
  if (caught instanceof ApiError && caught.code === "unknown-crew") return "This crew doesn't exist — check the link.";
  return `Could not ${verb} — try again.`;
};

// Spec 2026-07-22 "the season is the record" §2: the create-season form's own default — name =
// the current UTC calendar year, dates = Jan 1 – Dec 31 of it, the SAME window createCrew's own
// auto-season opens with server-side.
const yearDefaults = (): { readonly name: string; readonly startsAt: string; readonly endsAt: string } => {
  const year = new Date().getUTCFullYear();
  return { name: String(year), startsAt: `${year}-01-01`, endsAt: `${year}-12-31` };
};

// The confirm/cancel target for a per-row organizer action (Remove… / Make organizer…) — at
// most one row's confirm dialog is open at a time, mirroring confirmingLeave's own single-flag
// idiom below, generalized to name WHICH member and WHICH action.
interface MemberAction {
  readonly type: "remove" | "transfer";
  readonly golferId: GolferId;
  readonly name: string;
}

export function CrewPage() {
  const { crewId: crewIdParam } = useParams<{ crewId: string }>();
  if (!crewIdParam) return <Navigate to="/" replace />; // unreachable given the route pattern; keeps TS/runtime honest (EditCoursePage's idiom)

  return <CrewPageForId crewIdParam={crewIdParam} />;
}

function CrewPageForId({ crewIdParam }: { readonly crewIdParam: string }) {
  const id = makeCrewId(crewIdParam);
  const navigate = useNavigate();
  const auth = useAuth();
  // Stable function reference for the fetch effect (ProfilePage's own destructuring precedent).
  const { withAuth, signedIn } = auth;

  const [crew, setCrew] = useState<CrewView | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  // Re-runs once the crew loads (usePageTitle's own title-prop-change contract) — "swng" while
  // loading, then the crew's own name.
  usePageTitle(crew?.name);

  // Architecture-realignment Task 11: seasons + counted rounds + standings-on-read replace the
  // old crew projection layer's "Season records" section entirely (Task 9's backend, this
  // task's web). `seasons` undefined = still loading; `seasonsError` = tried and failed —
  // same three-state split CrewPage already used for the deleted records section (papercut 12).
  const [seasons, setSeasons] = useState<readonly CrewSeasonView[] | undefined>(undefined);
  const [seasonsError, setSeasonsError] = useState(false);
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | undefined>(undefined);
  // Spec 2026-07-22 "the season is the record" §2: dates are CHOSEN, VISIBLE, and REQUIRED —
  // the form comes prefilled with the common case (name = the current year, dates = Jan 1 –
  // Dec 31 of it), same defaults createCrew's own auto-season opens with, so "2027" is one tap.
  const [newSeasonName, setNewSeasonName] = useState(() => yearDefaults().name);
  const [newSeasonStartsAt, setNewSeasonStartsAt] = useState(() => yearDefaults().startsAt);
  const [newSeasonEndsAt, setNewSeasonEndsAt] = useState(() => yearDefaults().endsAt);
  const [creatingSeason, setCreatingSeason] = useState(false);
  const [createSeasonError, setCreateSeasonError] = useState<string | undefined>(undefined);

  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | undefined>(undefined);

  // Spec 2026-07-22 §2: the crew name is editable — organizer-only, the roster-row edit idiom
  // (SetupPanel.tsx's own strokes editor: an Edit swaps the static text for an
  // input + Save/Cancel, one PUT then the response replaces local state).
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>(undefined);

  // Crew membership (invited in, accountable out — spec §2): the code panel is gone — an Invite
  // button mints a fresh 7-day link and copies it, same busy/copied/fallback-url shape as
  // ShareButton.tsx's own round-share idiom.
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | undefined>(undefined);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [inviteError, setInviteError] = useState<string | undefined>(undefined);

  // Crew membership (invited in, accountable out — spec §1): the organizer's per-row Remove…/
  // Make organizer… affordances — one shared confirm/busy/error triple, since only one row's
  // dialog is ever open at a time (memberAction names which).
  const [memberAction, setMemberAction] = useState<MemberAction | undefined>(undefined);
  const [memberActionBusy, setMemberActionBusy] = useState(false);
  const [memberActionError, setMemberActionError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!signedIn) return;
    void withAuth((token) => getCrew(token, id))
      .then((response) => setCrew(response.crew))
      .catch((caught: unknown) => setLoadError(humanizeCrewLoadError(caught)));
    // Seasons are member-gated the SAME way (crews/membership.ts) but rendered as their own
    // section below — a failed fetch degrades that section quietly, same spirit as the deleted
    // records section's own papercut-12 fix, never compounding onto loadError (roster/invite
    // stay usable either way).
    void withAuth((token) => listSeasons(token, id))
      .then((response) => {
        setSeasons(response.seasons);
        setSeasonsError(false);
      })
      .catch(() => setSeasonsError(true));
  }, [signedIn, withAuth, id]);

  if (!signedIn) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 bg-cream p-6">
        <h1 className="text-2xl font-bold text-forest">Crew</h1>
        <p className="text-fairway">Sign in to see your crew.</p>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 bg-cream p-6">
        <h1 className="text-2xl font-bold text-forest">Crew</h1>
        <p role="alert" className="text-oxblood">
          {loadError}
        </p>
      </main>
    );
  }

  if (!crew) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 bg-cream p-6">
        <h1 className="text-2xl font-bold text-forest">Crew</h1>
        <p className="text-forest">Loading…</p>
      </main>
    );
  }

  const submitNewSeason = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = newSeasonName.trim();
    // Both dates are required — no clearable/optional bound (spec §1's owner ruling). The
    // `type="date"` inputs below carry `required` too, but a fresh-state guard here keeps the
    // submit handler honest regardless of what the browser enforces.
    if (!trimmed || !newSeasonStartsAt || !newSeasonEndsAt || creatingSeason) return;

    setCreatingSeason(true);
    setCreateSeasonError(undefined);
    try {
      const response = await withAuth((token) => createSeason(token, id, { name: trimmed, startsAt: newSeasonStartsAt, endsAt: newSeasonEndsAt }));
      setSeasons((current) => [response.season, ...(current ?? [])]);
      const fresh = yearDefaults();
      setNewSeasonName(fresh.name);
      setNewSeasonStartsAt(fresh.startsAt);
      setNewSeasonEndsAt(fresh.endsAt);
      setSelectedSeasonId(response.season.seasonId); // straight into the season just created
    } catch (caught) {
      setCreateSeasonError(humanizeCreateSeasonError(caught));
    } finally {
      setCreatingSeason(false);
    }
  };

  const confirmLeave = async () => {
    setLeaving(true);
    setLeaveError(undefined);
    try {
      await withAuth((token) => leaveCrew(token, id));
      navigate("/");
    } catch (caught) {
      setLeaveError(humanizeLeaveError(caught));
      setLeaving(false);
    }
  };

  // Spec 2026-07-22 §2: the crew name is editable — organizer-only, one PUT then the response
  // replaces local state (no separate reload — same "produces the crew" shape removeCrewMember/
  // transferOrganizer already follow above).
  const startNameEdit = () => {
    setNameValue(crew.name);
    setNameError(undefined);
    setEditingName(true);
  };

  const cancelNameEdit = () => {
    setEditingName(false);
    setNameError(undefined);
  };

  const saveCrewName = async () => {
    const trimmed = nameValue.trim();
    if (!trimmed || nameSaving) return;
    setNameSaving(true);
    setNameError(undefined);
    try {
      const response = await withAuth((token) => updateCrew(token, id, { name: trimmed }));
      setCrew(response.crew);
      setEditingName(false);
    } catch (caught) {
      setNameError(humanizeUpdateCrewNameError(caught));
    } finally {
      setNameSaving(false);
    }
  };

  // Crew membership (invited in, accountable out — spec §2): mint, compose the join link from
  // THIS device's own origin (ShareButton.tsx's exact idiom — the server has no web-origin
  // config seam), copy it. Clipboard access can silently fail, so the raw URL is always shown
  // too (same "visible fallback" rule ShareButton.tsx documents).
  const mintInvite = async () => {
    setInviteBusy(true);
    setInviteError(undefined);
    try {
      const response = await withAuth((token) => mintCrewInvite(token, id));
      const url = `${window.location.origin}/crews/join#${response.token}`;
      setInviteUrl(url);
      setInviteCopied(false);
      try {
        await navigator.clipboard.writeText(url);
        setInviteCopied(true);
      } catch {
        // Clipboard permission denied/unavailable — the visible raw-url fallback below still
        // lets a golfer copy it by hand.
      }
    } catch (caught) {
      setInviteError(humanizeInviteError(caught));
    } finally {
      setInviteBusy(false);
    }
  };

  const confirmMemberAction = async () => {
    if (!memberAction) return;
    setMemberActionBusy(true);
    setMemberActionError(undefined);
    try {
      const response = await withAuth((token) =>
        memberAction.type === "remove" ? removeCrewMember(token, id, memberAction.golferId) : transferOrganizer(token, id, { golferId: memberAction.golferId }),
      );
      setCrew(response.crew);
      setMemberAction(undefined);
    } catch (caught) {
      setMemberActionError(humanizeMemberActionError(caught, memberAction.type === "remove" ? "remove that member" : "make them organizer"));
    } finally {
      setMemberActionBusy(false);
    }
  };

  // Crew membership (invited in, accountable out — spec §1): the viewer's own role — Remove…/
  // Make organizer… render ONLY for the organizer (non-organizers see neither, brief), and never
  // on the organizer's own roster row (nothing to remove/transfer-to-self).
  const myGolferId = auth.golfer?.golferId;
  const isOrganizer = crew.members.some((member) => member.golferId === myGolferId && member.role === "organizer");

  // Newest season createdAtMs first (task-11-brief.md: "NO order promised — sort client-side") —
  // the use case already sorts this way server-side (listSeasons.ts), but a freshly-created
  // season is prepended locally above, so this re-sort is what keeps a same-page create honest
  // too.
  const sortedSeasons = seasons ? [...seasons].sort((a, b) => b.createdAtMs - a.createdAtMs) : [];

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-8 bg-cream p-6">
      <div className="flex flex-col gap-2">
        {/* Spec 2026-07-22 §2: the crew name is editable — organizer-only, the roster-row edit
            idiom (SetupPanel.tsx's own strokes editor). */}
        {editingName ? (
          <span className="flex items-center gap-2">
            <input
              aria-label="Crew name"
              className={`${inputBox} text-2xl font-bold`}
              value={nameValue}
              maxLength={60}
              onChange={(event) => setNameValue(event.target.value)}
            />
            <button type="button" className={btnQuiet} disabled={nameSaving || !nameValue.trim()} onClick={() => void saveCrewName()}>
              Save
            </button>
            <button type="button" className={btnQuiet} disabled={nameSaving} onClick={cancelNameEdit}>
              Cancel
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-forest">{crew.name}</h1>
            {isOrganizer && (
              <button type="button" className={`${btnQuiet} text-sm`} onClick={startNameEdit}>
                Edit
              </button>
            )}
          </span>
        )}
        {nameError && (
          <p role="alert" className="text-oxblood">
            {nameError}
          </p>
        )}
      </div>

      {/* Crew membership (invited in, accountable out — spec §2): the permanent join code is
          gone — ANY member mints a fresh 7-day invite link (mirrors ShareButton.tsx's own
          mint/copy/visible-fallback idiom for the round-share link) as the one way in. Invite
          is this page's one primary action — the gold idiom. */}
      <div className={`${cardBox} p-4`}>
        <button type="button" onClick={() => void mintInvite()} disabled={inviteBusy} className={`${btnPrimary} w-full disabled:opacity-50`}>
          {inviteBusy ? "Getting link…" : "Invite"}
        </button>
        {inviteUrl && <CopiedLinkLine url={inviteUrl} copied={inviteCopied} note="good for 7 days" className="mt-2" />}
        {inviteError && (
          <p role="alert" className="mt-2 text-xs text-oxblood">
            {inviteError}
          </p>
        )}
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-forest">Roster</h2>
        <ul aria-label="Roster" className="flex flex-col gap-2">
          {crew.members.map((member) => (
            <li key={member.golferId} className={`${cardBox} flex flex-col gap-2 p-3`}>
              <div className="flex items-center gap-2 text-forest">
                <GolferLink golferId={member.golferId} name={member.name} />
                {member.role === "organizer" && <span className={badge}>organizer</span>}
              </div>

              {/* Crew membership (invited in, accountable out — spec §1): organizer-only, and
                  never on the organizer's own row (nothing to remove/transfer to self) — brief:
                  "Non-organizers see neither. The organizer's own row gets neither Remove nor a
                  way to leave without transfer." */}
              {isOrganizer && member.role !== "organizer" && (
                <div className="flex flex-col gap-2 text-sm">
                  {memberAction?.golferId === member.golferId ? (
                    <span
                      role="dialog"
                      aria-label={memberAction.type === "remove" ? `Confirm remove ${member.name}` : `Confirm make ${member.name} organizer`}
                      className="flex flex-col gap-2"
                    >
                      <span className="text-fairway">
                        {memberAction.type === "remove"
                          ? `Remove ${member.name} from the crew? Their rounds stay on their own record; their crew standings return if they're invited back.`
                          : `Make ${member.name} organizer? They'll be the only one who can remove members or transfer the role — you won't be able to anymore.`}
                      </span>
                      <span className="flex items-center gap-2">
                        <button type="button" onClick={() => void confirmMemberAction()} disabled={memberActionBusy} className={`${btnDangerSolid} disabled:opacity-50`}>
                          Confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            // A dismissed action's failure must not haunt the NEXT row's dialog
                            // (review minor, C-T3): the error belongs to the attempt, not the panel.
                            setMemberAction(undefined);
                            setMemberActionError(undefined);
                          }}
                          disabled={memberActionBusy}
                          className={`${btnSecondary} disabled:opacity-50`}
                        >
                          Cancel
                        </button>
                      </span>
                      {memberActionError && (
                        <p role="alert" className="text-oxblood">
                          {memberActionError}
                        </p>
                      )}
                    </span>
                  ) : (
                    <span className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          setMemberAction({ type: "remove", golferId: member.golferId, name: member.name });
                          setMemberActionError(undefined);
                        }}
                        className={btnQuietDanger}
                      >
                        Remove…
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setMemberAction({ type: "transfer", golferId: member.golferId, name: member.name });
                          setMemberActionError(undefined);
                        }}
                        className={btnQuiet}
                      >
                        Make organizer…
                      </button>
                    </span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* Architecture-realignment Task 11: seasons + counted rounds + standings-on-read replace
          the old "Season records" ledger table entirely — a season list here, SeasonPanel does
          the standings/head-to-head/counted-rounds/count-a-round work once one is picked. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-forest">Seasons</h2>

        {seasonsError ? (
          <p className="text-fairway">Could not load seasons right now.</p>
        ) : seasons !== undefined && sortedSeasons.length === 0 ? (
          <p className="text-fairway">No seasons yet — start one below.</p>
        ) : (
          <ul aria-label="Seasons" className="flex flex-col gap-2">
            {sortedSeasons.map((season) => (
              <li key={season.seasonId}>
                <button
                  type="button"
                  onClick={() => setSelectedSeasonId(season.seasonId)}
                  className={`w-full px-4 py-3 text-left ${selectedSeasonId === season.seasonId ? "bg-forest text-cream" : cardBox}`}
                >
                  {season.name}
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Spec 2026-07-22 "the season is the record" §2: dates are CHOSEN, VISIBLE, and
            REQUIRED — the form comes prefilled with the common case (name = the current year,
            dates = Jan 1 – Dec 31 of it), so "2027" is one tap; "Summer Cup, Jun 1 – Aug 31" is
            typed once and means what it says. Dates are editable, never clearable. */}
        <form onSubmit={(event) => void submitNewSeason(event)} className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-forest">
            New season
            <input value={newSeasonName} onChange={(event) => setNewSeasonName(event.target.value)} maxLength={60} className={`${inputBox} text-lg`} />
          </label>
          <span className="flex gap-2">
            <label className="flex flex-1 flex-col gap-1 text-forest">
              Starts
              <input
                type="date"
                aria-label="New season starts"
                value={newSeasonStartsAt}
                onChange={(event) => setNewSeasonStartsAt(event.target.value)}
                required
                className={inputBox}
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-forest">
              Ends
              <input
                type="date"
                aria-label="New season ends"
                value={newSeasonEndsAt}
                onChange={(event) => setNewSeasonEndsAt(event.target.value)}
                required
                className={inputBox}
              />
            </label>
          </span>
          <p className="text-xs text-fairway">Want an all-time board? Give it wide dates.</p>
          {createSeasonError && (
            <p role="alert" className="text-oxblood">
              {createSeasonError}
            </p>
          )}
          <button type="submit" disabled={creatingSeason} className={`${btnSecondary} self-start disabled:opacity-50`}>
            Create season
          </button>
        </form>

        {/* key={selectedSeasonId}: a fresh mount per season selection is the simplest correct
            reset — no seasonId-changed effect dance needed inside SeasonPanel itself. */}
        {selectedSeasonId && <SeasonPanel key={selectedSeasonId} crewId={id} seasonId={selectedSeasonId} isOrganizer={isOrganizer} />}
      </section>

      {/* Architecture-realignment Task 11: "Leave crew" — the caller's own membership only,
          with a confirm step (a click-to-reveal Confirm/Cancel idiom, not a native confirm() —
          consistent with the rest of the app's chrome). Crew membership (invited in,
          accountable out — spec §1): the organizer cannot leave without transferring the role
          first (leaveCrew.ts's organizer-must-transfer guard) — the affordance is hidden for
          them entirely rather than offering a button that's guaranteed to fail. */}
      <section className="flex flex-col gap-2">
        {isOrganizer ? (
          <p className="text-sm text-fairway/70">You're the organizer — make someone else the organizer to leave the crew.</p>
        ) : !confirmingLeave ? (
          <button type="button" onClick={() => setConfirmingLeave(true)} className={`${btnDanger} self-start`}>
            Leave crew
          </button>
        ) : (
          <span role="dialog" aria-label="Confirm leave" className="flex items-center gap-2 text-sm">
            <span className="text-fairway">Leave {crew.name}?</span>
            <button type="button" onClick={() => void confirmLeave()} disabled={leaving} className={`${btnDangerSolid} disabled:opacity-50`}>
              Confirm
            </button>
            <button type="button" onClick={() => setConfirmingLeave(false)} disabled={leaving} className={`${btnSecondary} disabled:opacity-50`}>
              Cancel
            </button>
          </span>
        )}
        {leaveError && (
          <p role="alert" className="text-oxblood">
            {leaveError}
          </p>
        )}
      </section>
    </main>
  );
}
