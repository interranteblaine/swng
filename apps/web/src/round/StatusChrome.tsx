import { useEffect, useRef, useState } from "react";
import type { GolferId, Participant } from "@swng/domain";
import type { RejectedOp } from "@swng/client";

export interface StatusChromeProps {
  // NOT the socket. The socket closes on a perfectly good connection — API Gateway caps
  // connection duration well below the length of a round, and phones lock and background — so
  // "Offline" was a claim about our own plumbing that a golfer with full bars could read as a
  // claim about theirs. `stalled` says the only thing worth saying: we are still trying, and it
  // is still not working.
  readonly stalled: boolean;
  readonly pending: number;
  // rejected() is IN-MEMORY ONLY (M4 handoff note in useRoundSession.ts / session.ts) — a
  // permanently-rejected op is forgotten on reload. Persisting this list across restarts is
  // deliberately deferred to M9; this component just renders whatever the session currently
  // holds.
  readonly rejected: readonly RejectedOp[];
  readonly participants: readonly Participant[];
  // Re-triggers the session's connect()+sync() (session/useRoundSession.ts's own doc comment:
  // the client SDK has no reconnect timer — a caller that wants to reconnect calls connect()
  // again). The outbox drains itself on its own backoff loop now — this is no longer the only
  // way to resume, just a backstop: it appears only inside the escalated (`stalled`) state, for
  // a golfer who wants to give the queue a manual nudge rather than wait out the backoff.
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

// Queue chrome around the scorecard (brief): the subject is the outbox, not the socket — a
// quiet syncing line while it drains (the queue IS the feature, not an error state), an
// escalated banner only once the backoff loop is `stalled` (with a manual "Try now" backstop),
// and rejected ops surfaced twice — a dismissible toast (so it doesn't nag forever) plus a
// persistent row per op (so a rejection is never silently lost while it's still in memory).
export function StatusChrome({ stalled, pending, rejected, participants, onReconnect }: StatusChromeProps) {
  const [toastDismissed, setToastDismissed] = useState(false);
  const seenCountRef = useRef(rejected.length);

  // A NEW rejection (count grew since last render) re-opens the toast even if a previous one
  // was dismissed — dismissal only ever applies to what was visible at the time.
  useEffect(() => {
    if (rejected.length > seenCountRef.current) setToastDismissed(false);
    seenCountRef.current = rejected.length;
  }, [rejected.length]);

  return (
    <div className="flex flex-col gap-2 p-3">
      {stalled ? (
        <div role="status" className="flex items-center justify-between gap-2 border border-gold bg-goldwash px-3 py-2 text-sm text-forest">
          <p>Can&apos;t reach swng — your scores are safe here.</p>
          <button type="button" onClick={onReconnect} className="min-h-8 shrink-0 border border-forest px-2 text-xs font-medium text-forest">
            Try now
          </button>
        </div>
      ) : (
        pending > 0 && (
          <p role="status" className="text-xs text-fairway">
            {pending} score{pending === 1 ? "" : "s"} saved on this phone — syncing…
          </p>
        )
      )}

      {rejected.length > 0 && !toastDismissed && (
        <div role="alert" className="flex items-center justify-between gap-2 border border-oxblood bg-card px-3 py-2 text-sm text-oxblood">
          <span>
            {rejected.length} score{rejected.length === 1 ? "" : "s"} couldn&apos;t be saved.
          </span>
          <button type="button" onClick={() => setToastDismissed(true)} className="min-h-8 border border-oxblood px-2 text-xs font-medium text-oxblood">
            Dismiss
          </button>
        </div>
      )}

      {rejected.length > 0 && (
        <ul className="flex flex-col gap-1">
          {rejected.map((r) => (
            <li key={r.event.opId} className="text-xs text-oxblood">
              {describeRejection(participants, r)} — {r.code}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
