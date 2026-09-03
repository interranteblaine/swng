import { describe, expect, it } from "vitest";
import { eventsResponseSchema, getMyLiveRoundsResponseSchema, joinRoundResponseSchema, startRoundResponseSchema } from "@swng/contracts";
import { fixtureLinks } from "@swng/domain";
import { apiUrl, ensureCourse, get, loadEndpoints, mintAccountGolfer, post } from "./support/client.js";

// The 2026-09-03 ticket, replayed against the DEPLOYED stack.
//
// A golfer created a round three days ahead of the tee time and lost it before he ever played
// it: not listed under his rounds, and the join code refused him. The round was fine — live, his
// seat in the log, other players in it. What vanished was the pointer that let him FIND it,
// swept by a 36h DynamoDB TTL anchored to SEAT time.
//
// This file exists because NOTHING asserted any of this before. The unit suites could not: the
// in-memory fake's listLive strips the expiry field outright, so a test written against it
// passes whatever the TTL says. That is precisely how the bug shipped, and it is why the guard
// belongs out here, against the real API, the real DynamoDB and the real sweep configuration.
//
// The 36h expiry itself is not directly observable in a test that must finish in seconds. What
// IS observable — and is the actual invariant — is everything the golfer depends on: a round
// dated days out is listed the moment it is created, and a seated golfer can always get back in
// through the code the whole group already has.
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

describe("a round booked days ahead stays reachable (the 2026-09-03 ticket)", () => {
  const endpoints = loadEndpoints();

  it("replays the ticket end to end: booked 3 days out, listed now, and the code lets its creator back in", async () => {
    const mike = await mintAccountGolfer(endpoints.httpUrl, "presence", "Mike Presence");
    const course = await ensureCourse(endpoints.httpUrl, "Presence Links", fixtureLinks, mike);

    // Michael's exact shape: a round created NOW, played THREE DAYS FROM NOW. Under the TTL this
    // arc deletes, the creator's own pointer expired 36h after this call — a day and a half
    // before the golf, and while the round was still perfectly live.
    const playedAtMs = Date.now() + THREE_DAYS_MS;
    const created = await post(
      apiUrl(endpoints.httpUrl, "/rounds"),
      { course: { courseId: course.courseId, cardId: course.cardId }, host: { tee: fixtureLinks.teeSets[0]!.name }, playedAtMs },
      startRoundResponseSchema,
      mike.idToken,
    );

    // 1. It is in "Your rounds" — the only place a golfer learns a live round's id.
    const listed = await get(apiUrl(endpoints.httpUrl, "/me/rounds/live"), getMyLiveRoundsResponseSchema, mike.idToken);
    const mine = listed.rounds.find((round) => round.roundId === created.roundId);
    expect(mine, "a round booked 3 days out is missing from GET /me/rounds/live").toBeDefined();
    // And it is listed under the day the GOLF happens, not the day the record was made — the two
    // are three days apart here precisely so a regression to createdAt cannot pass.
    expect(mine!.playedAt).toBe(playedAtMs);

    // 2. The join code gets its own creator back in. This is the universal recovery route — the
    //    one key every golfer in a group holds — and it used to answer a still-seated golfer with
    //    a 409 reading "golfer <uuid> is already a participant in this round": a golfer told, by
    //    uuid, that they could not go where they already were, from the only door they had.
    //
    //    The reads below carry the CREATE's participant token, not the account bearer: GET
    //    /events is the round-scoped "round-read" tier, a different tier than /me/* (routes.ts).
    const before = await get(apiUrl(endpoints.httpUrl, `/rounds/${created.roundId}/events?sinceSeq=0`), eventsResponseSchema, created.token);
    const backIn = await post(
      apiUrl(endpoints.httpUrl, "/rounds/join"),
      { code: created.joinCode, tee: fixtureLinks.teeSets[0]!.name },
      joinRoundResponseSchema,
      mike.idToken,
    );

    expect(backIn.roundId).toBe(created.roundId);
    expect(backIn.golferId).toBe(mike.golferId);
    expect(backIn.joinCode).toBe(created.joinCode);

    // 3. Nothing was rewritten to achieve that. The old guard existed to stop the fold's
    //    last-write-wins silently rewriting the caller's seat; this path appends nothing at all,
    //    so there is no second participant-joined to win a fold. Asserted as a fact about the
    //    stored log — the wire, not the response — because that is the claim that matters.
    const after = await get(apiUrl(endpoints.httpUrl, `/rounds/${created.roundId}/events?sinceSeq=0`), eventsResponseSchema, created.token);
    expect(after.events.length, "re-tapping join appended an event — the seat may have been rewritten").toBe(before.events.length);
    expect(after.events.map((event) => event.opId)).toEqual(before.events.map((event) => event.opId));

    // 4. The token it handed back is real — it authorizes this round, for this golfer. A 200 that
    //    returned a token nothing accepts would satisfy every assertion above and still leave the
    //    golfer locked out, which is the failure this whole arc is about.
    const viaNewToken = await get(apiUrl(endpoints.httpUrl, `/rounds/${created.roundId}/events?sinceSeq=0`), eventsResponseSchema, backIn.token);
    expect(viaNewToken.events.map((event) => event.opId)).toEqual(before.events.map((event) => event.opId));

    // 5. Still listed afterwards — getting back in never costs a golfer the pointer that found it.
    const relisted = await get(apiUrl(endpoints.httpUrl, "/me/rounds/live"), getMyLiveRoundsResponseSchema, mike.idToken);
    expect(relisted.rounds.some((round) => round.roundId === created.roundId)).toBe(true);
  });
});
