import { describe, expect, it } from "vitest";
import { golferId, roundId } from "@swng/domain";
import type { ParticipantClaims, TokenClaims, TokenIssuer } from "../ports/tokenIssuer.js";
import { getShareLink } from "./getShareLink.js";

// Same local-fake idiom as terminateGame.test.ts/finalizeRound.test.ts's own
// createTestTokenIssuer, PLUS determinism: issue() is keyed by the claims' own VALUE
// (JSON.stringify), so two calls with equal claims collapse onto the same already-minted
// token — mirroring hmacTokenIssuer.ts's real "same payload -> byte-identical token" contract,
// which is what getShareLink's own determinism (getShareLink.ts's doc comment) actually rests
// on: getShareLink adds no dedup logic of its own, it just calls issue() and trusts the issuer.
const createTestTokenIssuer = (): TokenIssuer => {
  const tokensByClaimsKey = new Map<string, string>();
  const claimsByToken = new Map<string, TokenClaims>();
  let counter = 0;
  return {
    issue: (claims) => {
      const key = JSON.stringify(claims);
      const existing = tokensByClaimsKey.get(key);
      if (existing) return existing;
      const token = `token-${(counter += 1)}`;
      tokensByClaimsKey.set(key, token);
      claimsByToken.set(token, claims);
      return token;
    },
    verify: (token) => claimsByToken.get(token),
  };
};

const claims: ParticipantClaims = { roundId: roundId("round-1"), golferId: golferId("ann") };

describe("getShareLink", () => {
  it("issues a spectator-scoped token for the caller's round and returns a /watch url carrying it", async () => {
    const tokens = createTestTokenIssuer();
    const shareLink = getShareLink({ tokens });

    const { url } = await shareLink(claims);
    expect(url.startsWith(`/watch/${claims.roundId}#`)).toBe(true);
    const token = url.split("#")[1]!;
    expect(tokens.verify(token)).toEqual({ scope: "spectator", roundId: claims.roundId });
  });

  it("is deterministic — the same round produces the SAME url across repeat calls", async () => {
    const tokens = createTestTokenIssuer();
    const shareLink = getShareLink({ tokens });

    const first = await shareLink(claims);
    const second = await shareLink(claims);
    expect(first).toEqual(second);
  });

  it("two different rounds get two different urls", async () => {
    const tokens = createTestTokenIssuer();
    const shareLink = getShareLink({ tokens });

    const other: ParticipantClaims = { roundId: roundId("round-2"), golferId: golferId("bo") };
    const a = await shareLink(claims);
    const b = await shareLink(other);
    expect(a.url).not.toEqual(b.url);
  });

  it("never mints a token carrying the caller's own golferId — the link is round-scoped only", async () => {
    const tokens = createTestTokenIssuer();
    const shareLink = getShareLink({ tokens });

    const { url } = await shareLink(claims);
    const token = url.split("#")[1]!;
    const verified = tokens.verify(token);
    expect(verified?.scope).toBe("spectator");
    expect(verified && "golferId" in verified).toBe(false);
  });
});
