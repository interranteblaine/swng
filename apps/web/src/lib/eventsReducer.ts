import type { RoundSnapshot, DomainEvent } from "@swng/domain";

export function reduceEvent(
  snapshot: RoundSnapshot | undefined,
  evt: DomainEvent
): RoundSnapshot | undefined {
  if (!snapshot || !evt || typeof evt !== "object") return snapshot;

  switch (evt.type) {
    case "PlayerJoined":
    case "PlayerUpdated": {
      const { player } = evt;
      if (!player || typeof player !== "object") return snapshot;

      const players = snapshot.players.slice();
      const idx = players.findIndex((p) => p.playerId === player.playerId);

      if (idx >= 0) {
        players[idx] = player;
      } else {
        players.push(player);
      }

      return { ...snapshot, players };
    }

    case "PlayerRemoved": {
      const { playerId } = evt;
      if (!playerId) return snapshot;

      return {
        ...snapshot,
        players: snapshot.players.filter((p) => p.playerId !== playerId),
      };
    }

    case "ScoreChanged": {
      const { score } = evt;
      if (!score || typeof score !== "object") return snapshot;

      const scores = snapshot.scores.slice();
      const idx = scores.findIndex(
        (s) =>
          s.playerId === score.playerId && s.holeNumber === score.holeNumber
      );

      if (idx >= 0) {
        scores[idx] = score;
      } else {
        scores.push(score);
      }

      return { ...snapshot, scores };
    }

    case "RoundStateChanged": {
      const { state } = evt;
      if (!state || typeof state !== "object") return snapshot;
      return { ...snapshot, state };
    }

    default:
      // Unhandled event types are ignored
      return snapshot;
  }
}
