import { useEffect, useRef, useState } from "react";
import type { GolferId, Participant } from "@swng/domain";
import type { RejectedOp } from "@swng/client";

export interface StatusChromeProps {
  readonly connected: boolean;
  readonly pending: number;
  // rejected() is IN-MEMORY ONLY (M4 handoff note in useRoundSession.ts / session.ts) — a
  // permanently-rejected op is forgotten on reload. Persisting this list across restarts is
  // deliberately deferred to M9; this component just renders whatever the session currently
  // holds.
  readonly rejected: readonly RejectedOp[];
  readonly participants: readonly Participant[];
  // Re-triggers the session's connect()+sync() (session/useRoundSession.ts's own doc comment:
  // the client SDK has no reconnect timer — a caller that wants to reconnect calls connect()
  // again). This button is the only user-visible way to resume after coming back online; it
  // lives beside the offline banner it's paired with, not as a separate always-there control.
  readonly onReconnect: () => void;
}

const nameFor = (participants: readonly Participant[], golfer: GolferId): string => participants.find((p) => p.golferId === golfer)?.name ?? golfer;

// One line describing a rejected op for the persistent row below — score-recorded is the only
// kind recordScore ever produces, but `event` is typed as the full RoundEvent union (it's
// literally the op the server rejected), so this stays exhaustive rather than assuming.
const describeRejection = (participants: readonly Participant[], rejected: RejectedOp): string => {
  const { event } = rejected;
  if (event.kind === "score-recorded") return `${nameFor(participants, event.golferId)}, hole ${event.hole}`;
  return event.kind;
};

// Connectivity + queue chrome around the scorecard (brief): a calm offline banner (the queue
// IS the feature, not an error state), a pending badge that drains as the outbox does, and
// rejected ops surfaced twice — a dismissible toast (so it doesn't nag forever) plus a
// persistent row per op (so a rejection is never silently lost while it's still in memory).
export function StatusChrome({ connected, pending, rejected, participants, onReconnect }: StatusChromeProps) {
  const [toastDismissed, setToastDismissed] = useState(false);
  const seenCountRef = useRef(rejected.length);

  // A NEW rejection (count grew since last render) re-opens the toast even if a previous one
  // was dismissed — dismissal only ever applies to what was visible at the time.
  useEffect(() => {
    if (rejected.length > seenCountRef.current) setToastDismissed(false);
    seenCountRef.current = rejected.length;
  }, [rejected.length]);

  return (
    <div className="flex flex-col gap-2 p-3 text-slate-100">
      {!connected && (
        <div role="status" className="flex items-center justify-between gap-2 rounded-md bg-amber-950 px-3 py-2 text-sm text-amber-200">
          <p>Offline — scores queue and sync when signal returns.</p>
          <button type="button" onClick={onReconnect} className="min-h-8 shrink-0 rounded-md bg-amber-900 px-2 text-xs font-medium">
            Sync now
          </button>
        </div>
      )}

      {pending > 0 && (
        <p className="text-xs text-slate-400">
          {pending} score{pending === 1 ? "" : "s"} syncing…
        </p>
      )}

      {rejected.length > 0 && !toastDismissed && (
        <div role="alert" className="flex items-center justify-between gap-2 rounded-md bg-red-950 px-3 py-2 text-sm text-red-200">
          <span>
            {rejected.length} score{rejected.length === 1 ? "" : "s"} couldn&apos;t be saved.
          </span>
          <button type="button" onClick={() => setToastDismissed(true)} className="min-h-8 rounded-md bg-red-900 px-2 text-xs font-medium">
            Dismiss
          </button>
        </div>
      )}

      {rejected.length > 0 && (
        <ul className="flex flex-col gap-1">
          {rejected.map((r) => (
            <li key={r.event.opId} className="text-xs text-red-300">
              {describeRejection(participants, r)} — {r.code}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
