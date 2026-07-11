import { useEffect, useRef, useState } from "react";
import { createHttpTransport } from "@swng/client";
import type { RoundTransport } from "@swng/client";
import { reduceRound, scoreGame } from "@swng/domain";
import type { GameConfig, GameState, RoundEvent, RoundId, RoundState } from "@swng/domain";
import { config } from "../config";

// scoreGame throws on a kind it doesn't recognize (@swng/client's session.ts carries the same
// forward-compat guard, its own doc comment) — a round containing a future game kind must not
// crash a spectator's whole watch page, so unrecognized kinds are filtered out here rather than
// letting scoreGame throw. This is a small, deliberately local duplicate of session.ts's own
// KNOWN_GAME_KINDS_BY_KIND (not exported from @swng/client) — five literals, not worth a new
// cross-package export for.
const KNOWN_GAME_KINDS: ReadonlySet<GameConfig["kind"]> = new Set(["stroke-play", "singles-match", "stableford", "fourball-match", "skins"]);

export interface WatchRoundView {
  readonly hydrated: boolean;
  // Papercut 14 (M9 hardening): true once a pull has failed and this round has NEVER
  // successfully hydrated — the signal WatchPage needs to stop spinning "Loading round…"
  // forever on a mistyped/dead link (every pull 403s/404s/network-fails identically to a
  // transient blip at this layer, so "still loading" and "this link is broken" were
  // previously indistinguishable). Cleared the instant a LATER pull succeeds — a genuinely
  // transient first-load blip self-heals on the very next poll tick, the same one the hook
  // already runs regardless — and never set once this round HAS hydrated at least once (a
  // spectator watching a live round shouldn't see an alarming banner over data it already has
  // just because one later poll happened to fail; that failure still warns-and-drops as before).
  readonly error: boolean;
  readonly state: RoundState | undefined;
  readonly games: readonly GameState[];
}

// What useWatchRound needs to talk to ONE round, read-only — deliberately narrower than
// @swng/client's SessionConfig (no deviceId/golferId/OutboxStore: a spectator authors nothing,
// so there is no outbox to persist and no HLC identity to mint). `token` here is whatever the
// bearer is (participant or spectator) — WatchPage always hands it a spectator token, but the
// hook itself has no opinion; the SERVER decides what a token may read (dispatch.ts's
// "round-read" tier), never the client.
export type CreateWatchTransport = (roundId: RoundId, token: string) => RoundTransport;

const defaultCreateWatchTransport: CreateWatchTransport = (roundId, token) => createHttpTransport({ httpUrl: config.httpUrl, wsUrl: config.wsUrl, roundId, token });

const EMPTY_GAMES: readonly GameState[] = [];

// A lean poll+WS view over ONE round's event log — NOT @swng/client's createRoundSession
// (brief: "NO session/outbox"). Reuses createHttpTransport's pull()/openSocket() (the SAME
// wire mechanics the real session uses — one transport implementation, not a hand-rolled
// second one) but never calls push(): there is nothing for a spectator to author. Polls on a
// fixed interval as the correctness path (matches architecture.md §3: pull is authoritative,
// WS is delivery sugar) and opens the socket as a latency assist; both funnel into the same
// dedup-by-opId ingest, so a message arriving twice (once via poll, once via WS) is harmless.
const POLL_MS = 4_000;

// pollMs is a second, OPTIONAL DI seam (createTransport is the first) — tests shorten it so a
// poll-driven assertion doesn't have to wait out the real 4s production cadence; every real
// call site (the exported useWatchRound below) leaves it at the default.
export const createUseWatchRound = (
  createTransport: CreateWatchTransport = defaultCreateWatchTransport,
  pollMs: number = POLL_MS,
): ((roundId: RoundId, token: string) => WatchRoundView) => {
  return function useWatchRound(roundId: RoundId, token: string): WatchRoundView {
    const [events, setEvents] = useState<readonly RoundEvent[]>([]);
    const [pulledOnce, setPulledOnce] = useState(false);
    const [pullError, setPullError] = useState(false); // papercut 14 — see WatchRoundView.error's own doc comment

    // Refs, not state: these are read-modify-write bookkeeping for the poll/socket loop, not
    // values a render needs to react to — only `events`/`pulledOnce` above drive re-renders.
    const eventsRef = useRef<readonly RoundEvent[]>([]);
    const seenOpIdsRef = useRef<Set<string>>(new Set());
    const lastSeqRef = useRef(0);

    useEffect(() => {
      let cancelled = false;
      eventsRef.current = [];
      seenOpIdsRef.current = new Set();
      lastSeqRef.current = 0;
      setEvents([]);
      setPulledOnce(false);
      setPullError(false);

      const transport = createTransport(roundId, token);

      const ingest = (incoming: readonly RoundEvent[]): void => {
        const fresh = incoming.filter((event) => !seenOpIdsRef.current.has(event.opId));
        if (fresh.length === 0 || cancelled) return;
        for (const event of fresh) seenOpIdsRef.current.add(event.opId);
        eventsRef.current = [...eventsRef.current, ...fresh];
        setEvents(eventsRef.current);
      };

      const pullOnce = async (): Promise<void> => {
        try {
          const { events: pulled, nextSeq } = await transport.pull(lastSeqRef.current);
          lastSeqRef.current = nextSeq;
          ingest(pulled);
          // A later successful pull clears any earlier error — see WatchRoundView.error's own
          // doc comment (a transient first-load blip self-heals on the very next tick).
          if (!cancelled) setPullError(false);
        } catch {
          // Network hiccup: warn-and-drop, matching @swng/client's own background-failure
          // precedent (session.ts's requestSyncInBackground) — the next poll tick (or the next
          // WS message) tries again. There is no queue to preserve here (a spectator authors
          // nothing), so there is nothing "offline" could lose. Papercut 14 (M9 hardening):
          // UNLESS this round has never hydrated at all (eventsRef still empty) — that's the
          // "still loading forever" bug this fixes, so it surfaces as an honest error instead
          // of silently retrying forever with nothing ever shown.
          if (!cancelled && eventsRef.current.length === 0) setPullError(true);
        } finally {
          if (!cancelled) setPulledOnce(true);
        }
      };

      void pullOnce();
      const interval = setInterval(() => void pullOnce(), pollMs);
      // onOpen re-pulls immediately: a real WebSocket is CONNECTING (not OPEN) for a while
      // after openSocket() returns, and an event landing in that gap reaches neither the
      // catch-up pull above (already ran) nor the socket (not open yet) until either the next
      // poll tick or this catch-up fires — same reasoning as session.ts's own onOpen handler.
      const closeSocket = transport.openSocket(
        (incoming) => ingest(incoming),
        () => {
          // No reconnect timer: the poll loop above already covers this gap on its own
          // cadence, so a dropped socket degrades to "poll-only," never "stuck."
        },
        () => void pullOnce(),
      );

      return () => {
        cancelled = true;
        clearInterval(interval);
        closeSocket();
      };
      // createTransport is captured once from createUseWatchRound's own closure (module scope
      // for the real hook, a fixed test double per test) — never a per-render value, so it's
      // correctly not a dependency here (same precedent as useRoundSession.ts's own
      // resolveSessionConfig).
    }, [roundId, token]);

    // reduceRound throws until a genesis (round-created) event exists (domain's own contract)
    // — a share link is only ever minted for an already-started round, but the very first pull
    // could still race a partial/empty log, so this guards the same way session.ts's own
    // hydrated() check does.
    const state = events.length > 0 ? reduceRound(events) : undefined;
    const games = state ? state.games.filter((gameConfig) => KNOWN_GAME_KINDS.has(gameConfig.kind)).map((gameConfig) => scoreGame(gameConfig, state)) : EMPTY_GAMES;

    return { hydrated: pulledOnce && state !== undefined, error: pullError, state, games };
  };
};

export const useWatchRound = createUseWatchRound();
