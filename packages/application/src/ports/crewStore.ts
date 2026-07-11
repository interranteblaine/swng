import type { Crew, CrewId, GolferId } from "@swng/domain";

// A crew's persistence, mirroring CourseStore/GolferStore's revision-conditional CRUD
// contract (both port docs' precedent) — a Crew is a plain entity, not event-sourced
// (crew/crew.ts's own doc comment), so this is get/put over the whole aggregate.
//
// joinCode is store-level metadata, not a field on the domain Crew type — same split
// RoundStore keeps for a round's own join code (RoundState carries no joinCode either): the
// crew's own aggregate doesn't need to know its human-facing invite code to compute
// anything, but GetCrew's response DOES need it back on every read (unlike a round, whose
// join code is only ever handed back once, at StartRoundResponse), so unlike RoundStore's
// one-way findByJoinCode-only split, put/get here carry it both ways.
export interface CrewStore {
  // expectedRevision undefined ⇒ create (condition: item absent); n ⇒ replace revision n
  // (condition: stored revision === n). On condition failure throws the application-layer
  // error idiom (errors.ts) with code "crew-conflict". `joinCode` is written on every put,
  // not just create — it never actually changes after minting, so this is idempotent, but
  // the interface doesn't special-case "first write only" the way courseStore's
  // enteredBy/provenance fields do.
  put(crew: Crew, joinCode: string, expectedRevision: number | undefined): Promise<void>;
  get(crewId: CrewId): Promise<{ crew: Crew; joinCode: string; revision: number } | undefined>;
  // The join-code → crewId lookup (mirrors RoundStore's findByJoinCode) — minted with the
  // SAME IdGenerator.newJoinCode() machinery a round's own join code uses.
  findByJoinCode(joinCode: string): Promise<CrewId | undefined>;
  // Crews a golfer belongs to, summarized for a roster screen — not the full Crew (that's
  // GetCrew's job once a specific crew is picked).
  listByGolfer(golferId: GolferId): Promise<readonly { crewId: CrewId; name: string; memberCount: number }[]>;
}
