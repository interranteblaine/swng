// Opaque identity minting for server-authored ids (roundId, golferId, gameId, opId) and
// human-facing join codes — one seam so a use case never reaches for crypto.randomUUID
// itself (that's the adapter's business, per conventions' AWS/Node boundary).
export interface IdGenerator {
  newId(): string;
  newJoinCode(): string;
}
