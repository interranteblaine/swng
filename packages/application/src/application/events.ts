import type {
  DomainEvent,
  PlayerJoinedEvent,
  PlayerUpdatedEvent,
  ScoreChangedEvent,
  RoundStateChangedEvent,
} from "@swng/domain";
import type { BroadcastPort } from "./types";

export async function handleDomainEvent(
  event: DomainEvent,
  broadcast: BroadcastPort
): Promise<void> {
  switch (event.type) {
    case "PlayerJoined": {
      const e = event as PlayerJoinedEvent;
      await broadcast.broadcastPlayerJoined(e.roundId, e.player);
      return;
    }

    case "PlayerUpdated": {
      const e = event as PlayerUpdatedEvent;
      await broadcast.broadcastPlayerUpdated(e.roundId, e.player);
      return;
    }

    case "ScoreChanged": {
      const e = event as ScoreChangedEvent;
      await broadcast.broadcastScoreChanged(e.roundId, e.score);
      return;
    }

    case "RoundStateChanged": {
      const e = event as RoundStateChangedEvent;
      await broadcast.broadcastRoundStateChanged(e.roundId, e.state);
      return;
    }

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
